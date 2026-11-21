// Shared types for both pipeline roles (research/skeptic and dev/executor).
//
// These types describe the data shapes the loop runners pass between their
// pure functions (jql, verdict, ceilings, runs-log) and their injected
// dependencies (JiraClient, run-skill callback). No behavior lives here
// beyond the CURRENT_LOG_VERSION constant.

import type { SandboxConfig } from "../sandbox/types.ts";

/**
 * Closed enum of failure categories a run can be tagged with. This must
 * match the pipeline spec's failure_category enum exactly - do not add or
 * remove values without updating the spec.
 */
export type FailureCategory =
  | "spec_ambiguous"
  | "spec_contradicted"
  | "blocked"
  | "too_large"
  | "tests_flaky"
  | "env_setup"
  | "verify_rejected"
  | "subagent_stall"
  | "merge_conflict"
  | "agent_error"
  | "killed_ceiling"
  /** An enforcing sandbox refused the run (network, credential, infra): the ticket is parked, not judged. */
  | "sandbox_denied";

/**
 * The set of terminal outcomes a run can have.
 */
export type RunOutcome = "landed" | "bounced" | "error" | "killed";

/**
 * The TDD phase the run reached before it stopped (successfully or not).
 */
export type PhaseReached = "intake" | "plan" | "red" | "green" | "verify" | "pr";

/** dev-loop's original name for PhaseReached; kept as an alias. */
export type RunPhase = PhaseReached;

/**
 * Current v1 log schema version (from research-loop), stamped on every new
 * research RunLogLine. An absent `log_version` means "1.0" (every line
 * before the field existed, and every dev-loop v1 line) -- there is no
 * backfill; absence is the implicit old value.
 */
export const CURRENT_LOG_VERSION = "1.1";

/**
 * One line of a v1 runs.jsonl -- the append-only run log. The superset of
 * both roles' v1 schemas. Read-only: v2 reads these lines (reset, landed
 * guards, reconcile) but never edits one in place.
 */
export interface RunLogLine {
  readonly ticket: string;
  readonly skill: string;
  /** Git SHA of the skill at run time. */
  readonly skill_version: string;
  readonly model: string;
  /** ISO-8601 UTC timestamp, e.g. "2026-08-16T14:02:11Z". */
  readonly started: string;
  /** ISO-8601 UTC timestamp, e.g. "2026-08-16T14:19:40Z". */
  readonly ended: string;
  readonly outcome: RunOutcome;
  readonly phase_reached: PhaseReached;
  readonly red_confirmed: boolean;
  readonly verify_loops: number;
  readonly retries: number;
  readonly failure_category: FailureCategory | null;
  /** One line, human-written by the skill. */
  readonly detail: string;
  readonly pr: string | null;
  readonly cost_usd: number;
  readonly tokens: {
    readonly in: number;
    readonly out: number;
  };
  /** Schema version this line was written under. Absent means "1.0". */
  readonly log_version?: string;
  /** Shadow-mode size telemetry (research), present only when the skill reported one. */
  readonly size_trajectory?: SizeTrajectory;
}

/**
 * The full set of outcomes a Verdict's `outcome` field may hold: RunOutcome
 * plus "ready", ticket-refine's own passing-verdict word (a refined ticket,
 * not a PR). The research role normalizes "ready" to "landed" before writing
 * a RunLogLine; the executor profile of parseVerdict rejects it outright.
 */
export type VerdictOutcome = RunOutcome | "ready";

/** T-shirt-sized trajectory signal verifier-agent reports at Step 4. */
export type TShirtSize = "S" | "M" | "L" | "XL";

/** How a ticket's size changed across self-heal/re-pickup cycles within a run. */
export type SizeDelta = "grew" | "shrank" | "unchanged";

/**
 * Shadow-mode size signal (research role), carried into verdict.json and
 * runs.jsonl. Pure telemetry: nothing reads or acts on it yet.
 */
export interface SizeTrajectory {
  step4_tshirt: TShirtSize;
  delta: SizeDelta;
  /** Mechanically computed score, clamped to [0, 10]. */
  final_score: number;
}

