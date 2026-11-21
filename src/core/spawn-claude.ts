/**
 * Spawning a headless `claude -p` run, shared by both roles. Built from the
 * spawn/stream/usage-capture code each v1 main.ts carried (dev-loop's
 * src/main.ts and research-loop's src/main.ts, identical modulo the skill
 * name in log prefixes): spawnClaude, spawnClaudeStreaming,
 * printStreamEvent, startProgressTail, onLines, and raw-usage persistence.
 * The progress tail reads the run dir the runner passed the skill
 * (`run-dir=`, 2.0.0); v1 discovered it by diffing directory snapshots.
 *
 * New in v2 (both enforced during the run, where v1 only checked after it
 * ended): every spawn gets `--max-budget-usd`, and a run still going at
 * `timeoutMin` is sent SIGTERM, then SIGKILL 30 s later.
 *
 * The child of the run in progress is kept in a module-level handle, so a
 * signal handler can stop it (`killActiveChild`): SIGTERM, then SIGKILL
 * after KILL_GRACE_MS. Without it a SIGTERM to this process alone would
 * exit and leave the child running, orphaned, still able to push.
 *
 * Once a signal is received the process is stopping: `killActiveChild` (and
 * `stopSpawning`) set a module-level flag first, synchronously, and every
 * later run settles with `spawnError: "stopping: signal received"` without
 * calling spawn. So a cycle that reaches its next spawn while the handler
 * is still awaiting cannot start a child that would outlive the process.
 *
 * `spawnClaudeRun` never throws. A spawn failure (spawn() throwing, the
 * child's 'error' event, a nonzero exit, or a 0 exit whose final result is
 * missing, `is_error`, or has a `terminal_reason` outside
 * ALLOWED_TERMINAL_REASONS) comes back as `spawnError` -- with
 * the parsed usage whenever the child printed any stdout; a
 * timeout kill comes back as `killedTimeout: true`, which the caller maps to
 * outcome "killed" / failure_category "killed_ceiling"
 * (`killedTimeoutVerdict`).
 *
 * With `opts.sandbox`, every spawn goes through the adapter in this order:
 * prepare (timed), wrap, spawn, inspect after the child settles, then a
 * once-guarded teardown in a `finally` (also called by `killActiveChild` and
 * right after a timeout SIGKILL); without it the spawn is exactly as before.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extractUsage } from "./claude-usage.ts";
import type { UsageResult } from "./claude-usage.ts";
import { redactSensitive } from "./redact.ts";
import type { ExecutorVerdict } from "./types.ts";
import type { RunSandboxSpec, SandboxAdapter, SandboxHandle, SandboxReport, WrappedSpawn } from "../sandbox/types.ts";

/**
 * `terminal_reason` values of a successful run (every real local run reported
 * "completed"). Any other value is an agent_error, logged as an unknown
 * terminal_reason. If a new Claude Code CLI adds a success reason, add it
 * here (and to the "allows only ..." test in test/core/spawn-claude.test.ts).
 */
export const ALLOWED_TERMINAL_REASONS: readonly string[] = ["completed"];

/** Grace period between SIGTERM and SIGKILL on a timeout kill. */
export const KILL_GRACE_MS = 30_000;

/**
 * After SIGKILL, how long to wait for the child's 'exit'/'close' before
 * settling anyway. 'close' waits for stdio to close, which a grandchild
 * still holding the pipe can delay forever; the run must still return.
 */
export const POST_KILL_GRACE_MS = 5_000;

/**
 * The longest any caller waits for a sandbox teardown (killActiveChild, the
 * run's finally). A hung adapter must not stop a signal from exiting the
 * process; past this, the wait is abandoned with a logged error.
 */
export const TEARDOWN_GRACE_MS = 30_000;

/** The longest a sandbox prepare may take; past it the run gets an infra `prepare` denial and never spawns. */
export const PREPARE_TIMEOUT_MS = 300_000;

/** The longest a sandbox inspect may take; past it the report is an infra `inspect` denial and teardown runs. */
export const INSPECT_TIMEOUT_MS = 60_000;

