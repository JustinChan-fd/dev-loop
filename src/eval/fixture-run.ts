// The fixture runner (eval fixtures): ticket-refine against a ticket kept in
// local files, N times in sequence, graded against expect.json. Not a flag on
// main.ts: there is no session lock, claim, iteration log, label swap or
// mirror Issue. Every Jira write the loop would make goes to RUN_DIR/outbox
// (OutboxJiraClient); the skill's own posts go there too (SKILL.md "Fixture
// mode"); the spawn gets the leak guard (guard.ts). The real-IO wiring is
// fixture-run-cli.ts; everything here takes injected deps and is tested.

import { appendFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { roleView } from "../core/config.ts";
import type { Config } from "../core/types.ts";
import { checkAbsPath } from "../core/build-prompt.ts";
import { FIXTURE_NAME, runIdNow, v2FixtureRunDir } from "../core/paths.ts";
import { FlagError } from "../core/flags.ts";
import type { AttachmentDeps, AttachmentMeta } from "../core/attachments.ts";
import type { RunSkillFn } from "../core/run-skill.ts";
import type { SpawnClaudeOpts, SpawnClaudeResult } from "../core/spawn-claude.ts";
import { parseVerdict } from "../core/verdict.ts";
import { runResearchPhase } from "../roles/research/phase.ts";
import { checkResearchVerdict, DEFAULT_COVERAGE_WARN_RUNS, readResearchFacts } from "../roles/research/verdict-checks.ts";
import type { Fixture, FixtureAttachment } from "./fixture.ts";
import { aggregate, gradeRun, type Grade } from "./grade-fixture.ts";
import { FIXTURE_ALLOWED_TOOLS, FIXTURE_DENY, fixtureSpawnGuard } from "./guard.ts";
import { OutboxJiraClient, readOutbox } from "./outbox.ts";
import type { Pinned } from "./pin-repo.ts";

/**
 * Live fixture runs stay off until the guard hook exists (a Bash hook that
 * denies gh/api.github.com however it is spelled) and a person has watched a
 * first run. Spec, calls 5 and 9.
 */
export const LIVE_ENABLED = false;
export const MAX_RUNS = 5;
export const MAX_TOTAL_USD = 25;
export const PER_RUN_BUDGET_USD = 5;

export interface FixtureArgs {
  fixture: string;
  runs: number;
  maxTotalUsd: number;
}

export function parseFixtureArgs(argv: string[]): FixtureArgs {
  let fixture: string | undefined;
  let runs = 3;
  let maxTotalUsd = MAX_TOTAL_USD;
  const flags: Record<string, (v: string) => void> = {
    fixture: (v) => void (fixture = v),
    runs: (v) => {
      runs = Number(v);
      if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw new FlagError(`--runs must be a whole number from 1 to ${MAX_RUNS}, got ${JSON.stringify(v)}`);
    },
    "max-total": (v) => {
      maxTotalUsd = Number(v);
      if (!Number.isFinite(maxTotalUsd) || maxTotalUsd <= 0 || maxTotalUsd > MAX_TOTAL_USD) {
        throw new FlagError(`--max-total must be more than 0 and at most ${MAX_TOTAL_USD}, got ${JSON.stringify(v)}`);
      }
    },
  };
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) throw new FlagError(`unknown argument ${JSON.stringify(a)} (usage: --fixture=<name> [--runs=1..${MAX_RUNS}] [--max-total=<usd, max ${MAX_TOTAL_USD}>])`);
    const set = Object.hasOwn(flags, m[1]!) ? flags[m[1]!] : undefined;
    if (!set) throw new FlagError(`unknown flag --${m[1]}`);
    set(m[2]!);
  }
  if (fixture === undefined) throw new FlagError("--fixture=<name> is required");
  if (!FIXTURE_NAME.test(fixture)) throw new FlagError(`--fixture ${JSON.stringify(fixture)} must match ${FIXTURE_NAME}`);
  return { fixture, runs, maxTotalUsd };
}

/** Same rule as evals/lib.sh: unset/empty/1 dry, exactly 0 live, anything else refused. Live never inside Claude Code. */
export function fixtureMode(env: NodeJS.ProcessEnv): "dry" | "live" {
  const v = env.DRY_RUN;
  if (v === undefined || v === "" || v === "1") return "dry";
  if (v !== "0") throw new FlagError(`DRY_RUN must be unset/empty/1 (dry) or exactly 0 (live); got ${JSON.stringify(v)}. Refusing.`);
  if (env.CLAUDECODE !== undefined) throw new FlagError("DRY_RUN=0 (live) refused: CLAUDECODE is set, so this is running inside a Claude Code session; a human runs live evals from their own shell");
  return "live";
}