/**
 * What a skill's verdict.json contains -- the superset of both roles'
 * schemas. Only outcome/phase_reached/failure_category/detail are required
 * of every skill (ticket-refine omits the executor fields). The loop runner
 * derives a RunLogLine from it; it derives no epic-or-label-move decision.
 * See ExecutorVerdict for the shape ticket-to-pr must always produce.
 */
/** A follow-up ticket for pre-existing failures (Ruling 30). */
export interface FollowUp {
  ticket: string;
  pr: string | null;
}

export interface Verdict {
  outcome: VerdictOutcome;
  phase_reached: PhaseReached;
  failure_category: FailureCategory | null;
  /** One line, human-written by the skill. */
  detail: string;
  red_confirmed?: boolean;
  verify_loops?: number;
  retries?: number;
  skill_version?: string;
  model?: string;
  pr?: string | null;
  cost_usd?: number;
  tokens?: {
    in: number;
    out: number;
  };
  /**
   * Optional hint from the skill about which loop produced this verdict
   * ("refine" vs "dev"). Currently unread by the loop runner (it derives
   * loopKind from its own invocation context) -- kept only for schema shape.
   */
  loop?: "refine" | "dev";
  /**
   * Optional sequential manual-testing steps for a human QA reviewer --
   * e.g. "Navigate to `/rotten-tomatoes/critics?query=...`", "Expected:
   * the Self-Service badge appears next to the critic's name". Rendered
   * into Jira's QA Notes field (see roles/dev/code-review.ts's
   * buildQaNotesAdf) as a bold "Manual testing steps:" header + ordered
   * list. The PR body's "## QA Notes" carries this same list. Absent/empty
   * on older verdicts or bounced runs; the dev role falls back to the
   * PR-link stub in that case.
   */
  qa_notes?: string[];
  /**
   * Tests that failed on the branch AND identically on the unmodified base
   * branch (Ruling 29): the run proceeded to a PR and named them there.
   * Optional; a malformed value is dropped at the parse boundary.
   */
  preexisting_failures?: string[];
  /**
   * The follow-up ticket this run filed for pre-existing failures that
   * blocked a commit/push hook (Ruling 30), and its fix PR when one opened.
   */
  follow_up?: FollowUp;
  /** Schema version this verdict was written under. Absent means "1.0". */
  log_version?: string;
  /**
   * Shadow-mode size telemetry. Parsed independently by
   * parseSizeTrajectory in verdict.ts -- a malformed value must never flip
   * `outcome` to "error"; it is dropped at the parse boundary instead.
   */
  size_trajectory?: SizeTrajectory;
}

/** What a sandboxed dev run hands the host so it can sign, push and open the PR. */
export interface ReadyToPush {
  branch: string;
  pr_title: string;
  pr_body: string;
}

/**
 * The verdict shape ticket-to-pr (the executor role) always writes, and
 * what parseVerdict(raw, "executor") guarantees: a RunOutcome (never
 * "ready") plus every executor field present. The dev role reads these
 * unconditionally -- e.g. `verdict.pr !== null` decides the bounce branch,
 * so a missing `pr` must be an agent_error, never silently `undefined`.
 */
export interface ExecutorVerdict extends Omit<Verdict, "outcome"> {
  outcome: RunOutcome | "ready_to_push";
  /** Set only when outcome is "ready_to_push"; the host loop signs and pushes. */
  ready_to_push?: ReadyToPush;
  red_confirmed: boolean;
  verify_loops: number;
  retries: number;
  skill_version: string;
  model: string;
  pr: string | null;
  cost_usd: number;
  tokens: {
    in: number;
    out: number;
  };
}

/** Which phase a role-scoped value belongs to. */
export type Role = "research" | "dev";

/** Claim-status transition pair, e.g. { from: "To Do", to: "In Progress" }. */
export interface ClaimStatusConfig {
  from: string;
  to: string;
}

