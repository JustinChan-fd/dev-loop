// The dev phase: one ticket-to-pr run on a ticket the worker cycle already
// picked (src/worker/cycle.ts owns polling, gating, the landed guard,
// in-flight bookkeeping, the log and the ceilings). Runs the skill, then
// applies v1's dev outcome handling to Jira/GitHub and returns the
// PhaseEntry for the iteration record. Never throws: a runSkill throw is an
// error entry with agent_error, and every Jira/GitHub write failure lands in
// jira_sync_error.

import type { JiraClient, JiraTicket } from "../../core/jira-client.ts";
import type { GitHubClient } from "../../core/github-client.ts";
import type { DevView, ExecutorVerdict, ReadyToPush, Verdict } from "../../core/types.ts";
import type { HostPushResult } from "../../worker/host-push.ts";
import type { DiffStats, PrDiffStatsFn } from "../../core/diff-stats.ts";
import type { PhaseEntry } from "../../core/iteration-log.ts";
import type { RunSkillFn, RunSkillResult } from "../../core/run-skill.ts";
import { errorMessage } from "../../core/run-skill.ts";
import { agentErrorVerdict, parseVerdict } from "../../core/verdict.ts";
import {
  buildBounceCommentAdf,
  buildCodeReviewFields,
  buildQaNotesAdf,
  withSessionSuffixText,
} from "./code-review.ts";

export interface DevPhaseDeps {
  jira: JiraClient;
  github: GitHubClient;
  /** roleView(config, "dev"). */
  view: DevView;
  runSkill: RunSkillFn;
  /** v2RunDir(...) for this run, recorded as run_dir. */
  runDir: string;
  maxBudgetUsd: number;
  /** The worker session name; src-built comments end with "— <session>". */
  session: string;
  now: () => Date;
  /** Present only on a run whose sandbox leaves signing and pushing to the host. */
  hostPush?: (ready: ReadyToPush) => Promise<HostPushResult>;
  /** Reads a landed PR's size for the entry's diff_stats (realPrDiffStats). Absent: none recorded. */
  prDiffStats?: PrDiffStatsFn;
}

