import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnClaudeRun,
  childEnv,
  killedTimeoutVerdict,
  POST_KILL_GRACE_MS,
  KILL_GRACE_MS,
  killActiveChild,
  stopSpawning,
  _resetStoppingForTests,
  ALLOWED_TERMINAL_REASONS,
  TEARDOWN_GRACE_MS,
  PREPARE_TIMEOUT_MS,
  INSPECT_TIMEOUT_MS,
  settingsJson,
} from "../../src/core/spawn-claude.ts";
import type { SpawnClaudeOpts, SpawnFn, SpawnClaudeDeps } from "../../src/core/spawn-claude.ts";
import { parseVerdict } from "../../src/core/verdict.ts";
import { ALLOWED_TOOLS as DEV_ALLOWED_TOOLS } from "../../src/roles/dev/tools.ts";
import { ALLOWED_TOOLS as RESEARCH_ALLOWED_TOOLS } from "../../src/roles/research/tools.ts";
import { noneAdapter } from "../../src/sandbox/none.ts";
import type { SandboxAdapter, SandboxReport, WrappedSpawn } from "../../src/sandbox/types.ts";

/** A fake ChildProcess: stdout/stderr streams, emits error/close, records kill signals. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  /**
   * When set, the child "dies" on this signal (emits close). Otherwise it
   * ignores kills. With `exitOnlyOnKill`, SIGKILL emits 'exit' but never
   * 'close' -- a grandchild still holding the stdio pipes.
   */
  constructor(
    private readonly diesOn: string | null = null,
    private readonly exitOnlyOnKill = false,
  ) {
    super();
  }
  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" && this.exitOnlyOnKill) {
      setImmediate(() => this.emit("exit", null, signal));
    } else if (signal === this.diesOn || signal === "SIGKILL") {
      setImmediate(() => this.emit("close", null, signal));
    }
    return true;
  }
  /** Write stdout, then exit with `code`. */
  finish(stdout: string, code = 0): void {
    this.stdout.end(stdout);
    this.stderr.end();
    setImmediate(() => this.emit("close", code, null));
  }
}

/** Manual clock: injected setTimeout/clearTimeout that fire only on advance(). */
function makeFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: ((fn: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    }) as unknown as SpawnClaudeDeps["setTimeout"],
    clearTimeout: ((id: number) => {
      pending.delete(id);
    }) as unknown as SpawnClaudeDeps["clearTimeout"],
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

// killActiveChild/stopSpawning set a module-level "stopping" flag; never let it leak between tests.
afterEach(() => {
  _resetStoppingForTests();
});

