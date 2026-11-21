// Parses a skill's verdict.json into a Verdict. This parser must NEVER
// throw on bad input - missing or malformed verdict.json is an expected
// failure mode (the agent crashed, wrote garbage, or wrote nothing) and
// must be represented as outcome "error" / failure_category "agent_error",
// not as an exception that takes down the loop.
//
// Two shape profiles, because the two skills write different schemas. The
// profile is required; a call that omits it at runtime gets "executor":
//   - "refine" (ticket-refine): only outcome/phase_reached/
//     failure_category/detail are required, and outcome may be "ready".
//   - "executor" (ticket-to-pr): additionally requires every executor field
//     (red_confirmed, verify_loops, retries, skill_version, model, pr,
//     cost_usd, tokens) and rejects "ready". The dev role reads those fields
//     unconditionally, so a verdict missing one is an agent_error, not a
//     Verdict with silently-undefined fields.

import { readFile } from "node:fs/promises";
import { TICKET_KEY } from "./paths.ts";
import type {
  AttachmentCoverageEntry,
  ExecutorVerdict,
  FollowUp,
  PhaseReached,
  RunOutcome,
  SizeDelta,
  SizeEvidence,
  SizeTrajectory,
  TShirtSize,
  Verdict,
  VerdictOutcome,
} from "./types.ts";

/** Which skill's verdict.json schema to validate against. */
export type VerdictProfile = "refine" | "executor";

const RUN_OUTCOMES: RunOutcome[] = ["landed", "bounced", "error", "killed"];
const VERDICT_OUTCOMES: VerdictOutcome[] = [...RUN_OUTCOMES, "ready"];
const VALID_PHASES: PhaseReached[] = [
  "intake",
  "plan",
  "red",
  "green",
  "verify",
  "pr",
];
const VALID_TSHIRTS: TShirtSize[] = ["S", "M", "L", "XL"];
const VALID_DELTAS: SizeDelta[] = ["grew", "shrank", "unchanged"];

function isValidVerdictShape(value: unknown, extraOutcome?: string): value is Verdict | ExecutorVerdict {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  if (
    !VERDICT_OUTCOMES.includes(v.outcome as VerdictOutcome) &&
    !(extraOutcome !== undefined && v.outcome === extraOutcome)
  ) {
    return false;
  }
  if (!VALID_PHASES.includes(v.phase_reached as PhaseReached)) return false;
  if (v.failure_category !== null && typeof v.failure_category !== "string") {
    return false;
  }
  if (typeof v.detail !== "string") return false;

  return true;
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isValidReadyToPush(v: Record<string, unknown>): boolean {
  const { branch, pr_title, pr_body } = v;
  if (typeof branch !== "string" || !BRANCH_NAME.test(branch) || branch.includes("..")) return false;
  return (
    typeof pr_title === "string" && pr_title.length > 0 && pr_title.length <= 200 && !/["`$\\\n\r]/.test(pr_title) &&
    typeof pr_body === "string" && pr_body.length > 0
  );
}

function isValidExecutorShape(v: Verdict | ExecutorVerdict): v is ExecutorVerdict {
  if (v.outcome === "ready_to_push") {
    if (!isValidReadyToPush(v as unknown as Record<string, unknown>)) return false;
  } else if (!RUN_OUTCOMES.includes(v.outcome as RunOutcome)) {
    return false;
  }
  if (typeof v.red_confirmed !== "boolean") return false;
  if (typeof v.verify_loops !== "number") return false;
  if (typeof v.retries !== "number") return false;
  if (typeof v.skill_version !== "string") return false;
  if (typeof v.model !== "string") return false;
  if (v.pr !== null && typeof v.pr !== "string") return false;
  if (typeof v.cost_usd !== "number") return false;

  if (typeof v.tokens !== "object" || v.tokens === null) return false;
  const tokens = v.tokens as Record<string, unknown>;
  if (typeof tokens.in !== "number" || typeof tokens.out !== "number") {
    return false;
  }

  return true;
}

function isFollowUp(value: unknown): value is FollowUp {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.ticket !== "string" || !TICKET_KEY.test(v.ticket)) return false;
  return v.pr === null || (typeof v.pr === "string" && v.pr.length > 0);
}

const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);

function isSizeEvidence(value: unknown): value is SizeEvidence {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.criterion === "A" || v.criterion === "B") && strList(v.comparison_tickets) && strList(v.risk_factors) && (v.split === undefined || strList(v.split));
}

function isCoverageEntry(value: unknown): value is AttachmentCoverageEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.attachment === "string" && v.attachment.length > 0 && ["design", "data", "other"].includes(v.kind as string) && strList(v.mapped_to) && strList(v.out_of_scope);
}

/**
 * Parses a shadow-mode `size_trajectory` value. Fully independent of the
 * shape checks -- a malformed trajectory returns null and must never flip a
 * Verdict's `outcome` to "error". Pure telemetry: nothing downstream acts
 * on the parsed value yet.
 */
export function parseSizeTrajectory(value: unknown): SizeTrajectory | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  if (!VALID_TSHIRTS.includes(v.step4_tshirt as TShirtSize)) return null;
  if (!VALID_DELTAS.includes(v.delta as SizeDelta)) return null;
  if (typeof v.final_score !== "number" || !Number.isFinite(v.final_score)) {
    return null;
  }
  if (v.final_score < 0 || v.final_score > 10) return null;

  return {
    step4_tshirt: v.step4_tshirt as TShirtSize,
    delta: v.delta as SizeDelta,
    final_score: v.final_score,
  };
}