/** Post to the ticket's mirror GitHub Issue if one exists; a missing Issue is silently skipped. Returns an error message or undefined. */
async function postGitHubDetail(github: GitHubClient, ticketKey: string, body: string): Promise<string | undefined> {
  try {
    const issue = await github.findIssueByJiraKey(ticketKey);
    if (!issue) return undefined;
    await github.addComment(issue.number, body);
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

export async function runDevPhase(ticket: JiraTicket, deps: DevPhaseDeps): Promise<PhaseEntry> {
  const { jira, github, view, session } = deps;

  let result: RunSkillResult;
  let verdict: ExecutorVerdict & Verdict;
  let extraCost = 0;
  try {
    result = await deps.runSkill({ role: "dev", ticketKey: ticket.key, runDir: deps.runDir, maxBudgetUsd: deps.maxBudgetUsd });
    const parsed = parseVerdict(result.verdictRaw, "executor");
    if (parsed.outcome === "ready_to_push") {
      const ready = parsed.ready_to_push;
      if (!deps.hostPush || !ready) {
        verdict = agentErrorVerdict("ready_to_push but this run has no host push (push=host was not given)");
      } else {
        let res: HostPushResult;
        try {
          res = await deps.hostPush(ready);
        } catch (err) {
          res = { ok: false, detail: errorMessage(err), costUsd: 0 };
        }
        extraCost = res.costUsd;
        verdict = res.ok
          ? {
              ...(parsed as ExecutorVerdict & Verdict),
              outcome: "landed",
              pr: res.pr,
              detail: `${parsed.detail} Host-signed ${res.signed} commit(s) (${res.oldTip.slice(0, 7)}\u2192${res.newTip.slice(0, 7)}) and pushed ${res.branch}.`,
            }
          : {
              ...(parsed as ExecutorVerdict & Verdict),
              outcome: "bounced",
              failure_category: "env_setup",
              pr: null,
              detail: `host push failed: ${res.detail}. ${
                res.pushed
                  ? `Branch ${res.branch ?? ready.branch} is pushed to origin (signed); no PR yet.`
                  : `Work committed locally on ${res.branch ?? ready.branch}, not pushed.`
              }${res.oldTip ? ` Pre-sign tip ${res.oldTip.slice(0, 7)}.` : ""}`,
            };
      }
    } else {
      verdict = parsed as ExecutorVerdict & Verdict;
    }
  } catch (err) {
    const at = deps.now().toISOString();
    result = { verdictRaw: undefined, started: at, ended: at, costUsd: 0, tokens: { in: 0, out: 0 }, skillVersion: "", model: "" };
    verdict = agentErrorVerdict(`runSkill threw: ${errorMessage(err)}`);
  }

  const errors: string[] = [];
  const github_ = async (body: string) => {
    const e = await postGitHubDetail(github, ticket.key, withSessionSuffixText(body, session));
    if (e) errors.push(e);
  };

  try {
    if (verdict.outcome === "landed") {
      // In Progress -> Code Review, with the transition screen's required PII/QA-notes fields.
      await jira.transitionStatus(ticket.key, view.statusNames.prOpen, buildCodeReviewFields(view, buildQaNotesAdf(verdict)));
      await github_(`Landed — PR: ${verdict.pr ?? "(none)"}, verify loops: ${verdict.verify_loops}.`);
    } else if (verdict.outcome === "bounced" && verdict.pr !== null) {
      // Intake found the work already landed. Self-heal a status transition an
      // earlier run lost (TARS-1465: re-bounced 7+ times while stuck In Progress).
      if (ticket.status !== view.statusNames.prOpen) {
        await jira.transitionStatus(ticket.key, view.statusNames.prOpen, buildCodeReviewFields(view, buildQaNotesAdf(verdict)));
      }
      await github_(`Bounced (${verdict.failure_category}): ${verdict.detail}`);
    } else if (verdict.outcome === "bounced") {
      // A genuine blocker. Evidence comment first, in its own try, so a failed
      // comment never leaves the ticket stuck In Progress.
      try {
        await jira.addComment(ticket.key, buildBounceCommentAdf(verdict, session));
      } catch (err) {
        errors.push(errorMessage(err));
      }
      await github_(`Bounced (${verdict.failure_category}): ${verdict.detail}`);
      await jira.transitionStatus(ticket.key, view.statusNames.bounced);
    }
  } catch (err) {
    errors.push(errorMessage(err));
  }

  // Telemetry only: a failed read never changes the outcome or the sync errors.
  let diffStats: DiffStats | null = null;
  if (verdict.outcome === "landed" && verdict.pr && deps.prDiffStats) {
    try {
      diffStats = await deps.prDiffStats(verdict.pr);
    } catch {
      diffStats = null;
    }
  }

  return {
    role: "dev",
    skill: "ticket-to-pr",
    skill_version: result.skillVersion || verdict.skill_version,
    model: result.model || verdict.model,
    started: result.started,
    ended: result.ended,
    outcome: verdict.outcome,
    phase_reached: verdict.phase_reached,
    cost_usd: result.costUsd + extraCost,
    tokens: result.tokens,
    failure_category: verdict.failure_category,
    detail: verdict.detail,
    pr: verdict.pr,
    run_dir: deps.runDir,
    red_confirmed: verdict.red_confirmed,
    verify_loops: verdict.verify_loops,
    retries: verdict.retries,
    ...(verdict.preexisting_failures && verdict.preexisting_failures.length > 0
      ? { preexisting_failures: verdict.preexisting_failures }
      : {}),
    ...(verdict.follow_up ? { follow_up: verdict.follow_up } : {}),
    ...(diffStats ? { diff_stats: diffStats } : {}),
    ...(errors.length > 0 ? { jira_sync_error: errors.join("; ") } : {}),
  };
}
