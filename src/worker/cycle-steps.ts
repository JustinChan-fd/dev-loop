// The building blocks of one worker iteration: polling a role's next
// candidate (key validation, landed guards, blocker gate, skip budget),
// running one phase with in-flight bookkeeping, the Ruling 16 budgets and the
// post-phase ceiling check. cycle.ts sequences them.

import { ClaimMissingFieldsError, type JiraTicket } from "../core/jira-client.ts";
import type { Role } from "../core/types.ts";
import type { PhaseEntry } from "../core/iteration-log.ts";
import { hasLandedPhase, lastSkipBlockers } from "../core/iteration-log.ts";
import { buildPollJql, excludeIdsFromJql, excludeKeysFromJql, isIssueId } from "../core/jql.ts";
import { gateTicket } from "../core/blocker-gate.ts";
import { checkCeilings } from "../core/ceilings.ts";
import { TICKET_KEY, runIdNow, v2RunDir } from "../core/paths.ts";
import { durationMin, errorMessage, type RunSkillFn, type RunSkillResult } from "../core/run-skill.ts";
import { runResearchPhase } from "../roles/research/phase.ts";
import { runDevPhase } from "../roles/dev/phase.ts";
import { append, latestRecord, MAX_SKIPS, nowIso, type Ctx } from "./context.ts";

/** A Jira error that would fail every ticket (auth/permission): the worker pauses. */
export class WorkerPausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerPausedError";
  }
}

const AUTH_ERROR = /->\s*(401|403)\b/;

/** Poll; an auth failure pauses the worker, any other poll failure ends the iteration idle (retried next poll). */
async function poll(ctx: Ctx, role: Role): Promise<JiraTicket | null | "error"> {
  const view = role === "research" ? ctx.research : ctx.dev;
  const jql = excludeIdsFromJql(
    excludeKeysFromJql(buildPollJql(view, { assigneeAccountId: ctx.deps.assigneeAccountId }), [...ctx.exclude]),
    [...ctx.state.badIds],
  );
  try {
    return await ctx.deps.jira.pollOldestMatching(jql);
  } catch (err) {
    const message = errorMessage(err);
    if (AUTH_ERROR.test(message)) throw new WorkerPausedError(`Jira ${role} poll failed (auth): ${message}`);
    ctx.log(`[worker] ${role} poll failed, will retry next iteration: ${message}`);
    return "error";
  }
}

function skip(ctx: Ctx, key: string, why: string): void {
  ctx.exclude.add(key);
  ctx.skips++;
  ctx.log(`[worker] ${key}: skipped, ${why}`);
}

/** Why a dev candidate must not run (its recorded landed PR is merged, still open, or unreadable), or null. */
export async function landedSkipReason(ctx: Ctx, key: string): Promise<string | null> {
  const prUrl = await ctx.deps.gate.findLandedPrUrl(key);
  if (!prUrl) return null;
  try {
    const status = JSON.parse(await ctx.deps.gate.execGhPrView(prUrl)) as { state?: string; mergedAt?: string | null };
    if (status.mergedAt) return `already landed, PR merged (${prUrl})`;
    if (status.state === "OPEN") return `already landed, PR still open (${prUrl})`;
    return null;
  } catch (err) {
    return `already landed (${prUrl}) but its PR state could not be read: ${errorMessage(err)}`;
  }
}

/** Blocker gate; appends "skipped-blocked" only when the blocker set changed since the last skip. True = passes. */
async function gate(ctx: Ctx, key: string): Promise<boolean> {
  const { config } = ctx.deps;
  const g = await gateTicket(key, {
    ...ctx.deps.gate,
    repo: config.github.repo,
    defaultBranch: config.targetRepo.defaultBranch,
    jira: ctx.deps.jira,
    clearedStatuses: config.jira.blockerClearedStatuses,
  });
  if (g.pass) return true;
  const prev = lastSkipBlockers(ctx.records, key);
  const same = prev !== null && prev.length === g.blockedBy.length && prev.every((k, i) => k === g.blockedBy[i]);
  if (!same) {
    await append(ctx, key, nowIso(ctx), "skipped-blocked", [], { blocked_by: g.blockedBy, detail: g.reasons.join("; ") });
  }
  skip(ctx, key, `blocked: ${g.reasons.join("; ")}`);
  return false;
}

/**
 * A polled ticket whose key fails TICKET_KEY: logged once per process and
 * excluded from every later poll by its numeric issue id. True = excluded, so
 * the caller re-polls; false = the id is unusable too, and the role's poll
 * stops for this iteration (nothing safe to exclude it by).
 */
