// The run watcher's pure model: v2 log records, session lock bodies and
// progress.jsonl lines in, `Run` objects out. No I/O here (read.ts reads the
// files; server.ts serves the result). Spec:
// docs/superpowers/specs/2026-11-20-run-watcher-design.md.

import { PROJECT_SLUG, RUN_ID, SESSION_ID, TICKET_KEY } from "../core/paths.ts";
import type { Role } from "../core/types.ts";

/** A live run with no progress line for this long is "quiet". */
export const QUIET_MS = 5 * 60_000;

/** Today's step lists, used when a SKILL.md can't be read (the server reads the real ones). */
export const FALLBACK_STEPS: Record<Role, string[]> = {
  research: ["triage", "interpret", "ground", "attack", "scope", "blocked-check", "synthesize", "verify"],
  dev: ["intake", "plan", "red", "green", "verify", "pr"],
};

/** The skill whose SKILL.md declares each role's steps. */
export const SKILL_OF: Record<Role, string> = { research: "ticket-refine", dev: "ticket-to-pr" };

export type FinishedStatus = "landed" | "bounced" | "error" | "killed" | "parked";
export type RunStatus = "running" | "quiet" | FinishedStatus;

export interface ProgressLine {
  /** Epoch ms. */
  ts: number;
  phase: string;
  event: string;
  detail: string;
}

export interface InFlightBody {
  ticket: string;
  role: Role;
  runDir: string;
  since: string;
  interrupted?: boolean;
}

export interface LockBody {
  pid: number;
  started: number;
  inFlight: InFlightBody | null;
}

export interface RunDirParts {
  project: string;
  session: string;
  ticket: string;
  phase: Role;
  runId: string;
}

/** One finished run, as the runs log records it (one phase entry, or a parked record's refused run). */
export interface FinishedSeed {
  project: string;
  ticket: string;
  session: string;
  phase: Role;
  outcome: FinishedStatus;
  started: number;
  ended: number;
  cost: number;
  detail: string;
  pr: string | null;
  runDir: string;
  phaseReached: string | null;
  failureCategory: string | null;
}

export interface StepState {
  name: string;
  k: "done" | "cur" | "skip" | "todo";
  /** On a finished run's end step: how it ended. */
  end?: FinishedStatus;
  /** On a live run's current step: no progress line for QUIET_MS. */
  quiet?: true;
}

export interface Run {
  /** The run dir (repo-relative); unique within a snapshot. */
  id: string;
  runDir: string;
  project: string;
  session: string;
  ticket: string;
  phase: Role;
  live: boolean;
  status: RunStatus;
  /** The step it is on (live) or ended on (finished); null when unknown. */
  at: string | null;
  track: StepState[];
  started: number;
  ended: number | null;
  /** Time of the latest progress line (null: none). */
  last: number | null;
  note: string;
  cost: number | null;
  pr: string | null;
  failureCategory: string | null;
  /** progress.jsonl line count. */
  lines: number;
  /** The run dir or its progress file is gone (reset, or cleaned by hand). */
  logGone: boolean;
}

export interface LogGroup {
  step: string;
  start: number;
  end: number;
  lines: ProgressLine[];
}

export interface ActivityLine extends ProgressLine {
  run: string;
}

const ROLES: readonly string[] = ["research", "dev"];
const FINISHED: readonly string[] = ["landed", "bounced", "error", "killed"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const time = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bare = (re: RegExp) => re.source.replace(/^\^/, "").replace(/\$$/, "");

/** Every parseable JSON line; blank, malformed and a truncated last line are skipped. */
export function parseJsonl(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const l of raw.split("\n")) {
    if (l.trim() === "") continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // malformed, or the loop is mid-append
    }
  }
  return out;
}

/** progress.jsonl lines with string ts/phase/event and a parseable ts. */
export function parseProgress(raw: string): ProgressLine[] {
  const out: ProgressLine[] = [];
  for (const v of parseJsonl(raw)) {
    if (!isObj(v)) continue;
    const ts = time(v.ts);
    const phase = str(v.phase);
    const event = str(v.event);
    if (ts === null || phase === null || event === null) continue;
    out.push({ ts, phase, event, detail: str(v.detail) ?? "" });
  }
  return out;
}

