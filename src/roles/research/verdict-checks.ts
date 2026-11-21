// The loop's check of a research verdict before acting on it (bounce
// criteria v2). The agent judges size and coverage; this only checks the
// verdict carries the parts the rules require, against facts the loop wrote
// or the skill logged (progress.jsonl, attachments.json), and refuses rather
// than guessing. Pure, plus a reader that never throws.
//
//   - too_large needs a ground phase_end in progress.jsonl and size_evidence
//     (A: a split of 2+ parts; B: comparison tickets and risk factors).
//     Refused from day one.
//   - ready with an unreadable attachment (skipped, failed, or the listing
//     failed) is a `blocked` bounce: a fact from the loop's own manifest.
//   - ready with fetched attachments needs attachment_coverage naming each
//     one (mapped_to or out_of_scope non-empty). Warned and accepted for the
//     first coverageWarnRuns such verdicts, refused after.

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AttachmentManifest } from "../../core/attachments.ts";
import type { Verdict } from "../../core/types.ts";

export const DEFAULT_COVERAGE_WARN_RUNS = 5;

export type VerdictCheck = "too_large_ungrounded" | "too_large_no_evidence" | "coverage_missing" | "coverage_warned" | "attachment_unreadable";

export interface ResearchFacts {
  progressRaw: string | null;
  manifest: AttachmentManifest | null;
  /** Earlier research entries in this project's log with verdict_check "coverage_warned". */
  coverageWarnsSoFar: number;
  coverageWarnRuns: number;
}

export type CheckResult =
  | { action: "accept"; check?: "coverage_warned"; note?: string }
  | { action: "refuse"; check: VerdictCheck; detail: string }
  | { action: "bounce_blocked"; check: "attachment_unreadable"; detail: string };

/** True when progress.jsonl has a ground phase_end line. Bad lines are skipped. */
export function groundCompleted(progressRaw: string | null): boolean {
  if (!progressRaw) return false;
  for (const line of progressRaw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as { phase?: unknown; event?: unknown } | null;
      if (v && v.phase === "ground" && v.event === "phase_end") return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

function checkTooLarge(v: Verdict, f: ResearchFacts): CheckResult {
  if (!groundCompleted(f.progressRaw)) {
    return { action: "refuse", check: "too_large_ungrounded", detail: "too_large before grounding: progress.jsonl has no ground phase_end. Size is judged after Ground, against size-context.json." };
  }
  const e = v.size_evidence;
  if (!e) return { action: "refuse", check: "too_large_no_evidence", detail: "too_large without size_evidence (criterion A with a split, or B with comparison tickets and risk factors)." };
  if (e.criterion === "A" && (e.split?.length ?? 0) < 2) {
    return { action: "refuse", check: "too_large_no_evidence", detail: "too_large criterion A needs a drafted split of 2 or more tickets in size_evidence.split." };
  }
  if (e.criterion === "B" && (e.comparison_tickets.length === 0 || e.risk_factors.length === 0)) {
    return { action: "refuse", check: "too_large_no_evidence", detail: "too_large criterion B needs comparison_tickets from size-context.json and at least one risk factor." };
  }
  return { action: "accept" };
}

function checkReady(v: Verdict, f: ResearchFacts): CheckResult {
  const m = f.manifest;
  if (!m) return { action: "accept" };
  const unreadable: string[] = [];
  if (m.error) unreadable.push(`the attachment list could not be read (${m.error})`);
  for (const a of m.attachments) {
    if (a.status === "skipped") unreadable.push(`${a.filename}: skipped (${a.reason})`);
    if (a.status === "failed") unreadable.push(`${a.filename}: failed (${a.error})`);
  }
  if (unreadable.length > 0) {
    return { action: "bounce_blocked", check: "attachment_unreadable", detail: `attachment(s) could not be read: ${unreadable.join("; ")}` };
  }
  const fetched = m.attachments.filter((a) => a.status === "fetched");
  if (fetched.length === 0) return { action: "accept" };
  const covered = new Set((v.attachment_coverage ?? []).filter((c) => c.mapped_to.length > 0 || c.out_of_scope.length > 0).map((c) => c.attachment));
  const missing = fetched.filter((a) => !covered.has(a.filename) && !(a.status === "fetched" && covered.has(basename(a.path)))).map((a) => a.filename);
  if (missing.length === 0) return { action: "accept" };
  const what = `attachment_coverage does not cover: ${missing.join(", ")}`;
  if (f.coverageWarnsSoFar < f.coverageWarnRuns) {
    return { action: "accept", check: "coverage_warned", note: `${what} (warning ${f.coverageWarnsSoFar + 1} of ${f.coverageWarnRuns}; refused after that)` };
  }
  return { action: "refuse", check: "coverage_missing", detail: `${what}. Each fetched attachment maps to ACs or named out-of-scope lines.` };
}

export function checkResearchVerdict(v: Verdict, facts: ResearchFacts): CheckResult {
  if (v.outcome === "bounced" && v.failure_category === "too_large") return checkTooLarge(v, facts);
  if (v.outcome === "ready" || v.outcome === "landed") return checkReady(v, facts);
  return { action: "accept" };
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function asManifest(raw: string | null): AttachmentManifest | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<AttachmentManifest> | null;
    return v && Array.isArray(v.attachments) ? (v as AttachmentManifest) : null;
  } catch {
    return null;
  }
}

/** RUN_DIR's progress.jsonl and attachments.json; missing or bad means null. Never throws. */
export async function readResearchFacts(runDir: string, coverageWarnsSoFar: number, coverageWarnRuns: number): Promise<ResearchFacts> {
  return {
    progressRaw: await readOrNull(join(runDir, "progress.jsonl")),
    manifest: asManifest(await readOrNull(join(runDir, "attachments.json"))),
    coverageWarnsSoFar,
    coverageWarnRuns,
  };
}