/**
 * Which existing Jira status names the terminal outcomes map onto -- this
 * Jira instance has no literal "bounced" or "pr-open" status, so these are
 * bound to statuses that exist in the ticket's workflow (e.g. "Blocked",
 * "Code Review").
 */
export interface StatusNamesConfig {
  bounced: string;
  prOpen: string;
}

/** Jira values shared by both roles. */
export interface JiraConfig {
  /**
   * A second, always-paired label naming which repo a ticket belongs to --
   * e.g. "repo:catalog-ui-management". Needed because catalog-ui-management
   * and catalog-ui-public both file into Jira project MC, so the stage label
   * alone can't tell them apart. Never changes across a ticket's lifecycle.
   */
  repoLabel: string;
  statusNames: StatusNamesConfig;
  claimStatus: ClaimStatusConfig;
  /**
   * Status names (exact) that clear an "is blocked by" blocker from any repo
   * or project, e.g. "Deployed to INT". Jira's Done category always clears
   * too once this is set. Absent: only a merged PR in github.repo clears a
   * blocker (src/core/blocker-gate.ts).
   */
  blockerClearedStatuses?: string[];
}

/**
 * Jira custom field IDs written when transitioning a landed PR to Code
 * Review -- mirrors what the interactive `push-branch` skill sets by hand,
 * so an automated PR fills the same required Code Review screen fields.
 */
export interface CodeReviewFieldsConfig {
  /** "Covered Information Data Inventory" multicheckboxes field. */
  piiField: string;
  /** Option id for its "No Impact" value. */
  piiNoImpactOptionId: string;
  /** "QA Notes" textarea field. */
  qaNotesField: string;
}

/** The brief's name for CodeReviewFieldsConfig. */
export type CodeReviewFields = CodeReviewFieldsConfig;

/** Per phase run (one `claude -p` spawn). */
export interface RoleCeilingsConfig {
  maxCostPerRunUsd: number;
  runTimeoutMin: number;
}

/** Settings each role owns. */
export interface RoleSettings {
  /** The stage label this role's poll matches on (`{label}` in its pollJql). */
  triggerLabel: string;
  /**
   * JQL template. Placeholders: {label} {repoLabel} {assignee}
   * {bouncedStatus} {prOpenStatus}, filled by core/jql.ts buildPollJql.
   */
  pollJql: string;
  ceilings: RoleCeilingsConfig;
}

/** Ceilings shared by both roles. */
export interface CeilingsConfig {
  /** Phase runs per day, counted per role (each role gets this many). */
  maxRunsPerDay: number;
  /** Failed (error/killed) attempts per role per ticket before it is moved to Blocked. */
  maxAttemptsPerTicket: number;
  /** Total cost across both phases for one ticket (consumed from Task 13). */
  maxCostPerTicketUsd: number;
}

/**
 * The codebase both skills operate against -- separate from this pipeline
 * repo itself, which only orchestrates. Kept in config (not hardcoded) so
 * the same pipeline repos can be pointed at a different project later.
 */
export interface TargetRepoConfig {
  /** git remote URL, e.g. "git@github.com:org/repo.git". */
  url: string;
  /** Branch new work branches from and PRs target, e.g. "master". */
  defaultBranch: string;
  /**
   * Local filesystem path to an existing checkout of `url`, if one exists
   * on this machine (e.g. "/Users/me/Repos/webtarsthree"). When set,
   * worktrees are created directly off this checkout instead of a fresh
   * clone into `.pipeline/<slug>/repo` -- faster, and its "origin" remote
   * is already the real one, so `ticket-to-pr`'s push/PR need no extra
   * setup. Optional: omit on a machine with no local checkout yet, and the
   * clone-based flow is used instead.
   */
  path?: string;
  /**
   * How the project runs locally, when it isn't "package.json at the repo
   * root, host Node, root .envrc.example". Every field is optional; the
   * defaults (localProfile in core/config.ts) are today's behaviour. See
   * docs/config.md and docs/projects/.
   */
  local?: LocalProfileConfig;
}

/** How an env template is written: `export NAME=value` (direnv) or plain `NAME=value`. */
export type EnvTemplateFormat = "export" | "dotenv";