function badKey(ctx: Ctx, t: JiraTicket): boolean {
  const k = String(t.key).slice(0, 60);
  if (!ctx.state.badKeys.has(k)) {
    ctx.state.badKeys.add(k);
    ctx.log(`[worker] invalid ticket key from the poll, skipped: ${JSON.stringify(k)} (id ${JSON.stringify(String(t.id).slice(0, 20))})`);
  }
  if (!isIssueId(t.id)) return false;
  ctx.state.badIds.add(t.id);
  ctx.skips++;
  return true;
}

/** A dev candidate; `polled` = it came from the dev poll (so its assignee is known). */
export interface DevCandidate {
  ticket: JiraTicket;
  polled: boolean;
}

/** Step 3's candidate: step-1 handoffs first, then the dev poll; landed guard + gate. No claim. */
export async function nextDevCandidate(ctx: Ctx): Promise<DevCandidate | null> {
  const queue = ctx.handedOff.filter((k) => !ctx.exclude.has(k));
  for (;;) {
    if (ctx.skips >= MAX_SKIPS) return null;
    let t: JiraTicket | null;
    const handed = queue.shift();
    if (handed !== undefined) {
      if (ctx.exclude.has(handed)) continue;
      t = { key: handed, status: ctx.research.claimStatus.to, assignee: null, labels: [ctx.dev.triggerLabel] };
    } else {
      const p = await poll(ctx, "dev");
      if (p === "error" || p === null) return null;
      t = p;
    }
    if (typeof t.key !== "string" || !TICKET_KEY.test(t.key)) {
      if (badKey(ctx, t)) continue;
      return null;
    }
    const landed = await landedSkipReason(ctx, t.key);
    if (landed) {
      skip(ctx, t.key, landed);
      continue;
    }
    if (!(await gate(ctx, t.key))) continue;
    return { ticket: t, polled: handed === undefined };
  }
}

/** Record the missing claim fields and comment once on Jira (not again while the detail is unchanged). */
async function reportMissingFields(ctx: Ctx, key: string, err: ClaimMissingFieldsError): Promise<void> {
  const list = err.fields.join(", ");
  const detail = `claim blocked: required field(s) missing: ${list}`;
  const prev = latestRecord(ctx.records, key);
  // A previous identical record with a jira_sync_error means the comment never landed: retry it.
  const repeat = prev !== null && prev.outcome === "claim-error" && prev.detail === detail && !prev.jira_sync_error;
  let syncError: string | undefined;
  if (!repeat) {
    const body = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "dev-loop could not start this ticket: ", marks: [{ type: "strong" }] },
            {
              type: "text",
              text: `moving it to ${ctx.research.claimStatus.to} requires ${list}. Fill in the field(s); the loop retries on its next poll.`,
            },
          ],
        },
      ],
    };
    try {
      await ctx.deps.jira.addComment(key, body);
    } catch (e) {
      syncError = `missing-fields comment failed: ${errorMessage(e)}`;
      ctx.log(`[worker] ${key}: could not post the missing-fields comment: ${errorMessage(e)}`);
    }
  }
  await append(ctx, key, nowIso(ctx), "claim-error", [], {
    detail,
    ...(syncError !== undefined ? { jira_sync_error: syncError } : {}),
  });
}

/** Step 4's candidate: research poll, never-re-refine guard, gate, then claim. */
export async function nextResearchCandidate(ctx: Ctx): Promise<JiraTicket | null> {
  for (;;) {
    if (ctx.skips >= MAX_SKIPS) return null;
    const t = await poll(ctx, "research");
    if (t === "error" || t === null) return null;
    if (typeof t.key !== "string" || !TICKET_KEY.test(t.key)) {
      if (badKey(ctx, t)) continue;
      return null;
    }
    if (hasLandedPhase(ctx.records, t.key, "research") || (await ctx.deps.hasLandedResearchV1?.(t.key))) {
      skip(ctx, t.key, "already refined (a landed research run is recorded); never re-refined");
      continue;
    }
    if (!(await gate(ctx, t.key))) continue;
    let claimed: boolean;
    try {
      claimed = await ctx.deps.jira.claimTicket(t.key, ctx.research.claimStatus.from, ctx.research.claimStatus.to);
    } catch (err) {
      if (err instanceof ClaimMissingFieldsError) {
        await reportMissingFields(ctx, t.key, err);
        skip(ctx, t.key, `claim threw: ${errorMessage(err)}`);
        continue;
      }
      await append(ctx, t.key, nowIso(ctx), "claim-error", [], { detail: `claim failed: ${errorMessage(err)}` });
      skip(ctx, t.key, `claim threw: ${errorMessage(err)}`);
      continue;
    }
    if (!claimed) {
      skip(ctx, t.key, "claim lost a race");
      continue;
    }
    return t;
  }
}

// ---- budgets (Ruling 16) ----

export function researchBudget(ctx: Ctx): number {
  return Math.min(ctx.research.limits.maxCostPerRunUsd, ctx.deps.config.ceilings.maxCostPerTicketUsd);
}

