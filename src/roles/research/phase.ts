// The research phase: one ticket-refine run on a ticket the worker cycle
// already claimed (src/worker/cycle.ts owns polling, the blocker gate, the
// claim, assignment, the log, the ceilings and the research -> dev label
// handoff, so the ceiling check can sit before the handoff). Runs the skill,
// normalizes "ready" to "landed", moves a bounce to the bounced status and
// returns the PhaseEntry. Never throws.

import type { JiraClient, JiraTicket } from "../../core/jira-client.ts";
import type { ResearchView, Verdict } from "../../core/types.ts";
import type { PhaseEntry } from "../../core/iteration-log.ts";
import type { RunSkillFn, RunSkillResult } from "../../core/run-skill.ts";
import { errorMessage } from "../../core/run-skill.ts";
import { agentErrorVerdict, parseVerdict } from "../../core/verdict.ts";

export interface ResearchPhaseDeps {
  jira: JiraClient;
  /** roleView(config, "research"). */
  view: ResearchView;
  runSkill: RunSkillFn;
  /** v2RunDir(...) for this run, recorded as run_dir. */
  runDir: string;
  maxBudgetUsd: number;
  now: () => Date;
}

export async function runResearchPhase(ticket: JiraTicket, deps: ResearchPhaseDeps): Promise<PhaseEntry> {
  let result: RunSkillResult;
  let verdict: Verdict;
  try {
    result = await deps.runSkill({ role: "research", ticketKey: ticket.key, runDir: deps.runDir, maxBudgetUsd: deps.maxBudgetUsd });
    verdict = parseVerdict(result.verdictRaw, "refine");
  } catch (err) {
    const at = deps.now().toISOString();
    result = { verdictRaw: undefined, started: at, ended: at, costUsd: 0, tokens: { in: 0, out: 0 }, skillVersion: "", model: "" };
    verdict = agentErrorVerdict(`runSkill threw: ${errorMessage(err)}`);
  }

  // ticket-refine's passing word is "ready" (a refined ticket, not a PR).
  const outcome = verdict.outcome === "ready" ? "landed" : verdict.outcome;

  let jiraSyncError: string | undefined;
  if (outcome === "bounced") {
    try {
      await deps.jira.transitionStatus(ticket.key, deps.view.statusNames.bounced);
    } catch (err) {
      jiraSyncError = errorMessage(err);
    }
  }

  return {
    role: "research",
    skill: "ticket-refine",
    skill_version: result.skillVersion,
    model: result.model,
    started: result.started,
    ended: result.ended,
    outcome,
    phase_reached: verdict.phase_reached,
    cost_usd: result.costUsd,
    tokens: result.tokens,
    failure_category: verdict.failure_category,
    detail: verdict.detail,
    // Always null: research never opens a PR (remote-close and reset rely on it).
    pr: null,
    run_dir: deps.runDir,
    ...(verdict.red_confirmed !== undefined ? { red_confirmed: verdict.red_confirmed } : {}),
    ...(verdict.verify_loops !== undefined ? { verify_loops: verdict.verify_loops } : {}),
    ...(verdict.retries !== undefined ? { retries: verdict.retries } : {}),
    // Already sanitized by parseVerdict: a malformed value never reaches here.
    ...(verdict.size_trajectory !== undefined ? { size_trajectory: verdict.size_trajectory } : {}),
    ...(verdict.size_estimate !== undefined ? { size_estimate: verdict.size_estimate } : {}),
    ...(verdict.ac_count !== undefined ? { ac_count: verdict.ac_count } : {}),
    ...(jiraSyncError !== undefined ? { jira_sync_error: jiraSyncError } : {}),
  };
}