/** targetRepo.local as written in the config file. Paths are relative to the repo root. */
export interface LocalProfileConfig {
  /** Folder holding package.json; default ".". */
  appDir?: string;
  /** The file naming the project's Node version (e.g. "app/.nvmrc"); default: none, host Node. */
  node?: { versionFile: string };
  /** The committed env template the robot's fake values come from; default { ".envrc.example", "export" }. */
  envTemplate?: { path: string; format: EnvTemplateFormat };
  /** Real env files to deny, besides the root and app-folder env files; default []. */
  realEnvFiles?: string[];
  /** Fixed robot-only settings, added after the template's (they win); default {}. */
  robotEnv?: Record<string, string>;
  /** How the app starts, run from appDir; default "npm run dev". */
  devCommand?: string;
  /** Where the dev server answers (localhost only); default "http://localhost:3000". */
  devUrl?: string;
}

/** targetRepo.local with every default filled in. */
export interface LocalProfile {
  appDir: string;
  versionFile: string | null;
  envTemplate: { path: string; format: EnvTemplateFormat };
  realEnvFiles: string[];
  robotEnv: Record<string, string>;
  devCommand: string;
  devUrl: string;
}

export interface GitHubConfig {
  /**
   * dev-loop's first GitHub write surface (addComment/closeIssue on the
   * mirror Issue research-loop already created). One target repo per
   * project config, same granularity as targetRepo -- derived from the
   * same codebase this repo's ticket-to-pr operates on, not a separate
   * system. Mirrors research-loop's own Config.github.repo field exactly.
   */
  /** "owner/repo" shorthand, e.g. "fandango/webtarsthree" -- passed
   * directly to `gh`'s own --repo flag, which accepts this exact shape. */
  repo: string;
}

/**
 * Shape of pipeline.loop.config.json -- loop-mechanics settings (how the
 * `main.ts` process behaves), kept separate from pipeline.<project>.config.json
 * (which project/Jira/repo it points at) since the two vary independently:
 * one loop-config file per repo checkout, not one per project.
 */
export interface LoopConfig {
  /** Seconds to sleep between polls when the queue is empty. */
  pollIntervalSec: number;
  /**
   * Seconds to wait after a run completes before polling again -- gives
   * Jira's search index time to reflect a just-written status transition
   * before the next poll can re-match the same ticket (confirmed cause of
   * a duplicate run landing ~2s after TARS-1389/1390/1393 each landed).
   */
  postRunDelaySec: number;
}

/**
 * Shape of pipeline.<project>.config.json (2.0.0, spec section 6.4): one file
 * per project, both roles. Validated by core/config.ts validateConfig; the
 * v1 per-repo shape is archived under docs/changelog/legacy-config/.
 */
export interface Config {
  targetRepo: TargetRepoConfig;
  github: GitHubConfig;
  jira: JiraConfig;
  roles: {
    research: RoleSettings & {
      /** The label a green research verdict swaps the ticket to; equals roles.dev.triggerLabel. */
      handoffLabel: string;
    };
    dev: RoleSettings & { codeReviewFields: CodeReviewFieldsConfig };
  };
  ceilings: CeilingsConfig;
  /** Optional sandbox for agent spawns; absent means the none adapter. */
  sandbox?: SandboxConfig;
}

/** Per-run limits a role enforces (shape of ceilings.ts CeilingLimits). */
export interface RoleLimits {
  maxRunsPerDay: number;
  maxCostPerRunUsd: number;
  runTimeoutMin: number;
}

/** Everything one role reads from the config; built by core/config.ts roleView. */
interface RoleViewBase {
  pollJql: string;
  triggerLabel: string;
  repoLabel: string;
  claimStatus: ClaimStatusConfig;
  statusNames: StatusNamesConfig;
  limits: RoleLimits;
}

export interface ResearchView extends RoleViewBase {
  handoffLabel: string;
}

export interface DevView extends RoleViewBase {
  codeReviewFields: CodeReviewFieldsConfig;
}

export type RoleView = ResearchView | DevView;