/** The phase names a SKILL.md declares in its progress-line format (`"phase": "a|b|c"`), or null. */
export function stepListFromSkill(md: string): string[] | null {
  const m = /"phase":\s*"([a-z][a-z-]*(?:\|[a-z][a-z-]*)+)"/.exec(md);
  return m ? m[1].split("|") : null;
}

/** The declared steps, then any other phase the run logged, in the order seen. */
export function stepsFor(declared: readonly string[], seen: readonly string[]): string[] {
  const out = [...declared];
  for (const s of seen) if (!out.includes(s)) out.push(s);
  return out;
}

const RUN_DIR_RE = new RegExp(
  `^\\.pipeline/v2/(${bare(PROJECT_SLUG)})/(${bare(SESSION_ID)})/(${bare(TICKET_KEY)})/(research|dev)-(${bare(RUN_ID)})$`,
);

/** Split a repo-relative v2 run dir; null for anything else (absolute, escaping, v1, malformed). */
export function parseRunDir(rel: string): RunDirParts | null {
  const m = RUN_DIR_RE.exec(rel);
  if (!m) return null;
  return { project: m[1], session: m[2], ticket: m[3], phase: m[4] as Role, runId: m[5] };
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** A session lock's body (same rules as src/core/session.ts); null when corrupt. */
export function parseLockBody(raw: string): LockBody | null {
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(b) || !posInt(b.pid) || !posInt(b.started)) return null;
  if (b.inFlight === null || b.inFlight === undefined) return { pid: b.pid, started: b.started, inFlight: null };
  const f = b.inFlight;
  if (
    !isObj(f) ||
    typeof f.ticket !== "string" ||
    !TICKET_KEY.test(f.ticket) ||
    typeof f.role !== "string" ||
    !ROLES.includes(f.role) ||
    typeof f.runDir !== "string" ||
    typeof f.since !== "string" ||
    (f.interrupted !== undefined && typeof f.interrupted !== "boolean")
  ) {
    return null;
  }
  const inFlight: InFlightBody = { ticket: f.ticket, role: f.role as Role, runDir: f.runDir, since: f.since };
  if (f.interrupted !== undefined) inFlight.interrupted = f.interrupted as boolean;
  return { pid: b.pid, started: b.started, inFlight };
}

/** One seed per usable phase entry, plus each parked record's refused run. Phase-less records give none. */
export function seedsFromRecords(project: string, records: readonly unknown[]): FinishedSeed[] {
  const out: FinishedSeed[] = [];
  for (const r of records) {
    if (!isObj(r) || typeof r.ticket !== "string" || !TICKET_KEY.test(r.ticket)) continue;
    const session = str(r.session) ?? "";
    for (const p of Array.isArray(r.phases) ? r.phases : []) {
      if (!isObj(p)) continue;
      const started = time(p.started);
      const ended = time(p.ended);
      const runDir = str(p.run_dir);
      if (typeof p.role !== "string" || !ROLES.includes(p.role) || typeof p.outcome !== "string" || !FINISHED.includes(p.outcome)) continue;
      if (started === null || ended === null || runDir === null) continue;
      out.push({
        project, ticket: r.ticket, session, phase: p.role as Role, outcome: p.outcome as FinishedStatus, started, ended,
        cost: num(p.cost_usd), detail: str(p.detail) ?? "", pr: str(p.pr), runDir,
        phaseReached: str(p.phase_reached), failureCategory: str(p.failure_category),
      });
    }
    if (r.outcome === "parked" && isObj(r.parked)) {
      const k = r.parked;
      const started = time(r.started);
      const ended = time(r.ended);
      const runDir = str(k.run_dir);
      if (typeof k.role !== "string" || !ROLES.includes(k.role) || started === null || ended === null || runDir === null) continue;
      out.push({
        project, ticket: r.ticket, session, phase: k.role as Role, outcome: "parked", started, ended,
        cost: num(k.cost_usd), detail: str(r.detail) ?? "", pr: null, runDir,
        phaseReached: null, failureCategory: str(k.failure_category),
      });
    }
  }
  return out;
}

/** The furthest step any line names (by position in `steps`), or null. */
function furthest(steps: readonly string[], lines: readonly ProgressLine[]): string | null {
  let at = -1;
  for (const l of lines) at = Math.max(at, steps.indexOf(l.phase));
  return at >= 0 ? steps[at] : null;
}

