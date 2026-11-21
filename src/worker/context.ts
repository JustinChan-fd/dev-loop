// WorkerDeps and the per-iteration context shared by the worker-cycle steps
// (cycle.ts, recover.ts, handoff.ts, attempts.ts).

import type { JiraClient, JiraTicket } from "../core/jira-client.ts";
import type { ExecGhFindMergedPrFn, ExecGhPrViewFn, GitHubClient } from "../core/github-client.ts";
import type { HostPushResult } from "./host-push.ts";
import type { Config, ReadyToPush, DevView, ResearchView, Role } from "../core/types.ts";
import type { InFlight, Session } from "../core/session.ts";
import type { IterationOutcome, IterationRecord, PhaseEntry } from "../core/iteration-log.ts";
import { appendIteration } from "../core/iteration-log.ts";
import type { PrDiffStatsFn } from "../core/diff-stats.ts";
import type { RunSkillFn } from "../core/run-skill.ts";
import { roleView } from "../core/config.ts";
import { redactSensitive } from "../core/redact.ts";

export interface WorkerGateDeps {
  /** Latest landed dev PR URL for a key (findLandedPrUrlAcross with the slug bound). Also feeds the dev landed guard. */
  findLandedPrUrl: (key: string) => Promise<string | null>;
  execGhPrView: ExecGhPrViewFn;
  execGhFindMergedPr: ExecGhFindMergedPrFn;
  /** Process-lifetime cache of cleared blockers (see blocker-gate.ts). */
  mergedCache: Map<string, string>;
}

export interface WorkerDeps {
  jira: JiraClient;
  github: GitHubClient;
  config: Config;
  /** Project slug (PROJECT_SLUG): names v2RunDir paths. */
  slug: string;
  /** The acquireSession handle. */
  session: Pick<Session, "name" | "inFlight" | "orphanedInFlight" | "setInFlight">;
  loopVersion: string;
  runSkill: RunSkillFn;
  /** Absolute path of the v2 iteration log (resolveRepoPath(v2RunsLog(slug)) in production). */
  logPath: string;
  now: () => Date;
  assigneeAccountId: string;
  /** Blocker-gate deps; repo and default branch come from config. */
  gate: WorkerGateDeps;
  /** Open PR for a ticket, for crash recovery (realFindOpenPrUrl in production). */
  findOpenPrUrl: (key: string) => Promise<string | null>;
  /** Tickets whose latest status-changing record ended this recently are not polled (Jira index lag). Default 120 000. */
  recentWindowMs?: number;
  /** Which roles this process runs. Default both (worker mode); `--phase research|dev` passes one. */
  roles?: Role[];
  /** v1 research "landed" lookup (the research log the v1 runner wrote), so a v1-refined ticket is never re-refined. */
  hasLandedResearchV1?: (key: string) => Promise<boolean>;
  /** Desktop notification (notify() from core/notify.ts in production); fire-and-forget. */
  notify?: (title: string, body: string) => void;
  /** Signs and pushes a ready_to_push dev run on the host. Absent unless the sandbox asks for it. */
  hostPush?: (ticketKey: string, runDir: string, ready: ReadyToPush) => Promise<HostPushResult>;
  /** Reads a landed PR's size for the dev entry (realPrDiffStats in production). */
  prDiffStats?: PrDiffStatsFn;
  log?: (message: string) => void;
}

export type WorkerIterationResult =
  | { kind: "idle" }
  | { kind: "did"; record: IterationRecord }
  | { kind: "paused"; reason: string; record?: IterationRecord };

/** Process-lifetime state, keyed by the session handle (one per process). */
export interface WorkerState {
  /** In-flight runs adopted from the lock, recorded to the log on the first iteration: the adopted one first, then orphans. */
  flights: InFlight[];
  /** Untrusted poll keys already logged as invalid. */
  badKeys: Set<string>;
  /** Issue ids of polled tickets with an invalid key: excluded from every poll by id. */
  badIds: Set<string>;
  /** The adopted flights are in the log (recordAdoptedFlights ran). */
  flightsRecorded: boolean;
  /** A self-heal done while recording flights, returned by the next iteration. */
  healed: WorkerIterationResult | null;
  /** Tickets whose Jira status this process changed since their last record; append() flags the record and clears it. */
  statusChanged: Set<string>;
}

const STATES = new WeakMap<object, WorkerState>();

export function workerState(deps: WorkerDeps): { state: WorkerState; first: boolean } {
  let state = STATES.get(deps.session);
  if (state) return { state, first: false };
  const flights = [...(deps.session.inFlight ? [deps.session.inFlight] : []), ...deps.session.orphanedInFlight];
  state = { flights, badKeys: new Set(), badIds: new Set(), flightsRecorded: false, healed: null, statusChanged: new Set() };
  STATES.set(deps.session, state);
  return { state, first: true };
}

