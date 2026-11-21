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
import { resolveRepoPath } from "../../core/paths.ts";
import type { VerdictCheck, ResearchFacts } from "./verdict-checks.ts";
import { checkResearchVerdict, DEFAULT_COVERAGE_WARN_RUNS, readResearchFacts } from "./verdict-checks.ts";

export interface ResearchPhaseDeps {
  jira: JiraClient;
  /** roleView(config, "research"). */
  view: ResearchView;
  runSkill: RunSkillFn;
  /** v2RunDir(...) for this run, recorded as run_dir. */
  runDir: string;
  maxBudgetUsd: number;
  now: () => Date;
  /** Earlier research entries in this project's log with verdict_check "coverage_warned" (default 0). */
  coverageWarnsSoFar?: number;
  /** roles.research.attachmentCoverageWarnRuns (default DEFAULT_COVERAGE_WARN_RUNS). */
  coverageWarnRuns?: number;
  /** Reads RUN_DIR's progress.jsonl and attachments.json (default readResearchFacts on the resolved run dir). */
  readFacts?: (runDir: string, coverageWarnsSoFar: number, coverageWarnRuns: number) => Promise<ResearchFacts>;
}

/** The Jira comment for a loop-made blocked bounce (an attachment the loop could not read). */
export function attachmentBlockedCommentAdf(detail: string): Record<string, unknown> {
  const text =
    `Research bounced: blocked. ${detail}. ` +
    "Fix the attachment (type, size or access) and re-label the ticket; the ticket text does not need rewriting.";
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
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

  // The loop checks the verdict against its rules before acting on it (bounce criteria v2).
  let verdictCheck: VerdictCheck | undefined;
  if (verdict.failure_category !== "agent_error") {
    const warns = deps.coverageWarnsSoFar ?? 0;
    const warnRuns = deps.coverageWarnRuns ?? DEFAULT_COVERAGE_WARN_RUNS;
    let facts: ResearchFacts;
    try {
      facts = await (deps.readFacts ?? ((d, w, r) => readResearchFacts(resolveRepoPath(d), w, r)))(deps.runDir, warns, warnRuns);
    } catch {
      // Unreadable facts are no facts: too_large is then ungrounded, ready has no manifest to check.
      facts = { progressRaw: null, manifest: null, coverageWarnsSoFar: warns, coverageWarnRuns: warnRuns };
    }
    const check = checkResearchVerdict(verdict, facts);
    if (check.action === "refuse") {
      verdictCheck = check.check;
      verdict = agentErrorVerdict(`loop refused the verdict: ${check.detail}`);
    } else if (check.action === "bounce_blocked") {
      verdictCheck = check.check;
      verdict = { ...verdict, outcome: "bounced", failure_category: "blocked", detail: check.detail };
    } else if (check.check) {
      verdictCheck = check.check;
    }
  }

  // ticket-refine's passing word is "ready" (a refined ticket, not a PR).
  const outcome = verdict.outcome === "ready" ? "landed" : verdict.outcome;

  const syncErrors: string[] = [];
  if (outcome === "bounced") {
    // A loop-made bounce has no skill-written comment, so the loop writes one.
    if (verdictCheck === "attachment_unreadable") {
      try {
        await deps.jira.addComment(ticket.key, attachmentBlockedCommentAdf(verdict.detail));
      } catch (err) {
        syncErrors.push(errorMessage(err));
      }
    }
    try {
      await deps.jira.transitionStatus(ticket.key, deps.view.statusNames.bounced);
    } catch (err) {
      syncErrors.push(errorMessage(err));
    }
  }
  const jiraSyncError = syncErrors.length > 0 ? syncErrors.join("; ") : undefined;

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
    ...(verdict.size_evidence !== undefined ? { size_evidence: verdict.size_evidence } : {}),
    ...(verdictCheck !== undefined ? { verdict_check: verdictCheck } : {}),
    ...(verdict.size_estimate !== undefined ? { size_estimate: verdict.size_estimate } : {}),
    ...(verdict.ac_count !== undefined ? { ac_count: verdict.ac_count } : {}),
    ...(jiraSyncError !== undefined ? { jira_sync_error: jiraSyncError } : {}),
  };
}