describe("spawnClaudeRun", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-claude-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeOpts(overrides: Partial<SpawnClaudeOpts> = {}): SpawnClaudeOpts {
    return {
      prompt: "/ticket-to-pr TARS-1",
      model: "sonnet",
      allowedTools: "Bash,Read",
      addDir: null,
      timeoutMin: 75,
      maxBudgetUsd: 20,
      stream: false,
      ticketKey: "TARS-1",
      rawUsagePath: join(dir, "raw-usage", "TARS-1-x.json"),
      env: { PATH: "/usr/bin" },
      ...overrides,
    };
  }

  function quietDeps(extra: Partial<SpawnClaudeDeps> = {}): SpawnClaudeDeps {
    return { log: () => {}, logError: () => {}, ...extra };
  }

  it("reports a spawn error (child 'error' event) through spawnError and never throws", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => child.emit("error", new Error("spawn claude ENOENT")));
      return child as never;
    };

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn }));

    expect(result.spawnError).toMatch(/ENOENT/);
    expect(result.killedTimeout).toBe(false);
    expect(result.usage).toEqual({ costUsd: 0, tokens: { in: 0, out: 0 } });
  });

  it("reports a synchronous spawn() throw through spawnError and never throws", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("EAGAIN");
    };

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn }));

    expect(result.spawnError).toMatch(/EAGAIN/);
    expect(result.killedTimeout).toBe(false);
  });

  it("a nonzero exit with stdout (e.g. the --max-budget-usd cap) still persists raw usage and returns its cost, alongside spawnError", async () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_max_budget_usd",
      total_cost_usd: 20.04,
      usage: { input_tokens: 900, output_tokens: 80 },
    });
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish(stdout, 1);
      return child as never;
    };
    const opts = makeOpts();

    const result = await spawnClaudeRun(opts, quietDeps({ spawn }));

    expect(result.spawnError).toMatch(/exited with code 1/);
    expect(result.usage.costUsd).toBe(20.04);
    expect(result.usage.tokens.out).toBe(80);
    expect(JSON.parse(await readFile(opts.rawUsagePath, "utf8")).total_cost_usd).toBe(20.04);
  });

  it("a nonzero exit with empty stdout writes no raw usage and returns zero usage", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish("", 1);
      return child as never;
    };
    const opts = makeOpts();

    const result = await spawnClaudeRun(opts, quietDeps({ spawn }));

    expect(result.spawnError).toMatch(/exited with code 1/);
    expect(result.usage).toEqual({ costUsd: 0, tokens: { in: 0, out: 0 } });
    await expect(stat(opts.rawUsagePath)).rejects.toThrow();
  });

  it("reports a nonzero exit through spawnError", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish("boom", 1);
      return child as never;
    };

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn }));

    expect(result.spawnError).toMatch(/exited with code 1/);
  });

  it("writes raw stdout, redacted, to rawUsagePath before parsing it, and extracts usage", async () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      terminal_reason: "completed",
      total_cost_usd: 1.5,
      usage: { input_tokens: 10, output_tokens: 3 },
      result: "found API_TOKEN=abcdefghijklmnop1234 in .env",
    });
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish(stdout);
      return child as never;
    };
    const opts = makeOpts();

    const result = await spawnClaudeRun(opts, quietDeps({ spawn }));

    const written = await readFile(opts.rawUsagePath, "utf8");
    expect(written).not.toContain("abcdefghijklmnop1234");
    expect(written).toContain("total_cost_usd");
    expect(result.usage.costUsd).toBe(1.5);
    expect(result.usage.tokens.out).toBe(3);
    expect(result.spawnError).toBeUndefined();
  });

  it("still writes raw stdout when it is not valid JSON (parse failure loses nothing)", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish("not json at all");
      return child as never;
    };
    const opts = makeOpts();

    const result = await spawnClaudeRun(opts, quietDeps({ spawn }));

    expect(await readFile(opts.rawUsagePath, "utf8")).toBe("not json at all");
    expect(result.usage.costUsd).toBe(0);
  });

  it("always passes --max-budget-usd <maxBudgetUsd>", async () => {
    let seenArgs: string[] = [];
    const child = new FakeChild();
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      child.finish("{}");
      return child as never;
    };

    await spawnClaudeRun(makeOpts({ maxBudgetUsd: 50 }), quietDeps({ spawn }));

    const i = seenArgs.indexOf("--max-budget-usd");
    expect(i).toBeGreaterThan(-1);
    expect(seenArgs[i + 1]).toBe("50");
  });

  it("passes prompt, model, allowedTools and addDir, and json output when not streaming", async () => {
    let seen: { cmd: string; args: string[] } = { cmd: "", args: [] };
    const child = new FakeChild();
    const spawn: SpawnFn = (cmd, args) => {
      seen = { cmd, args };
      child.finish("{}");
      return child as never;
    };

    await spawnClaudeRun(makeOpts({ addDir: "/abs/target" }), quietDeps({ spawn }));

    expect(seen.cmd).toBe("claude");
    expect(seen.args.slice(0, 2)).toEqual(["-p", "/ticket-to-pr TARS-1"]);
    expect(seen.args).toEqual(expect.arrayContaining(["--model", "sonnet", "--allowedTools", "Bash,Read"]));
    expect(seen.args[seen.args.indexOf("--add-dir") + 1]).toBe("/abs/target");
    expect(seen.args[seen.args.indexOf("--output-format") + 1]).toBe("json");
  });

  it("streaming: returns the result line as stdout", async () => {
    let seenArgs: string[] = [];
    const child = new FakeChild();
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      const lines = [
        JSON.stringify({ type: "system" }),
        JSON.stringify({ type: "result", total_cost_usd: 2 }),
        "",
      ].join("\n");
      child.finish(lines);
      return child as never;
    };

    const result = await spawnClaudeRun(makeOpts({ stream: true }), quietDeps({ spawn }));

    expect(seenArgs[seenArgs.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(seenArgs).toContain("--verbose");
    expect(JSON.parse(result.stdout).type).toBe("result");
    expect(result.usage.costUsd).toBe(2);
  });

  it("kills a child that never exits: SIGTERM at timeoutMin, SIGKILL 30 s later, killedTimeout: true", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild(null); // ignores SIGTERM
    const spawn: SpawnFn = () => child as never;

    const pending = spawnClaudeRun(makeOpts({ timeoutMin: 2 }), quietDeps({ spawn, ...timers }));
    await flush();

    timers.advance(2 * 60_000 - 1);
    expect(child.signals).toEqual([]);
    timers.advance(1);
    expect(child.signals).toEqual(["SIGTERM"]);
    timers.advance(30_000 - 1);
    expect(child.signals).toEqual(["SIGTERM"]);
    timers.advance(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    const result = await pending;
    expect(result.killedTimeout).toBe(true);
    expect(result.spawnError).toBeUndefined();
    expect(timers.pendingCount()).toBe(0);
  });

  it("settles after SIGKILL on 'exit' even when 'close' never comes (a grandchild holds the pipes)", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild(null, true);
    const spawn: SpawnFn = () => child as never;

    const pending = spawnClaudeRun(makeOpts({ timeoutMin: 1 }), quietDeps({ spawn, ...timers }));
    await flush();
    timers.advance(60_000);
    timers.advance(30_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    const result = await pending;
    expect(result.killedTimeout).toBe(true);
    expect(result.spawnError).toBeUndefined();
  });

  it("settles after SIGKILL even if neither 'exit' nor 'close' ever comes, after a short post-kill grace", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild(null, true);
    child.kill = (signal: string) => {
      child.signals.push(signal); // never emits anything
      return true;
    };
    const spawn: SpawnFn = () => child as never;
    let settled = false;

    const pending = spawnClaudeRun(makeOpts({ timeoutMin: 1 }), quietDeps({ spawn, ...timers })).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    timers.advance(60_000);
    timers.advance(30_000);
    await flush();
    expect(settled).toBe(false);
    timers.advance(POST_KILL_GRACE_MS);

    const result = await pending;
    expect(result.killedTimeout).toBe(true);
    expect(timers.pendingCount()).toBe(0);
  });

  it("passes --settings with claudeMdExcludes when excludeClaudeMd is given, and none otherwise", async () => {
    const seen: string[][] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seen.push(args);
      const child = new FakeChild();
      child.finish("{}");
      return child as never;
    };

    await spawnClaudeRun(makeOpts({ excludeClaudeMd: ["/abs/repo/CLAUDE.md"] }), quietDeps({ spawn }));
    await spawnClaudeRun(makeOpts(), quietDeps({ spawn }));

    const withExcl = seen[0];
    expect(JSON.parse(withExcl[withExcl.indexOf("--settings") + 1])).toEqual({
      claudeMdExcludes: ["/abs/repo/CLAUDE.md"],
    });
    expect(seen[1]).not.toContain("--settings");
  });

  it("denyEditsUnder: --settings permissions.deny for Edit/Write/NotebookEdit under each dir (//abs/** form), with claudeMdExcludes", async () => {
    const seen: string[][] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seen.push(args);
      const child = new FakeChild();
      child.finish("{}");
      return child as never;
    };

    await spawnClaudeRun(
      makeOpts({ excludeClaudeMd: ["/abs/repo/CLAUDE.md"], denyEditsUnder: ["/abs/target"] }),
      quietDeps({ spawn }),
    );
    await spawnClaudeRun(makeOpts({ denyEditsUnder: ["/abs/target"] }), quietDeps({ spawn }));
    await spawnClaudeRun(makeOpts({ denyEditsUnder: [] }), quietDeps({ spawn }));

    const deny = ["Edit(//abs/target/**)", "Write(//abs/target/**)", "NotebookEdit(//abs/target/**)"];
    expect(JSON.parse(seen[0][seen[0].indexOf("--settings") + 1])).toEqual({
      claudeMdExcludes: ["/abs/repo/CLAUDE.md"],
      permissions: { deny },
    });
    expect(JSON.parse(seen[1][seen[1].indexOf("--settings") + 1])).toEqual({ permissions: { deny } });
    expect(seen[2]).not.toContain("--settings");
    expect(seen[0].filter((a) => a === "--settings")).toHaveLength(1);
  });

  it("denyReads: Read(//abs/file) rules in the same permissions.deny list as denyEditsUnder", () => {
    expect(JSON.parse(settingsJson({ denyReads: ["/abs/t/.envrc"] })!)).toEqual({ permissions: { deny: ["Read(//abs/t/.envrc)"] } });
    expect(JSON.parse(settingsJson({ denyEditsUnder: ["/abs/t"], denyReads: ["/abs/t/.env"] })!)).toEqual({
      permissions: { deny: ["Edit(//abs/t/**)", "Write(//abs/t/**)", "NotebookEdit(//abs/t/**)", "Read(//abs/t/.env)"] },
    });
    expect(settingsJson({ denyReads: [] })).toBeNull();
  });

  it("denyTools: tool rules appended to the same permissions.deny list (eval fixtures)", () => {
    expect(JSON.parse(settingsJson({ denyTools: ["mcp__atlassian", "Bash(gh:*)", "WebFetch"] })!)).toEqual({
      permissions: { deny: ["mcp__atlassian", "Bash(gh:*)", "WebFetch"] },
    });
    expect(JSON.parse(settingsJson({ denyReads: ["/abs/.env"], denyTools: ["WebFetch"] })!)).toEqual({
      permissions: { deny: ["Read(//abs/.env)", "WebFetch"] },
    });
    expect(settingsJson({ denyTools: [] })).toBeNull();
  });

  it("denyTools rejects anything but a tool name or Tool(prefix:*)", () => {
    for (const bad of ["", "Bash(rm -rf /)", "Read(//x)", "a b", "Bash(gh:*) ", 'x"y']) {
      expect(() => settingsJson({ denyTools: [bad] })).toThrow(/denyTools/);
    }
  });

  it("denyReads rejects a relative path or a glob character", () => {
    for (const bad of ["rel/.envrc", "/abs/*", "/abs/(x)"]) expect(() => settingsJson({ denyReads: [bad] })).toThrow(/denyReads/);
  });

  it("denyEditsUnder rejects a relative path or a glob character (it becomes a permission rule)", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("must not spawn");
    };
    for (const bad of ["rel/dir", "/abs/*", "/abs/(x)", "/abs/[x]"]) {
      const r = await spawnClaudeRun(makeOpts({ denyEditsUnder: [bad] }), quietDeps({ spawn }));
      expect(r.spawnError).toMatch(/denyEditsUnder/);
    }
  });

  it("uses opts.logPrefix for its log lines when given", async () => {
    const lines: string[] = [];
    const spawn: SpawnFn = () => {
      const child = new FakeChild();
      child.finish("", 1);
      return child as never;
    };
    await spawnClaudeRun(makeOpts({ logPrefix: "ticket-refine" }), { logError: (m) => lines.push(m), log: () => {}, spawn });
    expect(lines.some((l) => l.startsWith("[ticket-refine] TARS-1: spawn failed"))).toBe(true);
  });

  it("passes --append-system-prompt <text> when appendSystemPrompt is given, and none otherwise", async () => {
    const seen: string[][] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seen.push(args);
      const child = new FakeChild();
      child.finish("{}");
      return child as never;
    };

    await spawnClaudeRun(makeOpts({ appendSystemPrompt: "# stance\nbe skeptical" }), quietDeps({ spawn }));
    await spawnClaudeRun(makeOpts({ appendSystemPrompt: "" }), quietDeps({ spawn }));
    await spawnClaudeRun(makeOpts(), quietDeps({ spawn }));

    expect(seen[0][seen[0].indexOf("--append-system-prompt") + 1]).toBe("# stance\nbe skeptical");
    expect(seen[1]).not.toContain("--append-system-prompt");
    expect(seen[2]).not.toContain("--append-system-prompt");
  });

  it("spawns in opts.cwd when given", async () => {
    const cwds: unknown[] = [];
    const spawn: SpawnFn = (_cmd, _args, options) => {
      cwds.push(options.cwd);
      const child = new FakeChild();
      child.finish("{}");
      return child as never;
    };

    await spawnClaudeRun(makeOpts({ cwd: "/abs/repo-root" }), quietDeps({ spawn }));
    expect(cwds).toEqual(["/abs/repo-root"]);
  });

  it("does not send SIGKILL when the child exits on SIGTERM", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild("SIGTERM");
    const spawn: SpawnFn = () => child as never;

    const pending = spawnClaudeRun(makeOpts({ timeoutMin: 1 }), quietDeps({ spawn, ...timers }));
    await flush();
    timers.advance(60_000);
    const result = await pending;
    timers.advance(30_000);

    expect(child.signals).toEqual(["SIGTERM"]);
    expect(result.killedTimeout).toBe(true);
  });

  it("clears its timers when the child exits normally", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish("{}");
      return child as never;
    };

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn, ...timers }));

    expect(result.killedTimeout).toBe(false);
    expect(timers.pendingCount()).toBe(0);
  });

  it("spawns the child with childEnv(env): no JIRA_API_TOKEN/JIRA_EMAIL/JIRA_BASE_URL", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const child = new FakeChild();
    const spawn: SpawnFn = (_cmd, _args, options) => {
      seenEnv = options.env;
      child.finish("{}");
      return child as never;
    };
    const env = {
      PATH: "/usr/bin",
      JIRA_API_TOKEN: "t",
      JIRA_EMAIL: "e",
      JIRA_BASE_URL: "u",
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "4500000",
    };

    await spawnClaudeRun(makeOpts({ env }), quietDeps({ spawn }));

    expect(seenEnv).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "4500000" });
  });

  it("records started/ended as ISO timestamps from the injected clock", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish("{}");
      return child as never;
    };
    const times = [new Date("2026-11-10T10:00:00Z"), new Date("2026-11-10T10:05:00Z")];
    const now = () => times.shift() ?? new Date("2026-11-10T11:00:00Z");

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn, now }));

    expect(result.started).toBe("2026-11-10T10:00:00.000Z");
    expect(result.ended).toBe("2026-11-10T10:05:00.000Z");
  });
});