const TIMED_OUT = Symbol("timed out");

/**
 * Races `p` against a timer (the injected setTimeout); resolves TIMED_OUT
 * when the timer wins. The timer is cleared when `p` settles first; a
 * rejection of `p` propagates.
 */
function raceTimeout<T>(p: Promise<T>, ms: number, timers: Pick<Required<SpawnClaudeDeps>, "setTimeout" | "clearTimeout">): Promise<T | typeof TIMED_OUT> {
  return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    const timer = timers.setTimeout(() => resolve(TIMED_OUT), ms);
    p.then(
      (v) => {
        timers.clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        timers.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const timedOutMessage = (ms: number): string => `timed out after ${ms / 1000}s`;

export interface SpawnClaudeOpts {
  prompt: string;
  model: string;
  allowedTools: string;
  addDir: string | null;
  timeoutMin: number;
  maxBudgetUsd: number;
  stream: boolean;
  ticketKey: string;
  rawUsagePath: string;
  env: NodeJS.ProcessEnv;
  /**
   * Absolute CLAUDE.md paths (or picomatch globs) the child must not load,
   * passed as `--settings {"claudeMdExcludes": [...]}` (a Claude Code
   * setting, verified in 2.1.322). Omitted or empty: no --settings flag.
   */
  excludeClaudeMd?: string[];
  /**
   * Text appended to the default system prompt (`--append-system-prompt`,
   * a Claude Code flag, verified in 2.1.322). The research spawn passes its
   * stance here. Omitted or empty: no flag.
   */
  appendSystemPrompt?: string;
  /** The child's working directory. Omitted: this process's cwd. */
  cwd?: string;
  /**
   * Absolute directories the child must not Edit/Write/NotebookEdit under,
   * passed as `permissions.deny` (`Edit(//<dir>/**)` etc.; `//` anchors at
   * the filesystem root) in the same `--settings` JSON as claudeMdExcludes.
   * Verified live in 2.1.322: denied even under `--permission-mode
   * acceptEdits` + `--add-dir <dir>`. Must be absolute with no glob
   * characters, or the spawn is refused (spawnError).
   */
  denyEditsUnder?: string[];
  /**
   * Absolute files the child must not Read, passed as `Read(//<path>)` in the
   * same `permissions.deny` list. Same path rule as denyEditsUnder. Stops the
   * Read tool only, not a Bash `cat`: a soft rule (the target repo's real
   * env files with no sandbox; see src/core/fake-env.ts).
   */
  denyReads?: string[];
  /**
   * Whole tools (or `Tool(prefix:*)` rules) the child must not use, appended
   * to the same `permissions.deny` list: the eval fixture runner's leak guard
   * (`mcp__atlassian`, `Bash(gh:*)`, `WebFetch`). Each must match DENY_TOOL,
   * or the spawn is refused (spawnError). Omitted: real runs are unchanged.
   */
  denyTools?: string[];
  /** Prefix for this run's log lines (the skill name). Overrides SpawnClaudeDeps.logPrefix. */
  logPrefix?: string;
  /** Run the spawn through this sandbox adapter. Omitted: no sandbox, the spawn is unchanged. */
  sandbox?: { adapter: SandboxAdapter; run: RunSandboxSpec };
}

export interface SpawnClaudeResult {
  /**
   * claude's stdout (unredacted, for parsing): the whole `--output-format
   * json` document, or, when streaming, the final `result` line (the last
   * line seen if no result line ever arrived).
   */
  stdout: string;
  usage: UsageResult;
  /** ISO-8601 UTC. */
  started: string;
  /** ISO-8601 UTC. */
  ended: string;
  spawnError?: string;
  /** The parsed final result's error fields; set whenever a result object was parsed. */
  resultError?: { is_error: boolean; terminal_reason?: string };
  killedTimeout: boolean;
  /** Set only when `opts.sandbox` was given (and a sandbox was prepared or attempted). */
  sandbox?: { adapter: string; instance: string; prepare_ms: number; report: SandboxReport };
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions & { env: NodeJS.ProcessEnv },
) => ChildProcess;

/** Injectable I/O, so tests run with a fake child and a manual clock. */
export interface SpawnClaudeDeps {
  spawn?: SpawnFn;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  now?: () => Date;
  /** Prefix for printed lines, e.g. the skill name. */
  logPrefix?: string;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

/** Env keys never passed to the child: skills use the Atlassian MCP's own auth. */
const STRIPPED_ENV_KEYS = ["JIRA_API_TOKEN", "JIRA_EMAIL", "JIRA_BASE_URL"] as const;

/**
 * A copy of `parent` minus JIRA_API_TOKEN, JIRA_EMAIL and JIRA_BASE_URL.
 * Only this process's own REST client needs them; a skill's Bash call that
 * dumps its env must not find them.
 */
export function childEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  return env;
}

/**
 * The verdict a caller records for a run killed at its timeout: outcome
 * "killed", failure_category "killed_ceiling". Carries every executor field
 * (zeroed), so it is valid under both verdict profiles.
 */
export function killedTimeoutVerdict(timeoutMin: number): ExecutorVerdict {
  return {
    outcome: "killed",
    phase_reached: "intake",
    failure_category: "killed_ceiling",
    detail: `claude -p was killed at the runTimeoutMin ceiling (${timeoutMin} min)`,
    red_confirmed: false,
    verify_loops: 0,
    retries: 0,
    skill_version: "",
    model: "",
    pr: null,
    cost_usd: 0,
    tokens: { in: 0, out: 0 },
  };
}

function defaultLog(message: string): void {
  console.log(redactSensitive(message));
}

function defaultLogError(message: string): void {
  console.error(redactSensitive(message));
}

/**
 * Line-buffers a readable stream and calls onLine per complete line. Used
 * for stderr on both paths, since stderr is never inherited (that would
 * print an unredacted child-process line straight to the terminal,
 * bypassing redactSensitive() entirely), and for stdout when streaming.
 */
export function onLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffered = "";
  stream.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) onLine(line);
    }
  });
}