/**
 * Where a finished run ended: its result line's step, else the furthest step it
 * logged, else (no log) the record's phase_reached when that names a step.
 */
export function endedStep(steps: readonly string[], lines: readonly ProgressLine[] | null, phaseReached: string | null): string | null {
  if (lines && lines.length > 0) {
    const result = lines.filter((l) => l.event === "result").at(-1);
    if (result && steps.includes(result.phase)) return result.phase;
    const f = furthest(steps, lines);
    if (f) return f;
  }
  return phaseReached !== null && steps.includes(phaseReached) ? phaseReached : null;
}

/** How each step stands for a run at `at` with `status`. */
export function stepStates(steps: readonly string[], at: string | null, status: RunStatus): StepState[] {
  if (status === "landed") return steps.map((name) => ({ name, k: "done" }));
  const live = status === "running" || status === "quiet";
  const i = at === null ? -1 : steps.indexOf(at);
  return steps.map((name, j): StepState => {
    if (i < 0) return { name, k: live ? "todo" : "skip" };
    if (j < i) return { name, k: "done" };
    if (j > i) return { name, k: live ? "todo" : "skip" };
    if (live) return status === "quiet" ? { name, k: "cur", quiet: true } : { name, k: "cur" };
    return { name, k: "cur", end: status as FinishedStatus };
  });
}

/** `url` if it is an https://github.com/ link, else null (the page only links those). */
export function githubUrl(url: string | null): string | null {
  return url !== null && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/[^\s"'<>]*$/.test(url) ? url : null;
}

/** A finished run. `lines` is null when its progress file is gone. */
export function buildFinishedRun(seed: FinishedSeed, lines: ProgressLine[] | null, declared: readonly string[]): Run {
  const steps = stepsFor(declared, (lines ?? []).map((l) => l.phase));
  const at = endedStep(steps, lines, seed.phaseReached);
  return {
    id: seed.runDir, runDir: seed.runDir, project: seed.project, session: seed.session, ticket: seed.ticket, phase: seed.phase,
    live: false, status: seed.outcome, at, track: stepStates(steps, at, seed.outcome),
    started: seed.started, ended: seed.ended, last: lines?.at(-1)?.ts ?? null,
    note: seed.detail, cost: seed.cost, pr: githubUrl(seed.pr), failureCategory: seed.failureCategory,
    lines: lines?.length ?? 0, logGone: lines === null,
  };
}

/** A live run from a lock's inFlight. `lines` is null when no progress file exists yet. */
export function buildLiveRun(
  project: string,
  session: string,
  flight: InFlightBody,
  lines: ProgressLine[] | null,
  declared: readonly string[],
  now: number,
): Run {
  const ls = lines ?? [];
  const steps = stepsFor(declared, ls.map((l) => l.phase));
  const started = time(flight.since) ?? now;
  const last = ls.at(-1)?.ts ?? null;
  const status: RunStatus = now - (last ?? started) > QUIET_MS ? "quiet" : "running";
  const at = furthest(steps, ls);
  return {
    id: flight.runDir, runDir: flight.runDir, project, session, ticket: flight.ticket, phase: flight.role,
    live: true, status, at, track: stepStates(steps, at, status),
    started, ended: null, last,
    note: ls.at(-1)?.detail ?? "Started; no progress line yet.", cost: null, pr: null, failureCategory: null,
    lines: ls.length, logGone: false,
  };
}

/** Consecutive lines grouped by step; each group lasts until the next starts (the last until `endTs`). */
export function groupLog(lines: readonly ProgressLine[], endTs: number): LogGroup[] {
  const groups: LogGroup[] = [];
  for (const l of lines) {
    const g = groups.at(-1);
    if (g && g.step === l.phase) g.lines.push(l);
    else groups.push({ step: l.phase, start: l.ts, end: l.ts, lines: [l] });
  }
  groups.forEach((g, i) => {
    g.end = Math.max(g.start, groups[i + 1]?.start ?? endTs);
  });
  return groups;
}

/** Every line newer than `cutoff`, newest first, tagged with its run id; at most `cap`. */
export function activityFrom(runs: ReadonlyArray<{ id: string; lines: readonly ProgressLine[] }>, cutoff: number, cap = 500): ActivityLine[] {
  return runs
    .flatMap((r) => r.lines.filter((l) => l.ts > cutoff).map((l) => ({ run: r.id, ...l })))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, cap);
}