describe("killActiveChild (final review I5: a signal stops the running claude -p)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-claude-kill-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const opts = (): SpawnClaudeOpts => ({
    prompt: "/ticket-to-pr TARS-1",
    model: "sonnet",
    allowedTools: "Bash",
    addDir: null,
    timeoutMin: 75,
    maxBudgetUsd: 20,
    stream: false,
    ticketKey: "TARS-1",
    rawUsagePath: join(dir, "raw.json"),
    env: {},
  });
  const quiet = { log: () => {}, logError: () => {} };

  it("is a no-op ('none') when no child is running", async () => {
    const timers = makeFakeTimers();
    expect(await killActiveChild(timers)).toBe("none");
    expect(timers.pendingCount()).toBe(0);
  });

  it("SIGTERMs the running child and resolves 'exited' when it exits, with no SIGKILL", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild("SIGTERM");
    const run = spawnClaudeRun(opts(), { ...quiet, spawn: () => child as never, ...timers });
    await flush();

    const killed = killActiveChild(timers);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(await killed).toBe("exited");
    await run;
    timers.advance(KILL_GRACE_MS);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("SIGKILLs a child still running KILL_GRACE_MS after the SIGTERM, then resolves 'killed'", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild(null); // ignores SIGTERM
    const run = spawnClaudeRun(opts(), { ...quiet, spawn: () => child as never, ...timers });
    await flush();

    let done: string | null = null;
    const killed = killActiveChild(timers).then((r) => (done = r));
    expect(child.signals).toEqual(["SIGTERM"]);
    timers.advance(KILL_GRACE_MS - 1);
    await flush();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(done).toBeNull();
    timers.advance(1);
    await flush();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await killed).toBe("killed");
    await run;
  });

  it("forgets the child once its run has ended", async () => {
    const child = new FakeChild();
    await spawnClaudeRun(opts(), {
      ...quiet,
      spawn: () => {
        child.finish("{}");
        return child as never;
      },
    });
    expect(await killActiveChild(makeFakeTimers())).toBe("none");
    expect(child.signals).toEqual([]);
  });
});

