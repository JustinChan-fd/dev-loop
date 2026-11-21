// The research -> dev label handoff, owned by the worker cycle (not the
// research phase) so the post-research ceiling check sits before it.
// findPendingHandoffs reads the log; completePendingHandoffs is cycle step 1.

import type { IterationRecord } from "../core/iteration-log.ts";
import { errorMessage } from "../core/run-skill.ts";
import { append, latestRecord, nowIso, type Ctx } from "./context.ts";

/**
 * Tickets whose latest research entry landed without a completed handoff
 * (`handoff` "failed", "skipped-ceiling", or absent: a research-only
 * `--phase research` run), with no dev entry and no "handoff-done" record
 * after it. First-seen
 * order. Records are ordered by `ended` (file order breaks ties).
 */
export function findPendingHandoffs(records: IterationRecord[]): string[] {
  const ordered = records.map((r, i) => ({ r, i })).sort((a, b) => (a.r.ended < b.r.ended ? -1 : a.r.ended > b.r.ended ? 1 : a.i - b.i));
  const state = new Map<string, boolean>();
  for (const { r } of ordered) {
    const research = r.phases.filter((p) => p.role === "research").at(-1);
    const hasDev = r.phases.some((p) => p.role === "dev");
    if (research) state.set(r.ticket, research.outcome === "landed" && research.handoff !== "done" && !hasDev);
    else if (hasDev || r.outcome === "handoff-done" || r.outcome === "handoff-dropped") state.set(r.ticket, false);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.ticket)) continue;
    seen.add(r.ticket);
    if (state.get(r.ticket)) out.push(r.ticket);
  }
  return out;
}

/**
 * Step 1: retry every pending handoff's label swap, after reading the
 * ticket's Jira status: a ticket in the Done category gets one phase-less
 * "handoff-dropped" record and is never swapped or built; an unreadable
 * status leaves it pending for the next iteration. A success appends one
 * phase-less "handoff-done" record (so it is never swapped again, even if
 * dev can't run it yet) and makes the ticket a dev candidate this iteration
 * (ctx.handedOff). A failure appends one
 * phase-less "handoff-pending" record only when the ticket's previous record
 * isn't already handoff-pending (no log growth while Jira is down); it is
 * retried next iteration and never pauses.
 */
export async function completePendingHandoffs(ctx: Ctx): Promise<void> {
  const { research } = ctx;
  for (const key of findPendingHandoffs(ctx.records)) {
    // A ticket closed in Jira since research landed (e.g. a test clone, or work done elsewhere)
    // must never be handed to dev. Unreadable status: leave it pending, try next iteration.
    let status: { name: string; done: boolean };
    try {
      status = await ctx.deps.jira.getStatusDetail(key);
    } catch (err) {
      ctx.log(`[worker] ${key}: pending handoff: could not read the Jira status (${errorMessage(err)}); left pending`);
      continue;
    }
    if (status.done) {
      ctx.log(`[worker] ${key}: pending handoff dropped: the ticket is ${status.name} in Jira`);
      await append(ctx, key, nowIso(ctx), "handoff-dropped", [], { detail: `research landed, but the ticket is ${status.name} in Jira; no label handoff, no dev run` });
      continue;
    }
    try {
      await ctx.deps.jira.swapLabel(key, research.triggerLabel, research.handoffLabel);
      ctx.log(`[worker] ${key}: pending handoff completed (${research.triggerLabel} -> ${research.handoffLabel})`);
      await append(ctx, key, nowIso(ctx), "handoff-done", [], { detail: `label handoff ${research.triggerLabel} -> ${research.handoffLabel} completed` });
      ctx.handedOff.push(key);
    } catch (err) {
      const message = errorMessage(err);
      ctx.log(`[worker] ${key}: pending handoff still failing: ${message}`);
      if (latestRecord(ctx.records, key)?.outcome !== "handoff-pending") {
        await append(ctx, key, nowIso(ctx), "handoff-pending", [], {
          detail: "research landed; the label handoff to dev is still pending",
          jira_sync_error: message,
        });
      }
    }
  }
}
