// The v2 per-ticket-iteration log: one append-only JSONL line per queue
// iteration (runs/v2/<project>.jsonl), plus readers, counters and the
// landed-PR lookups that span the v1 and v2 log generations.

import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { redactSensitive } from "./redact.ts";
import { resolveRepoPath, SESSION_ID, TICKET_KEY, v1PreCutoverRunsLog, v1RunsLog, v2RunsLog } from "./paths.ts";
import type { SandboxDenial } from "../sandbox/types.ts";
import type { DiffStats } from "./diff-stats.ts";
import type { FailureCategory, FollowUp, PhaseReached, Role, RunOutcome, SizeEvidence, SizeTrajectory, TShirtSize } from "./types.ts";

/** Which sandbox a run went through (spec §6). Instance names carry no PII, so they are logged as-is. */
export interface RunSandboxMeta {
  adapter: string;
  instance: string;
  prepare_ms: number;
  /** Discover mode only, when the sandbox refused something but the run carried on. Targets redacted. */
  denied?: SandboxDenial[];
  /** Discover mode only, with `denied`: the adapter's allow hint (redacted). */
  approveHint?: string;
}

export interface PhaseEntry {
  role: Role;
  skill: "ticket-refine" | "ticket-to-pr";
  skill_version: string;
  model: string;
  started: string;
  ended: string;
  outcome: RunOutcome;
  phase_reached: PhaseReached;
  cost_usd: number;
  tokens: { in: number; out: number };
  failure_category: FailureCategory | null;
  detail: string;
  pr: string | null;
  run_dir: string;
  red_confirmed?: boolean;
  verify_loops?: number;
  retries?: number;
  size_trajectory?: SizeTrajectory;
  /** Research entries: the verdict's size_estimate (every outcome) and ac_count, when reported. */
  size_estimate?: TShirtSize;
  ac_count?: number;
  /** Research too_large entries: the evidence the loop accepted. */
  size_evidence?: SizeEvidence;
  /** Research entries the loop's verdict check acted on (refused, warned, or loop-bounced). See roles/research/verdict-checks.ts. */
  verdict_check?: "too_large_ungrounded" | "too_large_no_evidence" | "coverage_missing" | "coverage_warned" | "attachment_unreadable";
  /** Dev entries: tests that also fail on the unmodified base branch (Ruling 29). */
  preexisting_failures?: string[];
  /** Dev entries: the follow-up ticket filed for them, and its fix PR (Ruling 30). */
  follow_up?: FollowUp;
  /** Dev entries with outcome landed: the PR's size from GitHub (absent when it could not be read). */
  diff_stats?: DiffStats;
  /** Research entries with outcome landed only. */
  handoff?: "done" | "skipped-ceiling" | "failed";
  jira_sync_error?: string;
  /** Set only when the run went through a sandbox adapter. */
  sandbox?: RunSandboxMeta;
}

export type IterationOutcome =
  | "landed"
  | "bounced"
  | "error"
  | "killed"
  | "skipped-blocked"
  | "claim-error"
  | "handoff-pending"
  | "skipped-pr-exists"
  | "blocked-attempts"
  /** Step 1 completed a pending research -> dev label handoff (phases: []). */
  | "handoff-done"
  /** A phase run stopped by SIGINT/SIGTERM; not a failed attempt (phases: [], resume set). */
  | "interrupted"
  /** A pending resume whose ticket left <claimStatus.to>; phases: [], no resume (resolves the pending one), not an attempt. */
  | "resume-dropped"
  /** A phase run an enforcing sandbox refused (phases: [], resume set, not an attempt); the poll skips it until cleared. */
  | "parked"
  /** Written by `sandbox:approvals --clear`: resolves a park (phases: [], resume copied from it, so it re-runs). */
  | "unparked"
  /** Step 1 found a pending handoff's ticket in Jira's Done category: no swap, no dev (phases: []). Resolves the pending handoff. */
  | "handoff-dropped";