describe("stopping (post-merge fix 3: no spawn once a signal is received)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-claude-stop-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const opts = (): SpawnClaudeOpts => ({
    prompt: "/ticket-to-pr TARS-1",
    model: "sonnet",
    allowedTools: "Bash",
    addDir: null,
    timeoutMin: 75,
    maxBudgetUsd: 20,
    stream: false,
    ticketKey: "TARS-1",
    rawUsagePath: join(dir, "raw.json"),
    env: {},
  });
  const quiet = { log: () => {}, logError: () => {} };

  it("after stopSpawning(), a run never calls spawn and returns a 'stopping' spawnError", async () => {
    let spawned = 0;
    const spawn: SpawnFn = () => {
      spawned++;
      const child = new FakeChild();
      child.finish("{}");
      return child as never;
    };
    stopSpawning();
    stopSpawning(); // idempotent

    const result = await spawnClaudeRun(opts(), { ...quiet, spawn });

    expect(spawned).toBe(0);
    expect(result.spawnError).toContain("stopping");
    expect(result.usage).toEqual({ costUsd: 0, tokens: { in: 0, out: 0 } });
  });

  it("after killActiveChild() with no child running, a run never calls spawn", async () => {
    let spawned = 0;
    const spawn: SpawnFn = () => {
      spawned++;
      const child = new FakeChild();
      child.finish("{}");
      return child as never;
    };
    expect(await killActiveChild(makeFakeTimers())).toBe("none");

    const result = await spawnClaudeRun(opts(), { ...quiet, spawn });

    expect(spawned).toBe(0);
    expect(result.spawnError).toContain("stopping");
  });

  it("_resetStoppingForTests() lets runs spawn again", async () => {
    let spawned = 0;
    const spawn: SpawnFn = () => {
      spawned++;
      const child = new FakeChild();
      child.finish('{"type":"result","is_error":false,"terminal_reason":"completed"}');
      return child as never;
    };
    stopSpawning();
    _resetStoppingForTests();

    const result = await spawnClaudeRun(opts(), { ...quiet, spawn });

    expect(spawned).toBe(1);
    expect(result.spawnError).toBeUndefined();
  });
});

describe("childEnv", () => {
  it("strips JIRA_API_TOKEN, JIRA_EMAIL and JIRA_BASE_URL, keeps everything else, and does not mutate the parent", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      JIRA_API_TOKEN: "secret",
      JIRA_EMAIL: "me@example.com",
      JIRA_BASE_URL: "https://x.atlassian.net",
      JIRA_ASSIGNEE_ACCOUNT_ID: "acct-1",
    };

    const env = childEnv(parent);

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", JIRA_ASSIGNEE_ACCOUNT_ID: "acct-1" });
    expect(parent.JIRA_API_TOKEN).toBe("secret");
  });
});

describe("killedTimeoutVerdict", () => {
  it("is outcome killed / failure_category killed_ceiling, and valid under both verdict profiles", () => {
    const verdict = killedTimeoutVerdict(75);
    expect(verdict.outcome).toBe("killed");
    expect(verdict.failure_category).toBe("killed_ceiling");
    expect(verdict.detail).toMatch(/75/);

    const raw = JSON.stringify(verdict);
    expect(parseVerdict(raw, "refine").outcome).toBe("killed");
    expect(parseVerdict(raw, "executor").outcome).toBe("killed");
  });
});

// Byte-for-byte. Each role's v1 names, with the renamed /v2/mcp names next to
// their v1 originals and listJiraIssueComments added: the host connector may be
// either server version (TARS-1640). Never unioned across roles.
describe("role ALLOWED_TOOLS", () => {
  it("dev: its v1 tools plus the two follow-up-ticket writes (Ruling 30), and the v2 comment read", () => {
    expect(DEV_ALLOWED_TOOLS).toBe(
      "mcp__atlassian__getAccessibleAtlassianResources,mcp__atlassian__getJiraIssue,mcp__atlassian__createJiraIssue,mcp__atlassian__createIssueLink,mcp__atlassian__listJiraIssueComments,Bash,Read,Grep,Glob",
    );
  });

  it("research: its v1 tools and their v2 names", () => {
    expect(RESEARCH_ALLOWED_TOOLS).toBe(
      "mcp__atlassian__getAccessibleAtlassianResources,mcp__atlassian__getJiraIssue,mcp__atlassian__searchJiraIssuesUsingJql,mcp__atlassian__addCommentToJiraIssue,mcp__atlassian__addOrEditJiraIssueComment,mcp__atlassian__editJiraIssue,mcp__atlassian__search,mcp__atlassian__getConfluencePage,mcp__atlassian__getConfluenceContent,mcp__atlassian__searchConfluenceUsingCql,mcp__atlassian__searchConfluence,mcp__atlassian__listJiraIssueComments,Bash,Read,Grep,Glob",
    );
  });
});