/** The profile's reads of origin/<branch>:<file> go to the pinned commit instead (node major, fake env template). */
export function pinnedGit(git: (args: string[], cwd: string) => Promise<string>, sha: string): (args: string[], cwd: string) => Promise<string> {
  return (args, cwd) => {
    if (args[0] === "show" && args.length === 2 && /^origin\/[^:]+:/.test(args[1]!)) return git(["show", args[1]!.replace(/^origin\/[^:]+:/, `${sha}:`)], cwd);
    return git(args, cwd);
  };
}

type Spawn = (opts: SpawnClaudeOpts) => Promise<SpawnClaudeResult>;

/** Wraps the real spawn: the leak guard on tools and env, and `ground-dir=` on the prompt. */
export function fixtureSpawn(spawn: Spawn, o: { groundDir: string; ghConfigDir: string }): Spawn {
  checkAbsPath("ground-dir", o.groundDir);
  checkAbsPath("gh-config-dir", o.ghConfigDir);
  return (opts) => {
    const g = fixtureSpawnGuard({ allowedTools: opts.allowedTools, env: opts.env }, o.ghConfigDir);
    return spawn({ ...opts, prompt: `${opts.prompt} ground-dir=${o.groundDir}`, allowedTools: g.allowedTools, denyTools: [...(opts.denyTools ?? []), ...g.denyTools], env: g.env });
  };
}

/** AttachmentDeps over the fixture folder: the ticket's metadata, files from <fixture>/attachments/. A missing file rejects, so it is a `failed` entry. */
export function fixtureAttachments(fixtureDir: string, list: FixtureAttachment[]): AttachmentDeps {
  return {
    list: async () => list.map((a) => ({ ...a })),
    download: async (a: AttachmentMeta) => {
      try {
        return await readFile(join(fixtureDir, "attachments", a.filename));
      } catch {
        throw new Error(`fixture attachment ${a.filename} is not in the fixture's attachments/ folder`);
      }
    },
  };
}

export interface FixtureRunLine {
  fixture: string;
  ticket: string;
  run: number;
  run_dir: string;
  sha: string;
  started: string;
  ended: string;
  outcome: string;
  failure_category: string | null;
  loop_action: string;
  verdict_check?: string;
  cost_usd: number;
  pass: boolean;
  reasons: string[];
}

export interface FixtureRunDeps {
  fixture: Fixture;
  config: Config;
  runs: number;
  maxTotalUsd: number;
  /** Per spawn; clipped to what is left of maxTotalUsd. */
  maxBudgetUsd: number;
  now: () => Date;
  /** Repo-relative -> absolute (resolveRepoPath in production). */
  resolve: (rel: string) => string;
  /** runs/v2/fixtures/<fixture>.jsonl, absolute. */
  logPath: string;
  /** Pins the repo for one run (pinWorktree in production). */
  pin: (runId: string) => Promise<Pinned>;
  /** makeRunSkill with the fixture spawn, for one pinned worktree and run dir. */
  makeRunSkill: (c: { pinned: Pinned; absRunDir: string }) => RunSkillFn;
  log: (m: string) => void;
  /** Aborted on SIGINT/SIGTERM: no new run starts; the current run's pin is still removed (finally). */
  signal?: AbortSignal;
}

export interface FixtureResult {
  pass: boolean;
  passRate: number;
  runs: number;
  reasons: string[];
  costUsd: number;
  stoppedAt?: string;
}

/** A distinct run id per run: a run that starts in the same second as the last waits for the next one. */
function nextRunId(now: () => Date, last: string | undefined): string {
  let id = runIdNow(now());
  while (id === last) id = runIdNow(now());
  return id;
}