/**
 * Prints one line per interesting `stream-json` event -- tool calls and
 * their results -- so a human watching `--stream` sees live activity
 * instead of a silent multi-minute gap. Skips system/hook noise and raw
 * thinking blocks (too verbose to be useful live). Truncates any printed
 * input/content so a large file read/write doesn't flood the terminal.
 */
export function printStreamEvent(
  parsed: unknown,
  ticketKey: string,
  logPrefix: string,
  log: (message: string) => void = defaultLog,
): void {
  // Redact *before* truncating, not after: a secret cut mid-value by
  // truncation loses its closing quote, so redact.ts's patterns (which
  // require a real closing quote/delimiter) never match the now-unquoted
  // prefix, and it prints in the clear. log() also runs redactSensitive()
  // on the final line -- harmless, since re-redacting an
  // already-substituted REDACTED_SECRET string is a no-op.
  const truncate = (value: unknown): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const redacted = redactSensitive(text);
    return redacted.length > 200 ? `${redacted.slice(0, 200)}...` : redacted;
  };

  if (typeof parsed !== "object" || parsed === null) return;
  const event = parsed as Record<string, unknown>;

  if (event.type === "assistant") {
    const content = (event.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (item?.type === "tool_use") {
        log(`[${logPrefix}] ${ticketKey} tool_use: ${item.name} ${truncate(item.input)}`);
      }
    }
  } else if (event.type === "user") {
    const content = (event.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (item?.type === "tool_result") {
        log(`[${logPrefix}] ${ticketKey} tool_result: ${truncate(item.content)}`);
      }
    }
  }
}

/**
 * Polls a run's own progress.jsonl (which the skill writes to live, phase
 * by phase, while it works) and prints each new line as it appears -- so a
 * human watching the foreground process sees the phases scroll by instead
 * of a silent multi-minute gap between "claimed" and the final result.
 * `runDir` is the absolute RUN_DIR the skill was given.
 */