/** The refused run behind a "parked" record. */
export interface ParkedRun {
  role: Role;
  failure_category: "sandbox_denied";
  denied: SandboxDenial[];
  approveHint?: string;
  /** Measured cost of the refused run (it is not in `phases`). */
  cost_usd: number;
  run_dir: string;
  /** Set only when the run went through a sandbox adapter. */
  sandbox?: RunSandboxMeta;
}

export interface IterationRecord {
  ticket: string;
  session: string;
  loop_version: string;
  started: string;
  ended: string;
  outcome: IterationOutcome;
  phases: PhaseEntry[];
  blocked_by?: string[];
  /**
   * Set when this ticket has a phase run of this role to resume (a crashed or
   * interrupted in-flight run, or a claim whose phase never started). The
   * ticket's latest record carrying it means "pending"; any later record
   * resolves it. Only a process that runs this role resumes it.
   */
  resume?: Role;
  detail?: string;
  jira_sync_error?: string;
  /** Set when this iteration changed the ticket's Jira status (claim or transition); only such records hold the ticket back for the recent window. */
  jira_status_changed?: true;
  /** Outcome "parked" only: what the sandbox refused. */
  parked?: ParkedRun;
}

/** A landed ticket with its PR, from whichever log generation recorded it. */
export interface LandedTicket {
  ticket: string;
  pr: string;
  source: "v1" | "v2";
  ended: string;
}

function redactOpt(s: string | undefined): string | undefined {
  return s === undefined ? undefined : redactSensitive(s);
}

function redactSandboxMeta(m: RunSandboxMeta): RunSandboxMeta {
  const { denied, approveHint, ...rest } = m;
  return {
    ...rest,
    ...(denied !== undefined ? { denied: denied.map((d) => ({ ...d, target: redactSensitive(d.target) })) } : {}),
    ...(approveHint !== undefined ? { approveHint: redactSensitive(approveHint) } : {}),
  };
}

