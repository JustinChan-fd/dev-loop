// The fixture grader (eval fixtures). Pure: a fixture run's facts in,
// `{pass, reasons}` out, the same shape as evals/check-*.mjs. It reuses the
// loop's own checks (checkResearchVerdict's result, groundCompleted) and never
// re-implements them: a fixture grades what the loop would have done.

import { uncoveredAttachments, type CheckResult, type VerdictCheck } from "../roles/research/verdict-checks.ts";
import type { AttachmentManifest } from "../core/attachments.ts";
import type { TShirtSize, Verdict } from "../core/types.ts";

export type FixtureOutcome = "ready" | "bounced" | "error";
export type LoopAction = CheckResult["action"];

export interface Expectation {
  outcomes?: FixtureOutcome[];
  failureCategory?: { allow?: string[]; forbid?: string[] };
  loopAction?: LoopAction[];
  forbidVerdictCheck?: VerdictCheck[];
  groundedBeforeScope?: boolean;
  coverageComplete?: boolean;
  sizeEstimate?: TShirtSize[];
  acCount?: { min?: number; max?: number };
  outbox?: { publishedSpec?: boolean; forbid?: string[]; require?: string[]; allowSpecWins?: boolean };
  maxCostUsd?: number;
  /** 0..1, default 1: the share of runs that must pass, to two decimals (0.67 is 2 of 3). */
  passRate?: number;
  /** Written as RUN_DIR/size-context.json for each run (default: the project's limits, no tickets). */
  sizeContext?: Record<string, unknown>;
}

export interface FixtureRun {
  /** parseVerdict(..., "refine") of the run's verdict.json, before the loop maps or refuses it. */
  verdict: Verdict;
  /** What checkResearchVerdict decided. */
  check: CheckResult;
  progressRaw: string | null;
  manifest: AttachmentManifest | null;
  /** Every outbox/ file the skill and the loop wrote. */
  outbox: Array<{ file: string; text: string }>;
  costUsd: number;
}

export interface Grade {
  pass: boolean;
  reasons: string[];
}

const OUTCOMES: readonly string[] = ["ready", "bounced", "error"];
const ACTIONS: readonly string[] = ["accept", "refuse", "bounce_blocked"];
const CHECKS: readonly string[] = ["too_large_ungrounded", "too_large_no_evidence", "coverage_missing", "coverage_warned", "attachment_unreadable"];
const SIZES: readonly string[] = ["S", "M", "L", "XL"];
const KEYS = new Set(["outcomes", "failureCategory", "loopAction", "forbidVerdictCheck", "groundedBeforeScope", "coverageComplete", "sizeEstimate", "acCount", "outbox", "maxCostUsd", "passRate", "sizeContext"]);
const SPEC_WINS = "/spec wins/i";
const PASS_RATE_TOLERANCE = 0.005;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `/body/flags` is a regex; anything else is plain text. Matching is case-insensitive either way. */
export function toPattern(p: string): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(p);
  if (m) return new RegExp(m[1]!, m[2]!.includes("i") ? m[2]! : `${m[2]}i`);
  return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function listOf(errors: string[], name: string, v: unknown, allowed?: readonly string[]): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0 && (!allowed || allowed.includes(x)))) {
    errors.push(`${name} must be a list of ${allowed ? allowed.join("|") : "non-empty strings"}`);
  }
}

export function validateExpectation(raw: unknown): { ok: true; expectation: Expectation } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ["expect.json must be a JSON object"] };
  const errors: string[] = [];
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) errors.push(`${k}: unknown field`);
  listOf(errors, "outcomes", raw.outcomes, OUTCOMES);
  listOf(errors, "loopAction", raw.loopAction, ACTIONS);
  listOf(errors, "forbidVerdictCheck", raw.forbidVerdictCheck, CHECKS);
  listOf(errors, "sizeEstimate", raw.sizeEstimate, SIZES);
  if (raw.failureCategory !== undefined) {
    if (!isObj(raw.failureCategory)) errors.push("failureCategory must be {allow?, forbid?}");
    else {
      listOf(errors, "failureCategory.allow", raw.failureCategory.allow);
      listOf(errors, "failureCategory.forbid", raw.failureCategory.forbid);
    }
  }
  for (const k of ["groundedBeforeScope", "coverageComplete"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "boolean") errors.push(`${k} must be true or false`);
  }
  if (raw.acCount !== undefined) {
    const a = raw.acCount;
    const okN = (n: unknown) => n === undefined || (Number.isInteger(n) && (n as number) >= 0);
    if (!isObj(a) || !okN(a.min) || !okN(a.max)) errors.push("acCount must be {min?, max?} with whole numbers >= 0");
  }
  if (raw.outbox !== undefined) {
    const o = raw.outbox;
    if (!isObj(o)) errors.push("outbox must be {publishedSpec?, forbid?, require?, allowSpecWins?}");
    else {
      for (const k of ["publishedSpec", "allowSpecWins"]) if (o[k] !== undefined && typeof o[k] !== "boolean") errors.push(`outbox.${k} must be true or false`);
      for (const k of ["forbid", "require"]) {
        listOf(errors, `outbox.${k}`, o[k]);
        if (Array.isArray(o[k])) {
          for (const p of o[k] as unknown[]) {
            try {
              if (typeof p === "string") toPattern(p);
            } catch {
              errors.push(`outbox.${k}: ${JSON.stringify(p)} is not a valid regex`);
            }
          }
        }
      }
    }
  }
  if (raw.maxCostUsd !== undefined && !(typeof raw.maxCostUsd === "number" && raw.maxCostUsd > 0)) errors.push("maxCostUsd must be a positive number");
  if (raw.passRate !== undefined && !(typeof raw.passRate === "number" && raw.passRate >= 0 && raw.passRate <= 1)) errors.push("passRate must be between 0 and 1");
  if (raw.sizeContext !== undefined && !isObj(raw.sizeContext)) errors.push("sizeContext must be an object");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, expectation: raw as Expectation };
}