/** Max candidates skipped (blocked, landed, raced, claim-error, invalid) in one iteration before returning idle. */
export const MAX_SKIPS = 20;

export interface Ctx {
  deps: WorkerDeps;
  state: WorkerState;
  /** The log, read once at the start of the iteration; append() keeps it current. */
  records: IterationRecord[];
  research: ResearchView;
  dev: DevView;
  roles: Set<Role>;
  log: (message: string) => void;
  /** Keys excluded from every poll this iteration (recentlyEnded ∪ attempt-capped ∪ skipped). */
  exclude: Set<string>;
  skips: number;
  /** Tickets whose handoff step 1 just completed: dev candidates ahead of the poll. */
  handedOff: string[];
}

/** The Jira client, noting every ticket whose status a call changed (successful claim or transition). */
function trackStatusChanges(jira: JiraClient, changed: Set<string>): JiraClient {
  return new Proxy(jira, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (prop === "claimTicket") {
        return async (...a: unknown[]) => {
          const ok = await fn.apply(target, a);
          if (ok === true) changed.add(a[0] as string);
          return ok;
        };
      }
      if (prop === "transitionStatus") {
        return async (...a: unknown[]) => {
          await fn.apply(target, a);
          changed.add(a[0] as string);
        };
      }
      void receiver;
      return fn.bind(target);
    },
  });
}

export function makeCtx(deps: WorkerDeps, state: WorkerState, records: IterationRecord[]): Ctx {
  return {
    deps: { ...deps, jira: trackStatusChanges(deps.jira, state.statusChanged) },
    state,
    records,
    research: roleView(deps.config, "research"),
    dev: roleView(deps.config, "dev"),
    roles: new Set(deps.roles ?? ["research", "dev"]),
    log: deps.log ?? ((m) => console.log(redactSensitive(m))),
    exclude: new Set(),
    skips: 0,
    handedOff: [],
  };
}

export const nowIso = (ctx: Ctx): string => ctx.deps.now().toISOString();

/** Build, append (one line) and remember a record. */
export async function append(
  ctx: Ctx,
  ticket: string,
  started: string,
  outcome: IterationOutcome,
  phases: PhaseEntry[],
  extra: Partial<Pick<IterationRecord, "blocked_by" | "detail" | "jira_sync_error" | "resume" | "parked">> = {},
): Promise<IterationRecord> {
  const rec: IterationRecord = {
    ticket,
    session: ctx.deps.session.name,
    loop_version: ctx.deps.loopVersion,
    started,
    ended: nowIso(ctx),
    outcome,
    phases,
    ...extra,
    ...(ctx.state.statusChanged.delete(ticket) ? { jira_status_changed: true as const } : {}),
  };
  await appendIteration(ctx.deps.logPath, rec);
  ctx.records.push(rec);
  return rec;
}

/** Phase runs of `role` started on now's UTC day, from the in-memory log. */
export function runsToday(ctx: Ctx, role: Role): number {
  const day = nowIso(ctx).slice(0, 10);
  let n = 0;
  for (const r of ctx.records) for (const p of r.phases) if (p.role === role && p.started.slice(0, 10) === day) n++;
  return n;
}

export function roleCapped(ctx: Ctx, role: Role): boolean {
  const view = role === "research" ? ctx.research : ctx.dev;
  return runsToday(ctx, role) >= view.limits.maxRunsPerDay;
}

/** Latest record for a ticket by `ended` (file order breaks ties). */
export function latestRecord(records: IterationRecord[], ticket: string): IterationRecord | null {
  let latest: IterationRecord | null = null;
  for (const r of records) if (r.ticket === ticket && (latest === null || r.ended >= latest.ended)) latest = r;
  return latest;
}

/** A ticket the worker didn't poll (recovery, step-1 handoff): status is where the claim left it. */
export function knownTicket(ctx: Ctx, key: string, labels: string[]): JiraTicket {
  return { key, status: ctx.research.claimStatus.to, assignee: null, labels };
}

/** The PhaseEntry for a run lost to a crash (counted as a failed attempt). */
export function crashEntry(ctx: Ctx, f: InFlight, why: string): PhaseEntry {
  return {
    role: f.role,
    skill: f.role === "research" ? "ticket-refine" : "ticket-to-pr",
    skill_version: "",
    model: "",
    started: f.since,
    ended: nowIso(ctx),
    outcome: "error",
    phase_reached: "intake",
    cost_usd: 0,
    tokens: { in: 0, out: 0 },
    failure_category: "agent_error",
    detail: why,
    pr: null,
    run_dir: f.runDir,
  };
}