/**
 * Build the canonical "agent_error" Verdict used whenever verdict.json is
 * missing or malformed. Centralized so every error path produces an
 * identical shape. It carries every executor field (zeroed), so it is a
 * valid result for both profiles.
 */
export function agentErrorVerdict(detail: string): ExecutorVerdict & Verdict {
  return {
    outcome: "error",
    phase_reached: "intake",
    failure_category: "agent_error",
    detail,
    red_confirmed: false,
    verify_loops: 0,
    retries: 0,
    skill_version: "",
    model: "",
    pr: null,
    cost_usd: 0,
    tokens: { in: 0, out: 0 },
  };
}

/**
 * Parse a verdict.json file's raw string contents (or undefined/null if
 * the file was missing) into a Verdict. On any parse/shape failure,
 * returns a Verdict with outcome "error" and failure_category
 * "agent_error" instead of throwing.
 */
export function parseVerdict(raw: string | null | undefined, profile: "refine"): Verdict;
export function parseVerdict(raw: string | null | undefined, profile: "executor"): ExecutorVerdict;
export function parseVerdict(
  raw: string | null | undefined,
  profile: VerdictProfile,
): Verdict | ExecutorVerdict {
  if (raw === null || raw === undefined) {
    return agentErrorVerdict("verdict.json was missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return agentErrorVerdict("verdict.json contained malformed JSON");
  }

  // Fail closed: anything but an explicit "refine" (including a missing
  // profile from an untyped caller) gets the strict executor check.
  if (
    !isValidVerdictShape(parsed, profile === "refine" ? undefined : "ready_to_push") ||
    (profile !== "refine" && !isValidExecutorShape(parsed))
  ) {
    return agentErrorVerdict(
      "verdict.json did not match the expected Verdict shape",
    );
  }

  // size_trajectory is parsed independently of the shape check above --
  // a malformed trajectory must never flip outcome to "error". Sanitize
  // it here, at the parse boundary, so nothing downstream (RunLogLine
  // carry-over, runs.jsonl) ever sees an unvalidated value.
  const verdict = parsed as ExecutorVerdict;
  if (verdict.outcome === "ready_to_push") {
    const raw = parsed as unknown as Record<string, string>;
    verdict.ready_to_push = { branch: raw.branch!, pr_title: raw.pr_title!, pr_body: raw.pr_body! };
  }
  if (verdict.size_trajectory !== undefined) {
    const sanitized = parseSizeTrajectory(verdict.size_trajectory);
    if (sanitized === null) {
      delete verdict.size_trajectory;
    } else {
      verdict.size_trajectory = sanitized;
    }
  }

  // preexisting_failures is optional telemetry, like size_trajectory: keep
  // only a non-empty-string array, never flip the outcome over it.
  if (verdict.preexisting_failures !== undefined) {
    const v: unknown = verdict.preexisting_failures;
    const ok = Array.isArray(v) && v.every((t) => typeof t === "string" && t.length > 0);
    if (!ok) delete verdict.preexisting_failures;
  }
  // size_evidence / attachment_coverage: shape-checked here, dropped if
  // malformed. Whether one is REQUIRED is roles/research/verdict-checks.ts's job.
  if (verdict.size_evidence !== undefined) {
    // Criterion A needs no comparison tickets or risk factors: missing lists default to [].
    const e = verdict.size_evidence as unknown;
    if (typeof e === "object" && e !== null) {
      const o = e as Record<string, unknown>;
      verdict.size_evidence = { ...o, comparison_tickets: o.comparison_tickets ?? [], risk_factors: o.risk_factors ?? [] } as SizeEvidence;
    }
    if (!isSizeEvidence(verdict.size_evidence)) delete verdict.size_evidence;
  }
  if (verdict.attachment_coverage !== undefined && !(Array.isArray(verdict.attachment_coverage) && verdict.attachment_coverage.every(isCoverageEntry))) {
    delete verdict.attachment_coverage;
  }
  // size_estimate / ac_count: research telemetry (bounce criteria v2), same rule.
  if (verdict.size_estimate !== undefined && !VALID_TSHIRTS.includes(verdict.size_estimate)) delete verdict.size_estimate;
  if (verdict.ac_count !== undefined && !(Number.isInteger(verdict.ac_count) && verdict.ac_count >= 0)) delete verdict.ac_count;
  if (verdict.follow_up !== undefined && !isFollowUp(verdict.follow_up)) {
    delete verdict.follow_up;
  }

  return verdict;
}

/**
 * Read and parse verdict.json from disk at the given path. Missing file,
 * unreadable file, or malformed JSON all resolve to an "error" /
 * "agent_error" Verdict rather than rejecting.
 */
export async function readVerdictFile(path: string, profile: "refine"): Promise<Verdict>;
export async function readVerdictFile(path: string, profile: "executor"): Promise<ExecutorVerdict>;
export async function readVerdictFile(
  path: string,
  profile: VerdictProfile,
): Promise<Verdict | ExecutorVerdict> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return agentErrorVerdict(`verdict.json could not be read: ${message}`);
  }
  return profile === "refine" ? parseVerdict(raw, "refine") : parseVerdict(raw, "executor");
}

/**
 * research-loop's names for the same functions (research-loop/src/verdict.ts
 * called them errorVerdict/readVerdict; dev-loop called them
 * agentErrorVerdict/readVerdictFile). Same function objects, so the role
 * code ported in Task 4 can keep its own call sites.
 */
export const errorVerdict = agentErrorVerdict;
export const readVerdict = readVerdictFile;