/** Append one JSON line (single appendFile call). Validates ticket/session; redacts free text. */
export async function appendIteration(path: string, rec: IterationRecord): Promise<void> {
  if (typeof rec.ticket !== "string" || !TICKET_KEY.test(rec.ticket)) {
    throw new Error(`appendIteration: invalid ticket ${JSON.stringify(rec.ticket)}`);
  }
  if (typeof rec.session !== "string" || !SESSION_ID.test(rec.session)) {
    throw new Error(`appendIteration: invalid session ${JSON.stringify(rec.session)}`);
  }
  const out: IterationRecord = {
    ...rec,
    phases: rec.phases.map((p) => {
      const q: PhaseEntry = { ...p, detail: redactSensitive(p.detail) };
      if (p.jira_sync_error !== undefined) q.jira_sync_error = redactSensitive(p.jira_sync_error);
      if (p.sandbox !== undefined) q.sandbox = redactSandboxMeta(p.sandbox);
      return q;
    }),
  };
  if (rec.detail !== undefined) out.detail = redactOpt(rec.detail);
  if (rec.jira_sync_error !== undefined) out.jira_sync_error = redactOpt(rec.jira_sync_error);
  if (rec.parked !== undefined) {
    const { approveHint, ...rest } = rec.parked;
    out.parked = {
      ...rest,
      denied: rec.parked.denied.map((d) => ({ ...d, target: redactSensitive(d.target) })),
      ...(approveHint !== undefined ? { approveHint: redactSensitive(approveHint) } : {}),
    };
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(out)}\n`, "utf8");
}

/** Like readIterations, but also reports how many non-blank lines were skipped as unusable. */
export async function readIterationsDetailed(path: string): Promise<{ records: IterationRecord[]; skipped: number }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 };
    throw e;
  }
  const records: IterationRecord[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++; // malformed, or a truncated final line from a crash mid-append
      continue;
    }
    const r = parsed as Partial<IterationRecord> | null;
    if (!r || typeof r !== "object" || typeof r.ticket !== "string" || !TICKET_KEY.test(r.ticket)) {
      skipped++;
      continue;
    }
    records.push({ ...(r as IterationRecord), phases: Array.isArray(r.phases) ? r.phases : [] });
  }
  return { records, skipped };
}

/** All usable records in file order; missing file -> []. Never throws on bad lines. */
export async function readIterations(path: string): Promise<IterationRecord[]> {
  return (await readIterationsDetailed(path)).records;
}

/** Phase entries of `role` whose `started` is on now's UTC day. */
export async function countPhaseRunsToday(path: string, role: Role, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  let n = 0;
  for (const r of await readIterations(path)) {
    for (const p of r.phases) if (p.role === role && p.started.slice(0, 10) === day) n++;
  }
  return n;
}

export function hasLandedPhase(records: IterationRecord[], ticket: string, role: Role): boolean {
  return records.some((r) => r.ticket === ticket && r.phases.some((p) => p.role === role && p.outcome === "landed"));
}

/** error/killed entries of `role` since the ticket's last landed/bounced entry of that role (chronological). */
export function failedAttempts(records: IterationRecord[], ticket: string, role: Role): number {
  const entries = records
    .filter((r) => r.ticket === ticket)
    .flatMap((r) => r.phases)
    .filter((p) => p.role === role)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.started < b.p.started ? -1 : a.p.started > b.p.started ? 1 : a.i - b.i));
  let n = 0;
  for (const { p } of entries) {
    if (p.outcome === "landed" || p.outcome === "bounced") n = 0;
    else if (p.outcome === "error" || p.outcome === "killed") n++;
  }
  return n;
}

/** How long after a Jira status change a ticket is held (Jira's search-index lag). */
export const DEFAULT_RECENT_WINDOW_MS = 120_000;

/**
 * Tickets held back by a record that changed their Jira status and ended
 * within windowMs of now, with ms since that (latest) record ended. The window
 * covers Jira's search-index lag after a status write; other records wrote
 * no status, so they hold nothing.
 */
export function recentlyEnded(records: IterationRecord[], now: Date, windowMs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    if (r.jira_status_changed !== true) continue;
    const t = Date.parse(r.ended);
    if (Number.isNaN(t)) continue;
    const age = now.getTime() - t;
    if (age > windowMs) continue;
    const prev = out.get(r.ticket);
    if (prev === undefined || age < prev) out.set(r.ticket, age);
  }
  return out;
}

/** blocked_by of the ticket's latest record (by ended) if it is skipped-blocked, else null. */
export function lastSkipBlockers(records: IterationRecord[], ticket: string): string[] | null {
  let latest: IterationRecord | null = null;
  for (const r of records) {
    if (r.ticket === ticket && (latest === null || r.ended >= latest.ended)) latest = r;
  }
  return latest && latest.outcome === "skipped-blocked" ? (latest.blocked_by ?? []) : null;
}

// ---- landed lookups across log generations ----

function abs(rel: string, root?: string): string {
  return root === undefined ? resolveRepoPath(rel) : resolve(root, rel);
}

async function v2Landed(slug: string, root?: string): Promise<Map<string, LandedTicket>> {
  const latest = new Map<string, LandedTicket>();
  for (const r of await readIterations(abs(v2RunsLog(slug), root))) {
    for (const p of r.phases) {
      if (p.role !== "dev" || p.outcome !== "landed" || !p.pr) continue;
      const prev = latest.get(r.ticket);
      if (!prev || r.ended >= prev.ended) latest.set(r.ticket, { ticket: r.ticket, pr: p.pr, source: "v2", ended: r.ended });
    }
  }
  return latest;
}

/** Which v1 log a reader used: the post-cutover archive or the pre-cutover live log. */
export interface V1LogLocation {
  path: string;
  layout: "post-cutover" | "pre-cutover";
}

/**
 * The role's v1 log: runs/v1/<role>/<slug>.jsonl when it exists, else the
 * pre-cutover live log (dev: runs/<slug>.jsonl, research:
 * research-loop/runs/<slug>.jsonl), else null. Never both: once the
 * post-cutover file exists it is the whole v1 history.
 */
export async function resolveV1RunsLog(role: Role, slug: string, root?: string): Promise<V1LogLocation | null> {
  const candidates: Array<[string, V1LogLocation["layout"]]> = [
    [abs(v1RunsLog(role, slug), root), "post-cutover"],
    [abs(v1PreCutoverRunsLog(role, slug), root), "pre-cutover"],
  ];
  for (const [path, layout] of candidates) {
    try {
      await access(path);
      return { path, layout };
    } catch {
      /* try the next layout */
    }
  }
  return null;
}

interface V1Line {
  ticket: string;
  outcome: unknown;
  pr: string | null;
  ended: string;
}

/** Usable v1 lines of the role's resolved v1 log, in file order; bad lines skipped; no log -> []. */
async function readV1(role: Role, slug: string, root?: string): Promise<V1Line[]> {
  const loc = await resolveV1RunsLog(role, slug, root);
  if (!loc) return [];
  let raw: string;
  try {
    raw = await readFile(loc.path, "utf8");
  } catch {
    return [];
  }
  const out: V1Line[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const l = JSON.parse(line) as { ticket?: unknown; outcome?: unknown; pr?: unknown; ended?: unknown };
      if (typeof l.ticket !== "string" || !TICKET_KEY.test(l.ticket)) continue;
      out.push({
        ticket: l.ticket,
        outcome: l.outcome,
        pr: typeof l.pr === "string" && l.pr ? l.pr : null,
        ended: typeof l.ended === "string" ? l.ended : "",
      });
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

async function v1Landed(slug: string, root?: string): Promise<Map<string, LandedTicket>> {
  const latest = new Map<string, LandedTicket>();
  for (const l of await readV1("dev", slug, root)) {
    if (l.outcome === "landed" && l.pr) latest.set(l.ticket, { ticket: l.ticket, pr: l.pr, source: "v1", ended: l.ended });
  }
  return latest;
}

/** True if the role's v1 log (either layout) has a landed line for the ticket. */
export async function hasLandedV1(role: Role, slug: string, ticketKey: string, root?: string): Promise<boolean> {
  return (await readV1(role, slug, root)).some((l) => l.ticket === ticketKey && l.outcome === "landed");
}

/**
 * The ticket's most recently recorded PR from a landed or bounced run (any
 * PR it ever opened, for reset's --close-remote): the v2 log first (dev
 * phases), else the v1 dev log. null if none.
 */
export async function findRecordedPrUrlAcross(slug: string, ticketKey: string, root?: string): Promise<string | null> {
  let v2: string | null = null;
  for (const r of await readIterations(abs(v2RunsLog(slug), root))) {
    if (r.ticket !== ticketKey) continue;
    for (const p of r.phases) {
      if (p.role === "dev" && (p.outcome === "landed" || p.outcome === "bounced") && p.pr) v2 = p.pr;
    }
  }
  if (v2) return v2;
  let v1: string | null = null;
  for (const l of await readV1("dev", slug, root)) {
    if (l.ticket === ticketKey && (l.outcome === "landed" || l.outcome === "bounced") && l.pr) v1 = l.pr;
  }
  return v1;
}

/** Latest landed dev PR for the ticket: v2 first, else the v1 dev log (resolveV1RunsLog). */
export async function findLandedPrUrlAcross(slug: string, ticketKey: string, root?: string): Promise<string | null> {
  return (await v2Landed(slug, root)).get(ticketKey)?.pr ?? (await v1Landed(slug, root)).get(ticketKey)?.pr ?? null;
}

/** Union of landed tickets, de-duped by ticket; v2 wins. */
export async function findLandedTicketsAcross(slug: string, root?: string): Promise<LandedTicket[]> {
  const merged = await v1Landed(slug, root);
  for (const [k, v] of await v2Landed(slug, root)) merged.set(k, v);
  return [...merged.values()];
}