describe("result-error detection", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-claude-resulterr-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeOpts(overrides: Partial<SpawnClaudeOpts> = {}): SpawnClaudeOpts {
    return {
      prompt: "/ticket-to-pr TARS-1",
      model: "sonnet",
      allowedTools: "Bash,Read",
      addDir: null,
      timeoutMin: 75,
      maxBudgetUsd: 20,
      stream: false,
      ticketKey: "TARS-1",
      rawUsagePath: join(dir, "raw-usage", "TARS-1-x.json"),
      env: { PATH: "/usr/bin" },
      ...overrides,
    };
  }

  async function run(stdout: string, code = 0, overrides: Partial<SpawnClaudeOpts> = {}) {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish(stdout, code);
      return child as never;
    };
    return spawnClaudeRun(makeOpts(overrides), { log: () => {}, logError: () => {}, spawn });
  }

  it("allows only the completed terminal_reason", () => {
    expect(ALLOWED_TERMINAL_REASONS).toEqual(["completed"]);
  });

  it("a completed result passes and is recorded as resultError", async () => {
    const result = await run(
      JSON.stringify({ type: "result", is_error: false, terminal_reason: "completed", total_cost_usd: 0.5 }),
    );
    expect(result.spawnError).toBeUndefined();
    expect(result.resultError).toEqual({ is_error: false, terminal_reason: "completed" });
  });

  it("a terminal_reason outside the allowed set is a spawnError, and the cost is kept", async () => {
    const result = await run(
      JSON.stringify({ type: "result", is_error: false, terminal_reason: "api_error", total_cost_usd: 0.2 }),
    );
    expect(result.spawnError).toBe("claude reported a failed result (is_error=false, terminal_reason=api_error)");
    expect(result.usage.costUsd).toBe(0.2);
  });

  it("an unknown terminal_reason logs one prominent error line naming ALLOWED_TERMINAL_REASONS; still a spawnError", async () => {
    const errors: string[] = [];
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish(JSON.stringify({ type: "result", is_error: false, terminal_reason: "brand_new", total_cost_usd: 0.1 }), 0);
      return child as never;
    };
    const result = await spawnClaudeRun(makeOpts(), { log: () => {}, logError: (m) => errors.push(m), spawn });
    expect(result.spawnError).toBe("claude reported a failed result (is_error=false, terminal_reason=brand_new)");
    const unknown = errors.filter((m) => m.includes('unknown terminal_reason "brand_new"'));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("ALLOWED_TERMINAL_REASONS (src/core/spawn-claude.ts)");
  });

  it("is_error alone (a known terminal_reason) logs no unknown terminal_reason line", async () => {
    const errors: string[] = [];
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish(JSON.stringify({ type: "result", is_error: true, terminal_reason: "completed" }), 0);
      return child as never;
    };
    const result = await spawnClaudeRun(makeOpts(), { log: () => {}, logError: (m) => errors.push(m), spawn });
    expect(result.spawnError).toBeDefined();
    expect(errors.some((m) => m.includes("unknown terminal_reason"))).toBe(false);
  });

  it("is_error: true is a spawnError", async () => {
    const result = await run(JSON.stringify({ type: "result", is_error: true, terminal_reason: "completed" }));
    expect(result.spawnError).toContain("is_error=true");
  });

  it("a result with no terminal_reason and is_error: false passes", async () => {
    const result = await run(JSON.stringify({ type: "result", is_error: false }));
    expect(result.spawnError).toBeUndefined();
  });

  it("non-JSON stdout with a 0 exit is a spawnError", async () => {
    const result = await run("not json at all");
    expect(result.spawnError).toBe("claude exited 0 without a result");
  });

  it("streaming: a final api_error result gets the same spawnError", async () => {
    const lines = [
      JSON.stringify({ type: "system" }),
      JSON.stringify({ type: "result", is_error: false, terminal_reason: "api_error" }),
      "",
    ].join("\n");
    const result = await run(lines, 0, { stream: true });
    expect(result.spawnError).toBe("claude reported a failed result (is_error=false, terminal_reason=api_error)");
  });

  it("a nonzero exit keeps its own spawnError", async () => {
    const result = await run(JSON.stringify({ type: "result", is_error: true, terminal_reason: "api_error" }), 1);
    expect(result.spawnError).toMatch(/^claude exited with code 1/);
  });
});