/** progress.jsonl lines as objects; bad lines skipped. */
function lines(raw: string | null): Array<{ phase?: unknown; event?: unknown }> {
  if (!raw) return [];
  const out: Array<{ phase?: unknown; event?: unknown }> = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const v: unknown = JSON.parse(l);
      if (isObj(v)) out.push(v);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** True when phase `a` has a phase_end line before any line of phase `b` (b may never appear). */
export function phaseEndsBefore(progressRaw: string | null, a: string, b: string): boolean {
  for (const l of lines(progressRaw)) {
    if (l.phase === a && l.event === "phase_end") return true;
    if (l.phase === b) return false;
  }
  return false;
}

const isSpec = (o: { file: string; text: string }) => /-github-comment\.md$/.test(o.file) && /^## ✅ research-loop -/m.test(o.text);

export function gradeRun(exp: Expectation, run: FixtureRun): Grade {
  const reasons: string[] = [];
  const v = run.verdict;
  const outcome = v.outcome === "landed" ? "ready" : v.outcome;
  if (exp.outcomes && !exp.outcomes.includes(outcome as FixtureOutcome)) reasons.push(`outcome ${outcome}, expected one of ${exp.outcomes.join("|")}`);
  const cat = v.failure_category;
  if (exp.failureCategory?.forbid && cat !== null && exp.failureCategory.forbid.includes(cat)) reasons.push(`failure_category ${cat} is forbidden`);
  if (exp.failureCategory?.allow && v.outcome === "bounced" && (cat === null || !exp.failureCategory.allow.includes(cat))) {
    reasons.push(`failure_category ${cat}, expected one of ${exp.failureCategory.allow.join("|")}`);
  }
  if (exp.loopAction && !exp.loopAction.includes(run.check.action)) reasons.push(`loop action ${run.check.action}, expected one of ${exp.loopAction.join("|")}`);
  const check = "check" in run.check ? run.check.check : undefined;
  if (exp.forbidVerdictCheck && check !== undefined && exp.forbidVerdictCheck.includes(check)) reasons.push(`the loop's verdict check ${check} is forbidden`);
  if (exp.groundedBeforeScope && !phaseEndsBefore(run.progressRaw, "ground", "scope")) reasons.push("no ground phase_end before scope in progress.jsonl");
  if (exp.coverageComplete) {
    if (!run.manifest) reasons.push("coverageComplete: the run has no attachments.json to check against");
    else {
      const missing = uncoveredAttachments(v, run.manifest);
      if (missing.length > 0) reasons.push(`attachment_coverage does not cover: ${missing.join(", ")}`);
    }
  }
  if (exp.sizeEstimate) {
    if (v.size_estimate === undefined) reasons.push("no size_estimate in the verdict");
    else if (!exp.sizeEstimate.includes(v.size_estimate)) reasons.push(`size_estimate ${v.size_estimate}, expected one of ${exp.sizeEstimate.join("|")}`);
  }
  if (exp.acCount) {
    const n = v.ac_count;
    if (n === undefined) reasons.push("no ac_count in the verdict");
    else if ((exp.acCount.min !== undefined && n < exp.acCount.min) || (exp.acCount.max !== undefined && n > exp.acCount.max)) {
      reasons.push(`ac_count ${n} outside ${exp.acCount.min ?? 0}..${exp.acCount.max ?? "∞"}`);
    }
  }
  const ob = exp.outbox ?? {};
  if (ob.publishedSpec !== undefined && run.outbox.some(isSpec) !== ob.publishedSpec) {
    reasons.push(ob.publishedSpec ? "no ✅ spec was published to the outbox" : "a ✅ spec was published, expected none");
  }
  const forbid = [...(ob.forbid ?? []), ...(ob.allowSpecWins ? [] : [SPEC_WINS])];
  for (const p of forbid) {
    const re = toPattern(p);
    for (const o of run.outbox) if (re.test(o.text)) reasons.push(`outbox ${o.file} matches forbidden ${p}`);
  }
  for (const p of ob.require ?? []) {
    const re = toPattern(p);
    if (!run.outbox.some((o) => re.test(o.text))) reasons.push(`no outbox file matches required ${p}`);
  }
  if (exp.maxCostUsd !== undefined && run.costUsd > exp.maxCostUsd) reasons.push(`cost $${run.costUsd.toFixed(2)} > $${exp.maxCostUsd.toFixed(2)}`);
  return { pass: reasons.length === 0, reasons };
}

export function aggregate(exp: Expectation, grades: Grade[]): { pass: boolean; passRate: number; runs: number; reasons: string[] } {
  const runs = grades.length;
  const passed = grades.filter((g) => g.pass).length;
  const passRate = runs === 0 ? 0 : passed / runs;
  const reasons = grades.flatMap((g, i) => g.reasons.map((r) => `run ${i + 1}: ${r}`));
  // expect.json writes the bar to two decimals (0.67 for 2 of 3), so compare within half a hundredth.
  return { pass: runs > 0 && passRate >= (exp.passRate ?? 1) - PASS_RATE_TOLERANCE, passRate, runs, reasons };
}