export function startProgressTail(
  runDir: string,
  ticketKey: string,
  logPrefix: string,
  log: (message: string) => void = defaultLog,
): { stop: () => Promise<void> } {
  let linesPrinted = 0;

  async function poll(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(join(runDir, "progress.jsonl"), "utf8");
    } catch {
      return;
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines.slice(linesPrinted)) {
      try {
        const event = JSON.parse(line) as { phase: string; event: string; detail: string };
        log(`[${logPrefix}] ${ticketKey} ${event.phase} ${event.event}: ${event.detail}`);
      } catch {
        // Malformed progress line -- never let a logging glitch crash the loop.
      }
    }
    linesPrinted = lines.length;
  }

  const interval = setInterval(() => {
    poll().catch(() => {});
  }, 2000);

  return {
    stop: async () => {
      clearInterval(interval);
      await poll().catch(() => {});
    },
  };
}

const DENY_DIR = /^\/[A-Za-z0-9@._/+-]*$/;
/** A tool name (`mcp__server`, `WebFetch`) or `Tool(prefix:*)`: a plain prefix of words joined by single spaces (`git push`). */
const DENY_TOOL = /^[A-Za-z][A-Za-z0-9_]*(\([A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*:\*\))?$/;

/** The `--settings` JSON, or null when there is nothing to set. Throws on an unsafe deny dir. */
export function settingsJson(opts: Pick<SpawnClaudeOpts, "excludeClaudeMd" | "denyEditsUnder" | "denyReads" | "denyTools">): string | null {
  const settings: { claudeMdExcludes?: string[]; permissions?: { deny: string[] } } = {};
  if (opts.excludeClaudeMd && opts.excludeClaudeMd.length > 0) settings.claudeMdExcludes = opts.excludeClaudeMd;
  const dirs = opts.denyEditsUnder ?? [];
  for (const d of dirs) {
    if (!DENY_DIR.test(d)) throw new Error(`denyEditsUnder: ${JSON.stringify(d)} must be an absolute path with no glob characters`);
  }
  const reads = opts.denyReads ?? [];
  for (const f of reads) {
    if (!DENY_DIR.test(f)) throw new Error(`denyReads: ${JSON.stringify(f)} must be an absolute path with no glob characters`);
  }
  const tools = opts.denyTools ?? [];
  for (const t of tools) {
    if (!DENY_TOOL.test(t)) throw new Error(`denyTools: ${JSON.stringify(t)} must be a tool name or Tool(prefix:*)`);
  }
  const deny = [
    ...dirs.flatMap((d) => ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(/${d.replace(/\/+$/, "")}/**)`)),
    ...reads.map((f) => `Read(/${f})`),
    ...tools,
  ];
  if (deny.length > 0) settings.permissions = { deny };
  return Object.keys(settings).length > 0 ? JSON.stringify(settings) : null;
}

function buildArgs(opts: SpawnClaudeOpts): string[] {
  const settings = settingsJson(opts);
  return [
    "-p",
    opts.prompt,
    "--model",
    opts.model,
    "--permission-mode",
    "acceptEdits",
    ...(opts.addDir ? ["--add-dir", opts.addDir] : []),
    "--allowedTools",
    opts.allowedTools,
    "--max-budget-usd",
    String(opts.maxBudgetUsd),
    ...(settings !== null ? ["--settings", settings] : []),
    ...(opts.appendSystemPrompt ? ["--append-system-prompt", opts.appendSystemPrompt] : []),
    ...(opts.stream
      ? ["--output-format", "stream-json", "--verbose"]
      : ["--output-format", "json"]),
  ];
}

/**
 * The run in progress: its child, a promise that settles when the run does,
 * and a wait for its sandbox teardown (once-guarded, never rejecting, and
 * bounded by TEARDOWN_GRACE_MS).
 */
let active: { child: ChildProcess; done: Promise<void>; teardown: () => Promise<void> } | null = null;

export type KillActiveResult = "none" | "exited" | "killed";

/** Set once a signal is received; no child is spawned after it. Never cleared in production. */
let stopping = false;

export const STOPPING_SPAWN_ERROR = "stopping: signal received";

/** Refuses every later spawn (see the header). Idempotent. */
export function stopSpawning(): void {
  stopping = true;
}

/** Test-only: clears the stopping flag so it does not leak between tests. */
export function _resetStoppingForTests(): void {
  stopping = false;
}

/**
 * Refuses further spawns (`stopSpawning`, first, synchronously), then
 * stops the running `claude -p` child, if any: SIGTERM, then SIGKILL when
 * the run has not ended KILL_GRACE_MS later. Resolves once the run has
 * ended (or, after SIGKILL, once POST_KILL_GRACE_MS more has passed).
 * Never throws. Timers are injectable for tests.
 */
export async function killActiveChild(
  timers: Pick<SpawnClaudeDeps, "setTimeout" | "clearTimeout"> = {},
): Promise<KillActiveResult> {
  stopSpawning();
  const run = active;
  if (run === null) return "none";
  const set = timers.setTimeout ?? setTimeout;
  const clear = timers.clearTimeout ?? clearTimeout;
  const within = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const t = set(() => resolve(false), ms);
      void run.done.then(() => {
        clear(t);
        resolve(true);
      });
    });
  try {
    run.child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  if (await within(KILL_GRACE_MS)) {
    await run.teardown();
    return "exited";
  }
  try {
    run.child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  await within(POST_KILL_GRACE_MS);
  await run.teardown();
  return "killed";
}

interface ChildOutcome {
  stdout: string;
  spawnError?: string;
  killedTimeout: boolean;
  /** The 'close' code; null when killed, on an error, or when nothing was spawned. */
  exitCode: number | null;
}

/** How runChild talks to a prepared sandbox. */
interface ChildSandbox {
  wrap: (cmd: string, args: string[], opts: WrappedSpawn["opts"]) => WrappedSpawn;
  /** Starts the teardown (fire-and-forget). Once-guarded; never rejects. */
  teardown: () => Promise<void>;
  /** Waits for the teardown, at most TEARDOWN_GRACE_MS. Once-guarded; never rejects. */
  waitTeardown: () => Promise<void>;
}

const noTeardown = async (): Promise<void> => {};

/** Runs the child to completion (or kill). Never rejects. */
function runChild(
  opts: SpawnClaudeOpts,
  deps: Required<SpawnClaudeDeps>,
  sandbox?: ChildSandbox,
): Promise<ChildOutcome> {
  const teardown = sandbox?.teardown ?? noTeardown;
  const waitTeardown = sandbox?.waitTeardown ?? noTeardown;
  let markDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    markDone = r;
  });
  return new Promise((resolve) => {
    let settled = false;
    let killedTimeout = false;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let postKillTimer: ReturnType<typeof setTimeout> | undefined;

    // Non-streaming: the whole stdout. Streaming: the result line, else the last line.
    let stdout = "";
    let lastLine = "";
    let resultLine: string | null = null;
    const collected = (): string => (opts.stream ? resultLine ?? lastLine : stdout);

    const settle = (outcome: ChildOutcome): void => {
      if (settled) return;
      settled = true;
      if (termTimer !== undefined) deps.clearTimeout(termTimer);
      if (killTimer !== undefined) deps.clearTimeout(killTimer);
      if (postKillTimer !== undefined) deps.clearTimeout(postKillTimer);
      if (active?.done === done) active = null;
      markDone();
      resolve(outcome);
    };

    if (stopping) {
      settle({ stdout: "", spawnError: STOPPING_SPAWN_ERROR, killedTimeout: false, exitCode: null });
      return;
    }
    let child: ChildProcess;
    try {
      const spawnOpts: WrappedSpawn["opts"] = {
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv(opts.env),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      };
      const s = sandbox ? sandbox.wrap("claude", buildArgs(opts), spawnOpts) : { cmd: "claude", args: buildArgs(opts), opts: spawnOpts };
      child = deps.spawn(s.cmd, s.args, s.opts);
    } catch (err) {
      settle({ stdout: "", spawnError: err instanceof Error ? err.message : String(err), killedTimeout: false, exitCode: null });
      return;
    }
    active = { child, done, teardown: waitTeardown };

    if (opts.stream) {
      if (child.stdout) {
        onLines(child.stdout, (line) => {
          lastLine = line;
          try {
            const parsed = JSON.parse(line);
            if (parsed?.type === "result") resultLine = line;
            printStreamEvent(parsed, opts.ticketKey, deps.logPrefix, deps.log);
          } catch {
            // Malformed stream line -- skip it, never let it crash the loop.
          }
        });
      }
    } else {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
    }
    if (child.stderr) {
      onLines(child.stderr, (line) => deps.logError(`[${deps.logPrefix}] (stderr) ${line}`));
    }

    termTimer = deps.setTimeout(() => {
      termTimer = undefined;
      killedTimeout = true;
      deps.logError(
        `[${deps.logPrefix}] ${opts.ticketKey}: still running at runTimeoutMin (${opts.timeoutMin} min), sending SIGTERM`,
      );
      child.kill("SIGTERM");
      killTimer = deps.setTimeout(() => {
        killTimer = undefined;
        deps.logError(`[${deps.logPrefix}] ${opts.ticketKey}: no exit ${KILL_GRACE_MS / 1000}s after SIGTERM, sending SIGKILL`);
        child.kill("SIGKILL");
        void teardown();
        postKillTimer = deps.setTimeout(() => {
          postKillTimer = undefined;
          deps.logError(
            `[${deps.logPrefix}] ${opts.ticketKey}: no exit/close ${POST_KILL_GRACE_MS / 1000}s after SIGKILL, giving up on the child`,
          );
          settle({ stdout: collected(), killedTimeout: true, exitCode: null });
        }, POST_KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    }, opts.timeoutMin * 60_000);

    child.on("error", (err: Error) => {
      settle({ stdout: collected(), spawnError: err.message, killedTimeout, exitCode: null });
    });
    // After a timeout kill, 'exit' is enough: 'close' can wait forever on a
    // grandchild that inherited the stdio pipes. Without a kill, keep
    // waiting for 'close' so no buffered stdout is lost.
    child.on("exit", () => {
      if (killedTimeout) settle({ stdout: collected(), killedTimeout: true, exitCode: null });
    });
    child.on("close", (code: number | null) => {
      if (killedTimeout) {
        settle({ stdout: collected(), killedTimeout: true, exitCode: null });
        return;
      }
      if (code !== 0) {
        const tail = collected().slice(-2000);
        settle({
          stdout: collected(),
          spawnError: `claude exited with code ${code}. ${opts.stream ? "Last line" : "Output"}: ${tail}`,
          killedTimeout: false,
          exitCode: code,
        });
        return;
      }
      settle({ stdout: collected(), killedTimeout: false, exitCode: 0 });
    });
  });
}

/**
 * Spawn one `claude -p` run and collect its output and usage. Never throws.
 *
 * Raw stdout is persisted to `rawUsagePath` (redacted) unconditionally
 * before it is parsed -- extractUsage() deliberately returns zeros on a
 * parse failure rather than throwing, so without this the real cost/token
 * numbers would be gone forever the moment this function returns. It is
 * skipped only when there is no stdout at all. (v1 also skipped it on a
 * nonzero exit; with --max-budget-usd that would zero the cost of exactly
 * the runs that hit the cap.)
 */
export async function spawnClaudeRun(
  opts: SpawnClaudeOpts,
  injected: SpawnClaudeDeps = {},
): Promise<SpawnClaudeResult> {
  const deps: Required<SpawnClaudeDeps> = {
    spawn: injected.spawn ?? (nodeSpawn as unknown as SpawnFn),
    setTimeout: injected.setTimeout ?? setTimeout,
    clearTimeout: injected.clearTimeout ?? clearTimeout,
    now: injected.now ?? (() => new Date()),
    logPrefix: opts.logPrefix ?? injected.logPrefix ?? "claude",
    log: injected.log ?? defaultLog,
    logError: injected.logError ?? defaultLogError,
  };

  const started = deps.now().toISOString();

  // Prepare the sandbox, if any. A failure here means no child: return
  // before the result checks, with an infra denial (Review Focus 2).
  let prepared:
    | {
        adapter: SandboxAdapter;
        handle: SandboxHandle;
        prepare_ms: number;
        /** The bounded wait. */
        teardown: () => Promise<void>;
        startTeardown: () => Promise<void>;
      }
    | undefined;
  if (opts.sandbox !== undefined && !stopping) {
    const { adapter, run } = opts.sandbox;
    const t0 = deps.now().getTime();
    let handle: SandboxHandle;
    try {
      // Promise.resolve().then: a synchronous throw from a buggy adapter becomes a rejection.
      const preparing = Promise.resolve().then(() => adapter.prepare(run));
      const raced = await raceTimeout(preparing, PREPARE_TIMEOUT_MS, deps);
      if (raced === TIMED_OUT) {
        // The prepare may still finish: tear its instance down then, or it leaks.
        // A late rejection has nothing to clean up. A prepare timeout is an
        // all-infra park, so the worker usually pauses and exits first; the
        // real backstop is cleanupOrphans on the next start.
        preparing.then(
          (late) =>
            Promise.resolve()
              .then(() => adapter.teardown(late))
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                deps.logError(`[${deps.logPrefix}] ${opts.ticketKey}: sandbox teardown of a late prepare failed: ${message}`);
              }),
          () => {},
        );
        throw new Error(timedOutMessage(PREPARE_TIMEOUT_MS));
      }
      handle = raced;
    } catch (err) {
      // Redacted here, not only at print time: spawnError and approveHint
      // also reach the iteration log and the desktop notification.
      const message = redactSensitive(err instanceof Error ? err.message : String(err));
      const spawnError = `sandbox prepare failed: ${message}`;
      deps.logError(`[${deps.logPrefix}] ${opts.ticketKey}: spawn failed: ${spawnError}`);
      return {
        stdout: "",
        usage: { costUsd: 0, tokens: { in: 0, out: 0 } },
        started,
        ended: deps.now().toISOString(),
        spawnError,
        killedTimeout: false,
        sandbox: {
          adapter: adapter.name,
          instance: run.instanceName,
          prepare_ms: deps.now().getTime() - t0,
          // The message is the only thing sandbox:approvals can show for this
          // park; the record path redacts it (appendIteration).
          report: { denied: [{ kind: "infra", target: "prepare" }], approveHint: spawnError },
        },
      };
    }
    const prepare_ms = deps.now().getTime() - t0;
    // Once-guarded and never rejecting: the finally, killActiveChild and the
    // timeout path may all call it; the adapter's teardown runs once.
    let torn: Promise<void> | undefined;
    const teardown = (): Promise<void> =>
      (torn ??= (async () => {
        try {
          await adapter.teardown(handle);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.logError(`[${deps.logPrefix}] ${opts.ticketKey}: sandbox teardown failed: ${message}`);
        }
      })());
    // Bounded wait, also once-guarded so the kill path and the finally
    // share one timer and one log line.
    let waited: Promise<void> | undefined;
    const waitTeardown = (): Promise<void> =>
      (waited ??= new Promise<void>((resolve) => {
        const timer = deps.setTimeout(() => {
          deps.logError(
            `[${deps.logPrefix}] ${opts.ticketKey}: sandbox teardown still running after ${TEARDOWN_GRACE_MS / 1000}s, not waiting for it`,
          );
          resolve();
        }, TEARDOWN_GRACE_MS);
        void teardown().then(() => {
          deps.clearTimeout(timer);
          resolve();
        });
      }));
    prepared = { adapter, handle, prepare_ms, teardown: waitTeardown, startTeardown: teardown };
  }

  let outcome: ChildOutcome;
  let report: SandboxReport | undefined;
  try {
    outcome = await runChild(
      opts,
      deps,
      prepared && {
        wrap: (cmd, args, spawnOpts) => prepared.adapter.wrap(prepared.handle, cmd, args, spawnOpts),
        teardown: prepared.startTeardown,
        waitTeardown: prepared.teardown,
      },
    );
    if (prepared) {
      try {
        const inspecting = Promise.resolve().then(() => prepared.adapter.inspect(prepared.handle, outcome.exitCode));
        const raced = await raceTimeout(inspecting, INSPECT_TIMEOUT_MS, deps);
        if (raced === TIMED_OUT) {
          inspecting.catch(() => {});
          throw new Error(timedOutMessage(INSPECT_TIMEOUT_MS));
        }
        report = raced;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logError(`[${deps.logPrefix}] ${opts.ticketKey}: sandbox inspect failed: ${message}`);
        report = { denied: [{ kind: "infra", target: "inspect" }] };
      }
    }
  } finally {
    if (prepared) await prepared.teardown();
  }
  const ended = deps.now().toISOString();
  const sandbox: Pick<SpawnClaudeResult, "sandbox"> =
    prepared && report
      ? { sandbox: { adapter: prepared.adapter.name, instance: prepared.handle.instanceName, prepare_ms: prepared.prepare_ms, report } }
      : {};

  if (outcome.spawnError !== undefined) {
    deps.logError(`[${deps.logPrefix}] ${opts.ticketKey}: spawn failed: ${outcome.spawnError}`);
  }

  // Nothing was ever printed (spawn() threw, ENOENT, or a crash before any
  // output): no raw usage to persist, zero usage.
  if (outcome.spawnError !== undefined && outcome.stdout.length === 0) {
    return {
      stdout: outcome.stdout,
      usage: { costUsd: 0, tokens: { in: 0, out: 0 } },
      started,
      ended,
      spawnError: outcome.spawnError,
      killedTimeout: outcome.killedTimeout,
      ...sandbox,
    };
  }

  try {
    await mkdir(dirname(opts.rawUsagePath), { recursive: true });
    await writeFile(opts.rawUsagePath, redactSensitive(outcome.stdout), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logError(`[${deps.logPrefix}] ${opts.ticketKey}: failed to persist raw usage: ${message}`);
  }

  let usageRaw: unknown = null;
  try {
    usageRaw = JSON.parse(outcome.stdout);
  } catch {
    usageRaw = null;
  }

  let spawnError = outcome.spawnError;
  let resultError: SpawnClaudeResult["resultError"];
  const parsedResult =
    typeof usageRaw === "object" && usageRaw !== null && (usageRaw as { type?: unknown }).type === "result"
      ? (usageRaw as { is_error?: unknown; terminal_reason?: unknown })
      : null;
  if (parsedResult !== null) {
    const isError = parsedResult.is_error === true;
    const reason = typeof parsedResult.terminal_reason === "string" ? parsedResult.terminal_reason : undefined;
    resultError = { is_error: isError, ...(reason !== undefined ? { terminal_reason: reason } : {}) };
    if (reason !== undefined && !ALLOWED_TERMINAL_REASONS.includes(reason)) {
      deps.logError(
        `[${deps.logPrefix}] ${opts.ticketKey}: unknown terminal_reason "${reason.slice(0, 100)}" -- treated as agent_error; if it is a new success reason, add it to ALLOWED_TERMINAL_REASONS (src/core/spawn-claude.ts)`,
      );
    }
    if (spawnError === undefined && !outcome.killedTimeout && (isError || (reason !== undefined && !ALLOWED_TERMINAL_REASONS.includes(reason)))) {
      spawnError = `claude reported a failed result (is_error=${isError}, terminal_reason=${reason})`;
    }
  } else if (spawnError === undefined && !outcome.killedTimeout) {
    spawnError = "claude exited 0 without a result";
  }
  if (spawnError !== undefined && outcome.spawnError === undefined) {
    deps.logError(`[${deps.logPrefix}] ${opts.ticketKey}: spawn failed: ${spawnError}`);
  }

  // A nonzero exit that still printed a result (e.g. the --max-budget-usd
  // cap) keeps its real cost, so the ceilings and runs.jsonl never
  // undercount the most expensive runs; spawnError is still reported.
  return {
    stdout: outcome.stdout,
    usage: extractUsage(usageRaw),
    started,
    ended,
    ...(spawnError !== undefined ? { spawnError } : {}),
    ...(resultError !== undefined ? { resultError } : {}),
    killedTimeout: outcome.killedTimeout,
    ...sandbox,
  };
}