export async function runFixture(d: FixtureRunDeps): Promise<FixtureResult> {
  const { fixture } = d;
  const key = fixture.ticket.key;
  const grades: Grade[] = [];
  let spent = 0;
  let lastId: string | undefined;
  let stoppedAt: string | undefined;
  await mkdir(dirname(d.logPath), { recursive: true });

  for (let i = 1; i <= d.runs; i++) {
    if (d.signal?.aborted) {
      stoppedAt = `stopped before run ${i}: a signal was received`;
      d.log(`[fixture] ${stoppedAt}`);
      break;
    }
    const left = d.maxTotalUsd - spent;
    if (left <= 0) {
      stoppedAt = `stopped before run ${i}: $${spent.toFixed(2)} spent reaches --max-total $${d.maxTotalUsd}`;
      d.log(`[fixture] ${stoppedAt}`);
      break;
    }
    const runId = nextRunId(d.now, lastId);
    lastId = runId;
    const runDir = v2FixtureRunDir(fixture.name, key, runId);
    const abs = d.resolve(runDir);
    const started = d.now().toISOString();
    let pinned: Pinned | undefined;
    let line: FixtureRunLine;
    try {
      await mkdir(abs, { recursive: true });
      await writeFile(join(abs, "ticket.json"), JSON.stringify(fixture.ticket, null, 2) + "\n");
      pinned = await d.pin(runId);
      await writeFile(join(abs, "repo-head.json"), JSON.stringify({ project: fixture.repo.project, sha: pinned.sha }, null, 2) + "\n");
      const jira = new OutboxJiraClient(abs, key);
      const runSkill = d.makeRunSkill({ pinned, absRunDir: abs });
      // Wrapped so the grade sees the skill's raw verdict, before the loop maps or refuses it.
      let raw: string | undefined;
      let cost = 0;
      const entry = await runResearchPhase(
        { key, status: "To Do", assignee: null, labels: [] },
        {
          jira,
          view: roleView(d.config, "research"),
          runSkill: async (a) => {
            const r = await runSkill(a);
            raw = r.verdictRaw;
            cost = r.costUsd;
            return r;
          },
          runDir,
          maxBudgetUsd: Math.min(d.maxBudgetUsd, left),
          now: d.now,
          readFacts: (_rd, w, r) => readResearchFacts(abs, w, r),
        },
      );
      spent += entry.cost_usd;
      const verdict = parseVerdict(raw, "refine");
      const facts = await readResearchFacts(abs, 0, DEFAULT_COVERAGE_WARN_RUNS);
      const check = verdict.failure_category === "agent_error" ? ({ action: "accept" } as const) : checkResearchVerdict(verdict, facts);
      const grade = gradeRun(fixture.expect, { verdict, check, progressRaw: facts.progressRaw, manifest: facts.manifest, outbox: await readOutbox(abs), costUsd: cost });
      grades.push(grade);
      line = {
        fixture: fixture.name, ticket: key, run: i, run_dir: runDir, sha: pinned.sha, started, ended: d.now().toISOString(),
        outcome: entry.outcome, failure_category: entry.failure_category, loop_action: check.action,
        ...("check" in check && check.check ? { verdict_check: check.check } : {}),
        cost_usd: entry.cost_usd, pass: grade.pass, reasons: grade.reasons,
      };
    } catch (err) {
      const reason = `run failed: ${err instanceof Error ? err.message : String(err)}`;
      grades.push({ pass: false, reasons: [reason] });
      line = {
        fixture: fixture.name, ticket: key, run: i, run_dir: runDir, sha: pinned?.sha ?? fixture.repo.sha, started, ended: d.now().toISOString(),
        outcome: "error", failure_category: "agent_error", loop_action: "none", cost_usd: 0, pass: false, reasons: [reason],
      };
    } finally {
      await pinned?.remove();
    }
    await appendFile(d.logPath, JSON.stringify(line) + "\n");
    d.log(`[fixture] ${fixture.name} run ${i}/${d.runs}: ${line.outcome}${line.failure_category ? ` (${line.failure_category})` : ""}, ${line.pass ? "PASS" : "FAIL"}${line.reasons.length ? `: ${line.reasons.join("; ")}` : ""}`);
  }

  const agg = aggregate(fixture.expect, grades);
  return { ...agg, costUsd: spent, ...(stoppedAt ? { stoppedAt } : {}) };
}

/** What a run would do (the dry run). Nothing runs. */
export function planLines(f: Fixture, a: FixtureArgs, repoDir: string): string[] {
  const key = f.ticket.key;
  return [
    `fixture ${a.fixture}: ticket ${key} "${f.ticket.summary}", ${f.ticket.attachments.length} attachment(s), ${f.ticket.comments.length} comment(s)`,
    `pin: ${f.repo.project} at ${f.repo.sha}, worktree ${repoDir}/.claude/worktrees/${key}-<RUN_ID>-ground (detached; removed after each run)`,
    `runs: ${a.runs} run(s) in sequence, $${PER_RUN_BUDGET_USD} budget each, stop at $${a.maxTotalUsd} total`,
    `run dirs: .pipeline/v2/fixtures/${a.fixture}/${key}/research-<RUN_ID>; log runs/v2/fixtures/${a.fixture}.jsonl`,
    `spawn tools: ${FIXTURE_ALLOWED_TOOLS}; denied: ${FIXTURE_DENY.join(", ")}`,
    "spawn env: GH_TOKEN and GITHUB_TOKEN unset, GH_CONFIG_DIR empty, DEVLOOP_EVAL_KEYS=\"\" (every Atlassian write denied)",
    `grade: ${JSON.stringify(f.expect)}`,
    "dry run: nothing runs. Live needs DRY_RUN=0, outside Claude Code, and LIVE_ENABLED in src/eval/fixture-run.ts.",
  ];
}