describe("sandbox adapter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-claude-sandbox-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const RESULT = JSON.stringify({ type: "result", is_error: false, terminal_reason: "completed", total_cost_usd: 1 });
  const quiet = { log: () => {}, logError: () => {} };
  const run = { instanceName: "dev-loop-TARS-1", mounts: ["/abs/target"], config: undefined };

  function makeOpts(overrides: Partial<SpawnClaudeOpts> = {}): SpawnClaudeOpts {
    return {
      prompt: "/ticket-to-pr TARS-1",
      model: "sonnet",
      allowedTools: "Bash,Read",
      addDir: null,
      timeoutMin: 75,
      maxBudgetUsd: 20,
      stream: false,
      ticketKey: "TARS-1",
      rawUsagePath: join(dir, "raw-usage", "TARS-1-x.json"),
      env: { PATH: "/usr/bin" },
      cwd: "/abs/target",
      ...overrides,
    };
  }

  /** A fake adapter that records every call into `calls` (shared with the fake spawn). */
  function recordingAdapter(
    o: {
      report?: SandboxReport;
      prepareThrows?: boolean;
      prepareMessage?: string;
      inspectThrows?: boolean;
      teardownGate?: Promise<void>;
      wrap?: (cmd: string, args: string[], opts: WrappedSpawn["opts"]) => WrappedSpawn;
      onPrepare?: () => void;
    } = {},
  ) {
    const calls: string[] = [];
    const adapter: SandboxAdapter = {
      name: "fake",
      validateConfig: (raw) => raw,
      preflight: async () => {},
      cleanupOrphans: async () => {},
      prepare: async (spec) => {
        calls.push("prepare");
        o.onPrepare?.();
        if (o.prepareThrows) throw new Error(o.prepareMessage ?? "daemon not running");
        return { adapter: "fake", instanceName: spec.instanceName };
      },
      wrap: (_h, cmd, args, opts) => {
        calls.push("wrap");
        return o.wrap ? o.wrap(cmd, args, opts) : { cmd, args, opts };
      },
      inspect: async (_h, exitCode) => {
        calls.push(`inspect:${exitCode}`);
        if (o.inspectThrows) throw new Error("inspect blew up");
        return o.report ?? { denied: [] };
      },
      teardown: async () => {
        calls.push("teardown");
        await o.teardownGate;
      },
    };
    return { adapter, calls };
  }

  type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };
  function finishingSpawn(calls: string[], stdout = RESULT, code = 0) {
    const seen: SpawnCall[] = [];
    const spawn: SpawnFn = (cmd, args, opts) => {
      calls.push("spawn");
      seen.push({ cmd, args, opts: opts as Record<string, unknown> });
      const child = new FakeChild();
      child.finish(stdout, code);
      return child as never;
    };
    return { spawn, seen };
  }

  it("with no sandbox option, the spawn call is unchanged", async () => {
    const { spawn, seen } = finishingSpawn([]);
    const result = await spawnClaudeRun(makeOpts(), { ...quiet, spawn });

    expect(seen).toHaveLength(1);
    expect(seen[0].cmd).toBe("claude");
    expect(seen[0].args).toEqual([
      "-p", "/ticket-to-pr TARS-1", "--model", "sonnet", "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash,Read", "--max-budget-usd", "20", "--output-format", "json",
    ]);
    expect(Object.keys(seen[0].opts)).toEqual(["stdio", "env", "cwd"]);
    expect(seen[0].opts).toEqual({ stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin" }, cwd: "/abs/target" });
    expect(result.sandbox).toBeUndefined();
    expect("sandbox" in result).toBe(false);
  });

  it("with the none adapter, deps.spawn gets exactly the same cmd/args/opts as without a sandbox", async () => {
    const without = finishingSpawn([]);
    await spawnClaudeRun(makeOpts(), { ...quiet, spawn: without.spawn });
    const withNone = finishingSpawn([]);
    const result = await spawnClaudeRun(makeOpts({ sandbox: { adapter: noneAdapter, run } }), {
      ...quiet,
      spawn: withNone.spawn,
    });

    expect(withNone.seen).toEqual(without.seen);
    expect(Object.keys(withNone.seen[0].opts)).toEqual(Object.keys(without.seen[0].opts));
    expect(result.spawnError).toBeUndefined();
    expect(result.sandbox).toMatchObject({ adapter: "none", instance: "dev-loop-TARS-1", report: { denied: [] } });
  });

  it("calls prepare, wrap, spawn, inspect, teardown in order on success", async () => {
    const { adapter, calls } = recordingAdapter();
    const { spawn } = finishingSpawn(calls);
    const result = await spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), { ...quiet, spawn });

    expect(calls).toEqual(["prepare", "wrap", "spawn", "inspect:0", "teardown"]);
    expect(result.spawnError).toBeUndefined();
  });

  it("spawns the wrapped command, not claude", async () => {
    const { adapter, calls } = recordingAdapter({
      wrap: (cmd, args, opts) => ({ cmd: "wrapper", args: ["run", "--", cmd, ...args], opts }),
    });
    const { spawn, seen } = finishingSpawn(calls);
    await spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), { ...quiet, spawn });

    expect(seen[0].cmd).toBe("wrapper");
    expect(seen[0].args.slice(0, 5)).toEqual(["run", "--", "claude", "-p", "/ticket-to-pr TARS-1"]);
    expect(seen[0].opts).toEqual({ stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin" }, cwd: "/abs/target" });
  });

  it("tears down on a nonzero exit, a spawn() throw, and a child 'error' event", async () => {
    // Nonzero exit: inspect gets the exit code.
    const a = recordingAdapter();
    const r1 = await spawnClaudeRun(makeOpts({ sandbox: { adapter: a.adapter, run } }), {
      ...quiet,
      spawn: finishingSpawn(a.calls, RESULT, 3).spawn,
    });
    expect(r1.spawnError).toMatch(/exited with code 3/);
    expect(a.calls).toEqual(["prepare", "wrap", "spawn", "inspect:3", "teardown"]);

    // spawn() throws: no child, inspect gets null.
    const b = recordingAdapter();
    const r2 = await spawnClaudeRun(makeOpts({ sandbox: { adapter: b.adapter, run } }), {
      ...quiet,
      spawn: () => {
        b.calls.push("spawn");
        throw new Error("EAGAIN");
      },
    });
    expect(r2.spawnError).toBe("EAGAIN");
    expect(b.calls).toEqual(["prepare", "wrap", "spawn", "inspect:null", "teardown"]);

    // The child's 'error' event: inspect gets null.
    const c = recordingAdapter();
    const r3 = await spawnClaudeRun(makeOpts({ sandbox: { adapter: c.adapter, run } }), {
      ...quiet,
      spawn: () => {
        c.calls.push("spawn");
        const child = new FakeChild();
        setImmediate(() => child.emit("error", new Error("spawn wrapper ENOENT")));
        return child as never;
      },
    });
    expect(r3.spawnError).toMatch(/ENOENT/);
    expect(c.calls).toEqual(["prepare", "wrap", "spawn", "inspect:null", "teardown"]);
  });

  it("tears down on a timeout kill", async () => {
    const timers = makeFakeTimers();
    const { adapter, calls } = recordingAdapter();
    const child = new FakeChild(null); // ignores SIGTERM, closes on SIGKILL
    const pending = spawnClaudeRun(makeOpts({ timeoutMin: 2, sandbox: { adapter, run } }), {
      ...quiet,
      ...timers,
      spawn: () => {
        calls.push("spawn");
        return child as never;
      },
    });
    await flush();

    timers.advance(2 * 60_000);
    expect(calls).not.toContain("teardown");
    timers.advance(KILL_GRACE_MS);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // Fire-and-forget, right after the SIGKILL, before the run settles.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["prepare", "wrap", "spawn", "teardown"]);

    const result = await pending;
    expect(result.killedTimeout).toBe(true);
    expect(calls.filter((c) => c === "teardown")).toHaveLength(1);
    expect(calls).toContain("inspect:null");
  });

  it("killActiveChild tears down exactly once", async () => {
    const timers = makeFakeTimers();
    let release: () => void = () => {};
    const teardownGate = new Promise<void>((r) => {
      release = r;
    });
    const { adapter, calls } = recordingAdapter({ teardownGate });
    const child = new FakeChild("SIGTERM");
    const pending = spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      ...timers,
      spawn: () => {
        calls.push("spawn");
        return child as never;
      },
    });
    await flush();

    let killResult: string | null = null;
    const killed = killActiveChild(timers).then((r) => (killResult = r));
    for (let i = 0; i < 5; i++) await flush();
    // The child is gone, but killActiveChild waits for the teardown.
    expect(calls).toContain("teardown");
    expect(killResult).toBeNull();

    release();
    await killed;
    expect(killResult).toBe("exited");
    await pending;
    expect(calls.filter((c) => c === "teardown")).toHaveLength(1);
  });

  it("killActiveChild tears down exactly once on the SIGKILL path too", async () => {
    const timers = makeFakeTimers();
    const { adapter, calls } = recordingAdapter();
    const child = new FakeChild(null); // ignores SIGTERM
    const pending = spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      ...timers,
      spawn: () => child as never,
    });
    await flush();

    const killed = killActiveChild(timers);
    timers.advance(KILL_GRACE_MS);
    expect(await killed).toBe("killed");
    expect(calls).toContain("teardown");
    await pending;
    expect(calls.filter((c) => c === "teardown")).toHaveLength(1);
  });

  it("prepare throwing never spawns and reports an infra denial", async () => {
    const { adapter, calls } = recordingAdapter({ prepareThrows: true });
    let spawned = 0;
    const result = await spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      spawn: () => {
        spawned++;
        throw new Error("must not spawn");
      },
    });

    expect(spawned).toBe(0);
    expect(calls).toEqual(["prepare"]);
    expect(result.spawnError).toBe("sandbox prepare failed: daemon not running");
    expect(result.usage).toEqual({ costUsd: 0, tokens: { in: 0, out: 0 } });
    expect(result.killedTimeout).toBe(false);
    expect(result.resultError).toBeUndefined();
    expect(result.sandbox).toMatchObject({
      adapter: "fake",
      instance: "dev-loop-TARS-1",
      report: { denied: [{ kind: "infra", target: "prepare" }], approveHint: "sandbox prepare failed: daemon not running" },
    });
  });

  it("redacts the prepare failure message before it reaches spawnError, approveHint or the log", async () => {
    const { adapter } = recordingAdapter({ prepareThrows: true, prepareMessage: `no such dir ${homedir()}/x for someone@example.com` });
    const errors: string[] = [];
    const result = await spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      logError: (m) => errors.push(m),
      spawn: () => {
        throw new Error("must not spawn");
      },
    });
    for (const text of [result.spawnError ?? "", result.sandbox?.report.approveHint ?? "", ...errors]) {
      expect(text).not.toContain(homedir());
      expect(text).not.toContain("someone@example.com");
    }
    expect(result.spawnError).toBe("sandbox prepare failed: no such dir ~/x for REDACTED_EMAIL");
  });

  it("inspect throwing becomes an infra denial, not a throw", async () => {
    const { adapter, calls } = recordingAdapter({ inspectThrows: true });
    const result = await spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      spawn: finishingSpawn(calls).spawn,
    });

    expect(result.spawnError).toBeUndefined();
    expect(result.sandbox?.report).toEqual({ denied: [{ kind: "infra", target: "inspect" }] });
    expect(calls).toContain("teardown");
  });

  it("a teardown that throws (a buggy adapter) still never throws out of spawnClaudeRun", async () => {
    const { adapter, calls } = recordingAdapter();
    let attempts = 0;
    adapter.teardown = () => {
      attempts++;
      throw new Error("buggy teardown");
    };
    const errors: string[] = [];
    const result = await spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      logError: (m) => errors.push(m),
      spawn: finishingSpawn(calls).spawn,
    });
    expect(result.spawnError).toBeUndefined();
    expect(attempts).toBe(1);
    expect(errors.some((m) => m.includes("sandbox teardown failed: buggy teardown"))).toBe(true);
  });

  it("logs an inspect failure", async () => {
    const { adapter, calls } = recordingAdapter({ inspectThrows: true });
    const errors: string[] = [];
    await spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      logError: (m) => errors.push(m),
      spawn: finishingSpawn(calls).spawn,
    });
    expect(errors.some((m) => m.includes("sandbox inspect failed: inspect blew up"))).toBe(true);
  });

  it("a hanging teardown: spawnClaudeRun still returns once TEARDOWN_GRACE_MS passes", async () => {
    const timers = makeFakeTimers();
    const { adapter, calls } = recordingAdapter({ teardownGate: new Promise<void>(() => {}) });
    const errors: string[] = [];
    let result: unknown = null;
    const pending = spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      ...timers,
      logError: (m) => errors.push(m),
      spawn: finishingSpawn(calls).spawn,
    }).then((r) => (result = r));
    for (let i = 0; i < 5; i++) await flush();
    expect(calls).toContain("teardown");
    expect(result).toBeNull();

    timers.advance(TEARDOWN_GRACE_MS - 1);
    await flush();
    expect(result).toBeNull();
    timers.advance(1);
    await pending;
    expect(result).not.toBeNull();
    expect(errors.some((m) => m.includes("sandbox teardown still running"))).toBe(true);
    expect(timers.pendingCount()).toBe(0);
  });

  it("a hanging teardown: killActiveChild still resolves once TEARDOWN_GRACE_MS passes", async () => {
    const timers = makeFakeTimers();
    const { adapter, calls } = recordingAdapter({ teardownGate: new Promise<void>(() => {}) });
    const child = new FakeChild("SIGTERM");
    const pending = spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      ...timers,
      spawn: () => {
        calls.push("spawn");
        return child as never;
      },
    });
    await flush();

    let killResult: string | null = null;
    const killed = killActiveChild(timers).then((r) => (killResult = r));
    for (let i = 0; i < 5; i++) await flush();
    expect(calls).toContain("teardown");
    expect(killResult).toBeNull();

    timers.advance(TEARDOWN_GRACE_MS);
    await killed;
    expect(killResult).toBe("exited");
    await pending;
    expect(calls.filter((c) => c === "teardown")).toHaveLength(1);
  });

  it("exports the prepare and inspect timeouts", () => {
    expect(PREPARE_TIMEOUT_MS).toBe(300_000);
    expect(INSPECT_TIMEOUT_MS).toBe(60_000);
  });

  it("a prepare that never resolves: after PREPARE_TIMEOUT_MS, an infra prepare denial, and no spawn", async () => {
    const timers = makeFakeTimers();
    const { adapter, calls } = recordingAdapter();
    adapter.prepare = () => {
      calls.push("prepare");
      return new Promise(() => {});
    };
    let spawned = 0;
    let result: Awaited<ReturnType<typeof spawnClaudeRun>> | null = null;
    const pending = spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      ...timers,
      spawn: () => {
        spawned++;
        throw new Error("must not spawn");
      },
    }).then((r) => (result = r));
    await flush();
    timers.advance(PREPARE_TIMEOUT_MS - 1);
    await flush();
    expect(result).toBeNull();
    timers.advance(1);
    await pending;

    expect(spawned).toBe(0);
    expect(result!.spawnError).toBe("sandbox prepare failed: timed out after 300s");
    expect(result!.sandbox).toMatchObject({
      adapter: "fake",
      instance: "dev-loop-TARS-1",
      report: { denied: [{ kind: "infra", target: "prepare" }], approveHint: "sandbox prepare failed: timed out after 300s" },
    });
    expect(calls).toEqual(["prepare"]);
    expect(timers.pendingCount()).toBe(0);
  });

  it("a prepare that resolves after its timeout fired still gets its handle torn down (no leak); a teardown error is swallowed", async () => {
    const timers = makeFakeTimers();
    const { adapter, calls } = recordingAdapter();
    let resolvePrepare: (h: { adapter: string; instanceName: string }) => void = () => {};
    adapter.prepare = () => {
      calls.push("prepare");
      return new Promise((r) => (resolvePrepare = r));
    };
    const tornDown: string[] = [];
    adapter.teardown = async (h) => {
      tornDown.push(h.instanceName);
      throw new Error("late teardown blew up");
    };
    const errors: string[] = [];
    const pending = spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      ...timers,
      logError: (m) => errors.push(m),
      spawn: () => {
        throw new Error("must not spawn");
      },
    });
    await flush();
    timers.advance(PREPARE_TIMEOUT_MS);
    const result = await pending;
    expect(result.spawnError).toBe("sandbox prepare failed: timed out after 300s");
    expect(tornDown).toEqual([]);

    resolvePrepare({ adapter: "fake", instanceName: "dev-loop-TARS-1" });
    for (let i = 0; i < 5; i++) await flush();
    expect(tornDown).toEqual(["dev-loop-TARS-1"]);
    expect(errors.some((m) => m.includes("late teardown blew up"))).toBe(true);
  });

  it("a prepare that rejects after its timeout fired is ignored (no unhandled rejection, no teardown)", async () => {
    const timers = makeFakeTimers();
    const { adapter, calls } = recordingAdapter();
    let rejectPrepare: (e: Error) => void = () => {};
    adapter.prepare = () => {
      calls.push("prepare");
      return new Promise((_r, j) => (rejectPrepare = j));
    };
    const pending = spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), { ...quiet, ...timers, spawn: () => { throw new Error("must not spawn"); } });
    await flush();
    timers.advance(PREPARE_TIMEOUT_MS);
    await pending;
    rejectPrepare(new Error("late"));
    for (let i = 0; i < 5; i++) await flush();
    expect(calls).toEqual(["prepare"]);
  });

  it("a prepare that resolves in time clears its timeout", async () => {
    const timers = makeFakeTimers();
    const { adapter, calls } = recordingAdapter();
    const result = await spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      ...timers,
      spawn: finishingSpawn(calls).spawn,
    });
    expect(result.spawnError).toBeUndefined();
    expect(timers.pendingCount()).toBe(0);
  });

  it("an inspect that never resolves: after INSPECT_TIMEOUT_MS, an infra inspect denial, then teardown", async () => {
    const timers = makeFakeTimers();
    const { adapter, calls } = recordingAdapter();
    adapter.inspect = (_h, exitCode) => {
      calls.push(`inspect:${exitCode}`);
      return new Promise(() => {});
    };
    const errors: string[] = [];
    let result: Awaited<ReturnType<typeof spawnClaudeRun>> | null = null;
    const pending = spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      ...timers,
      logError: (m) => errors.push(m),
      spawn: finishingSpawn(calls).spawn,
    }).then((r) => (result = r));
    for (let i = 0; i < 5; i++) await flush();
    expect(calls).toEqual(["prepare", "wrap", "spawn", "inspect:0"]);
    timers.advance(INSPECT_TIMEOUT_MS - 1);
    await flush();
    expect(result).toBeNull();
    expect(calls).not.toContain("teardown");
    timers.advance(1);
    await pending;

    expect(result!.sandbox?.report).toEqual({ denied: [{ kind: "infra", target: "inspect" }] });
    expect(calls.at(-1)).toBe("teardown");
    expect(errors.some((m) => m.includes("sandbox inspect failed: timed out after 60s"))).toBe(true);
    expect(timers.pendingCount()).toBe(0);
  });

  it("result.sandbox carries adapter, instance, prepare_ms and the report", async () => {
    let t = Date.UTC(2026, 10, 12);
    const report: SandboxReport = { denied: [{ kind: "network", target: "example.com:443" }], approveHint: "hint" };
    const { adapter, calls } = recordingAdapter({ report, onPrepare: () => (t += 1234) });
    const result = await spawnClaudeRun(makeOpts({ sandbox: { adapter, run } }), {
      ...quiet,
      now: () => new Date(t),
      spawn: finishingSpawn(calls).spawn,
    });

    expect(result.sandbox).toEqual({ adapter: "fake", instance: "dev-loop-TARS-1", prepare_ms: 1234, report });
  });
});
