// syncSandboxBranches against real git: a temp "host" repo and a temp
// "sandbox" clone added as the sandbox-<name> remote (what sbx --clone sets up).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realGit } from "../../../src/worker/host-sign.ts";
import { syncSandboxBranches } from "../../../src/sandbox/sbx/session-sync.ts";

let hasKeygen = true;
try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); } catch (e) {
  hasKeygen = (e as NodeJS.ErrnoException).code !== "ENOENT";
}

const NAME = "dl-session-t";
const PROTECTED = ["CLAUDE.md", ".claude/"];

describe.skipIf(!hasKeygen)("syncSandboxBranches", () => {
  let tmp: string, host: string, box: string, key: string;
  let git: ReturnType<typeof realGit>;
  const h = async (...a: string[]) => (await git(a, host)).trim();
  const b = async (...a: string[]) => (await git(a, box)).trim();
  const agent = ["-c", "user.email=agent@sandbox", "-c", "user.name=agent", "-c", "commit.gpgsign=false"];
  const boxCommit = async (file: string, body: string, msg: string) => {
    mkdirSync(dirname(join(box, file)), { recursive: true });
    writeFileSync(join(box, file), body);
    await b("add", "-A");
    await b(...agent, "commit", "-q", "-m", msg);
  };
  const run = (allowProtected = false) =>
    syncSandboxBranches({ repo: host, name: NAME, protectedPaths: PROTECTED, allowProtected, git, defaultBranch: "main" });

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "sbxsync-"));
    key = join(tmp, "k");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", key]);
    writeFileSync(join(tmp, "gitconfig"), "");
    writeFileSync(join(tmp, "allowed"), `t@example.com ${readFileSync(key + ".pub", "utf8").trim()}\n`);
    git = realGit({ ...process.env, GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  beforeEach(async () => {
    host = join(tmp, "host");
    box = join(tmp, "box");
    rmSync(host, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
    await git(["init", "-q", "-b", "main", host], tmp);
    for (const [k, v] of [
      ["user.name", "T"], ["user.email", "t@example.com"], ["gpg.format", "ssh"],
      ["user.signingkey", key], ["gpg.ssh.allowedSignersFile", join(tmp, "allowed")], ["commit.gpgsign", "false"],
    ]) await h("config", k, v);
    writeFileSync(join(host, "base"), "base\n");
    await h("add", "-A");
    await h("commit", "-q", "-m", "base");
    await git(["clone", "-q", host, box], tmp);
    await h("remote", "add", `sandbox-${NAME}`, box);
  });

  it("makes a signed local branch for each new sandbox branch, same trees, nothing pushed", async () => {
    await b("checkout", "-q", "-b", "feat/a");
    await boxCommit("src/a.ts", "a\nb\n", "one");
    await boxCommit("src/b.ts", "c\n", "two");
    const boxTree = await b("rev-parse", "HEAD^{tree}");

    const r = await run();
    expect(r).toEqual([{ branch: "feat/a", status: "synced", commits: 2, adds: 3, dels: 0, files: 2, hits: [], base: await h("rev-parse", "main") }]);
    expect(await h("rev-parse", "feat/a^{tree}")).toBe(boxTree);
    const sigs = (await h("log", "--format=%G? %ae %s", "main..feat/a")).split("\n");
    expect(sigs).toEqual(["G t@example.com two", "G t@example.com one"]);
    // Not checked out, and the host's working tree is untouched.
    expect(await h("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await h("status", "--porcelain")).toBe("");
  });

  it("does not re-sign a branch that touches a protected path, unless allowed", async () => {
    await b("checkout", "-q", "-b", "feat/p");
    await boxCommit(".claude/hooks/x.sh", "echo\n", "hook");
    const r = await run();
    expect(r[0]).toMatchObject({ branch: "feat/p", status: "protected", hits: [".claude/hooks/x.sh"] });
    await expect(h("rev-parse", "--verify", "-q", "refs/heads/feat/p")).rejects.toThrow();

    const r2 = await run(true);
    expect(r2[0]).toMatchObject({ branch: "feat/p", status: "synced", hits: [".claude/hooks/x.sh"] });
    expect(await h("log", "-1", "--format=%G?", "feat/p")).toBe("G");
  });

  it("leaves an existing local branch alone and says so", async () => {
    await h("branch", "feat/a");
    await b("checkout", "-q", "-b", "feat/a");
    await boxCommit("x", "x\n", "x");
    const r = await run();
    expect(r[0]).toMatchObject({ branch: "feat/a", status: "exists" });
    expect(r[0].detail).toMatch(/local feat\/a already exists/);
  });

  it("a second run reports an already-synced branch as synced without rewriting it", async () => {
    await b("checkout", "-q", "-b", "feat/a");
    await boxCommit("x", "x\n", "x");
    await run();
    const tip = await h("rev-parse", "feat/a");
    const r = await run();
    expect(r[0]).toMatchObject({ branch: "feat/a", status: "synced" });
    expect(await h("rev-parse", "feat/a")).toBe(tip);
  });

  it("skips branches with nothing new (main untouched in the sandbox)", async () => {
    expect(await run()).toEqual([]);
  });

  it("reports commits made on main in the sandbox, without moving the host's main", async () => {
    await boxCommit("m", "m\n", "on main");
    const before = await h("rev-parse", "main");
    const r = await run();
    expect(r[0]).toMatchObject({ branch: "main", status: "exists" });
    expect(await h("rev-parse", "main")).toBe(before);
  });

  it("refuses a branch name that isn't safe to print into a command", async () => {
    await b("checkout", "-q", "-b", "feat/$(x)");
    await boxCommit("y", "y\n", "y");
    const r = await run();
    expect(r[0]).toMatchObject({ status: "failed" });
    expect(r[0].detail).toMatch(/unsafe branch name/);
  });

  it("refuses to rewrite a merge commit", async () => {
    await b("checkout", "-q", "-b", "side");
    await boxCommit("s", "s\n", "s");
    await b("checkout", "-q", "main");
    await b("checkout", "-q", "-b", "feat/m");
    await boxCommit("t", "t\n", "t");
    await b(...agent, "merge", "-q", "--no-ff", "-m", "merge", "side");
    const r = await run();
    const m = r.find((x) => x.branch === "feat/m")!;
    expect(m.status).toBe("failed");
    expect(m.detail).toMatch(/merge commit/);
  });

  it("restores nothing and reports a failure when signing fails", async () => {
    await h("config", "user.signingkey", join(tmp, "missing"));
    await b("checkout", "-q", "-b", "feat/a");
    await boxCommit("x", "x\n", "x");
    const r = await run();
    expect(r[0]).toMatchObject({ branch: "feat/a", status: "failed" });
    expect(r[0].detail).toMatch(/signing failed/);
    await expect(h("rev-parse", "--verify", "-q", "refs/heads/feat/a")).rejects.toThrow();
  });
  // --- review fixes (case-insensitive APFS, quoting, shadowing, history) ---

  it("never overwrites main through a case variant, even when refs are packed", async () => {
    await h("pack-refs", "--all");
    const before = await h("rev-parse", "main");
    // In the sandbox (Linux) MAIN and main are different branches; here the box
    // is on the same Mac disk, so make MAIN a packed ref there without a loose file.
    await b("checkout", "-q", "-b", "evil-tmp");
    await boxCommit("evil", "evil\n", "evil on MAIN");
    const evil = await b("rev-parse", "HEAD");
    await b("checkout", "-q", "main");
    await b("branch", "-D", "evil-tmp");
    await b("pack-refs", "--all");
    // packed-refs is sorted by byte order (MAIN before main); keep it so, or git skips the entry.
    const packed = readFileSync(join(box, ".git", "packed-refs"), "utf8").split("\n").filter(Boolean);
    const [head, ...rest] = packed;
    writeFileSync(join(box, ".git", "packed-refs"), [head, ...[...rest, `${evil} refs/heads/MAIN`].sort((x, y) => (x.split(" ")[1] < y.split(" ")[1] ? -1 : 1))].join("\n") + "\n");
    expect(await b("ls-remote", "--heads", ".")).toContain("refs/heads/MAIN");
    const r = await run();
    const row = r.find((x) => x.branch.toLowerCase().includes("main"));
    expect(row?.status).toBe("failed");
    expect(row?.detail).toMatch(/differ only in case/);
    expect(r.some((x) => x.status === "synced")).toBe(false);
    expect(await h("rev-parse", "main")).toBe(before);
  });

  it("never overwrites an existing packed branch through a case variant", async () => {
    await h("branch", "feat/x");
    await h("pack-refs", "--all");
    const before = await h("rev-parse", "feat/x");
    await b("checkout", "-q", "-b", "feat/X");
    await boxCommit("y", "y\n", "y");
    const r = await run();
    expect(r[0]).toMatchObject({ branch: "feat/X", status: "exists" });
    expect(await h("rev-parse", "refs/heads/feat/x")).toBe(before);
  });

  it("catches a protected path written in another case", async () => {
    await b("checkout", "-q", "-b", "feat/c");
    await boxCommit("claude.md", "pwn\n", "lower");
    await boxCommit(".Claude/Settings.json", "{}\n", "upper");
    const r = await run();
    expect(r[0]).toMatchObject({ status: "protected" });
    expect(r[0].hits.sort()).toEqual([".Claude/Settings.json", "claude.md"]);
  });

  it("catches a protected path with non-ASCII characters (git would quote it)", async () => {
    await b("checkout", "-q", "-b", "feat/q");
    await boxCommit(".claude/hooks/\u00e9.sh", "x\n", "quoted");
    const r = await run();
    expect(r[0]).toMatchObject({ status: "protected", hits: [".claude/hooks/\u00e9.sh"] });
  });

  it("catches a protected change hidden in a commit that a later commit reverts", async () => {
    await b("checkout", "-q", "-b", "feat/h");
    await boxCommit("CLAUDE.md", "pwn\n", "change");
    await b("rm", "-q", "CLAUDE.md");
    await b(...agent, "commit", "-q", "-m", "revert");
    await boxCommit("ok.txt", "ok\n", "ok");
    const r = await run();
    expect(r[0]).toMatchObject({ status: "protected", hits: ["CLAUDE.md"] });
  });

  it("refuses a branch name that would shadow a host ref (origin/main, a tag)", async () => {
    await h("remote", "add", "origin", box);
    await h("tag", "v1");
    for (const name of ["origin/main", "v1", "refs/x", "tags/x", "x/HEAD"]) {
      await b("checkout", "-q", "-B", name, "main");
      await boxCommit(`f-${name.replace(/\//g, "_")}`, "z\n", name);
    }
    const r = await run();
    for (const name of ["origin/main", "v1", "refs/x", "tags/x", "x/HEAD"]) {
      const row = r.find((x) => x.branch === name || x.detail?.includes(JSON.stringify(name)));
      expect(row, name).toBeDefined();
      expect(row!.status, name).toBe("failed");
    }
    await expect(h("rev-parse", "--verify", "-q", "refs/heads/origin/main")).rejects.toThrow();
  });

  it("reports one bad branch (no common history) and still syncs the others", async () => {
    await b("checkout", "-q", "--orphan", "orphan");
    await boxCommit("o", "o\n", "orphan");
    await b("checkout", "-q", "-B", "feat/good", "main");
    await boxCommit("g", "g\n", "good");
    const r = await run();
    expect(r.find((x) => x.branch === "orphan")).toMatchObject({ status: "failed" });
    expect(r.find((x) => x.branch === "feat/good")).toMatchObject({ status: "synced" });
  });

  it("counts only commits the host lacks: a branch cut from an unmerged host branch syncs just its own commit", async () => {
    // The host has an unmerged branch that touches a protected file.
    await h("checkout", "-q", "-b", "feat/host");
    writeFileSync(join(host, "CLAUDE.md"), "host rules\n");
    await h("add", "-A");
    await h("commit", "-q", "-m", "host change to CLAUDE.md");
    const hostTip = await h("rev-parse", "HEAD");
    await h("checkout", "-q", "main");
    // The sandbox branches from it and adds one ordinary commit.
    await b("fetch", "-q", "origin", "feat/host:feat/host");
    await b("checkout", "-q", "-b", "smoke/test", "feat/host");
    await boxCommit("SMOKE.md", "smoke\n", "smoke");
    const r = await run();
    expect(r.find((x) => x.branch === "feat/host")).toBeUndefined(); // nothing new there
    expect(r.find((x) => x.branch === "smoke/test")).toEqual({ branch: "smoke/test", status: "synced", commits: 1, adds: 1, dels: 0, files: 1, hits: [], base: hostTip });
    // Re-signed on top of the host's own commit, which is untouched.
    expect(await h("rev-parse", "smoke/test~1")).toBe(hostTip);
    expect(await h("log", "-1", "--format=%G?", "smoke/test")).toBe("G");
  });
});
