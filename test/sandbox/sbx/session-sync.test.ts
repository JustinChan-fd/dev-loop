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
const PROTECTED = ["CLAUDE.md", ".claude/hooks/"];

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
    expect(r).toEqual([{ branch: "feat/a", status: "synced", commits: 2, adds: 3, dels: 0, files: 2, hits: [] }]);
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
});