/** Dev budget after `spentUsd` this iteration (0 for a dev-only iteration). Below 1: don't start dev. */
export function devBudget(ctx: Ctx, spentUsd = 0): number {
  return Math.min(ctx.dev.limits.maxCostPerRunUsd, ctx.deps.config.ceilings.maxCostPerTicketUsd - spentUsd);
}

export const MIN_DEV_BUDGET_USD = 1;

// ---- running a phase ----

/** A run an enforcing sandbox refused: its denials, plus the measured cost, run dir and timing (for the ceilings). */
export type PhaseParked = NonNullable<RunSkillResult["parked"]> & {
  cost_usd: number;
  run_dir: string;
  started: string;
  ended: string;
  sandbox?: NonNullable<RunSkillResult["sandbox"]>;
};

export type PhaseRun =
  | {
      entry: PhaseEntry;
      /** Set when the sandbox refused the run: `entry` is then a placeholder agent_error the caller ignores. */
      parked?: PhaseParked;
      /** setInFlight(null) failed: the session lock is gone. Append the record, then pause. */
      fatal?: string;
    }
  /** setInFlight(role) failed before the run: the phase never started. The caller records what is needed, then pauses. */
  | { entry: null; fatal: string };

/** setInFlight(role) -> run the phase -> setInFlight(null). Never throws for a lost session lock. */
export async function runPhase(ctx: Ctx, role: Role, ticket: JiraTicket, maxBudgetUsd: number): Promise<PhaseRun> {
  const { deps } = ctx;
  const since = nowIso(ctx);
  const runDir = v2RunDir(deps.slug, deps.session.name, ticket.key, role, runIdNow(deps.now()));
  try {
    await deps.session.setInFlight({ ticket: ticket.key, role, runDir, since });
  } catch (err) {
    return { entry: null, fatal: `could not record the in-flight ${role} run for ${ticket.key} in the session lock: ${errorMessage(err)}` };
  }
  ctx.log(`[worker] ${ticket.key}: ${role} phase starting (budget $${maxBudgetUsd})`);
  // Capture `parked` from the result; the phase functions see verdictRaw undefined and make no Jira write.
  // Also capture which sandbox ran it, for the PhaseEntry / parked record (spec §6).
  let parked: PhaseParked | undefined;
  let sandbox: RunSkillResult["sandbox"];
  const runSkill: RunSkillFn = async (args) => {
    const res = await deps.runSkill(args);
    sandbox = res.sandbox;
    if (res.parked) {
      parked = { ...res.parked, cost_usd: res.costUsd, run_dir: args.runDir, started: res.started, ended: res.ended, ...(sandbox ? { sandbox } : {}) };
    }
    return res;
  };
  const phaseEntry =
    role === "research"
      ? await runResearchPhase(ticket, { jira: deps.jira, view: ctx.research, runSkill, runDir, maxBudgetUsd, now: deps.now })
      : await runDevPhase(ticket, {
          jira: deps.jira,
          github: deps.github,
          view: ctx.dev,
          runSkill,
          runDir,
          maxBudgetUsd,
          session: deps.session.name,
          now: deps.now,
          ...(deps.prDiffStats ? { prDiffStats: deps.prDiffStats } : {}),
          ...(deps.hostPush
            ? {
                hostPush: async (ready) => {
                  ctx.log(`[worker] ${ticket.key}: host push starting (${ready.branch})`);
                  const res = await deps.hostPush!(ticket.key, runDir, ready);
                  ctx.log(`[worker] ${ticket.key}: host push ${res.ok ? `ok: ${res.pr}` : `failed: ${res.detail}`}`);
                  return res;
                },
              }
            : {}),
        });
  const entry: PhaseEntry = sandbox ? { ...phaseEntry, sandbox } : phaseEntry;
  ctx.log(parked ? `[worker] ${ticket.key}: ${role} parked (sandbox refused)` : `[worker] ${ticket.key}: ${role} ${entry.outcome}: ${entry.detail}`);
  const out = parked ? { entry, parked } : { entry };
  try {
    await deps.session.setInFlight(null);
    return out;
  } catch (err) {
    return { ...out, fatal: `could not clear the session's in-flight record: ${errorMessage(err)}` };
  }
}

/**
 * Post-phase ceilings: cost and duration of this run against its role's
 * limits. runs/day is checked before a role starts (per role), not here, so
 * one role reaching its cap never stops the other role's work.
 */
export function postPhaseBreach(ctx: Ctx, entry: Pick<PhaseEntry, "role" | "cost_usd" | "started" | "ended">): string | null {
  const view = entry.role === "research" ? ctx.research : ctx.dev;
  const c = checkCeilings({
    runsToday: 0,
    runCostUsd: entry.cost_usd,
    runDurationMin: durationMin(entry.started, entry.ended),
    limits: view.limits,
  });
  return c.breached ? `${entry.role}: ${c.detail}` : null;
}
