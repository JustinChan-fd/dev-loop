import { describe, it, expect } from "vitest";
import { coverageWarnsSoFar } from "../../src/worker/cycle-steps.ts";
import type { IterationRecord, PhaseEntry } from "../../src/core/iteration-log.ts";

const phase = (o: Partial<PhaseEntry>): PhaseEntry => ({
  role: "research", skill: "ticket-refine", skill_version: "", model: "", started: "", ended: "", outcome: "landed",
  phase_reached: "verify", cost_usd: 0, tokens: { in: 0, out: 0 }, failure_category: null, detail: "", pr: null, run_dir: "", ...o,
});
const rec = (phases: PhaseEntry[]): IterationRecord => ({ ticket: "MC-1", session: "s", loop_version: "x", started: "", ended: "", outcome: "landed", phases });

describe("coverageWarnsSoFar", () => {
  it("counts research phases warned for coverage, across records, and nothing else", () => {
    expect(coverageWarnsSoFar([])).toBe(0);
    expect(coverageWarnsSoFar([
      rec([phase({ verdict_check: "coverage_warned" }), phase({ role: "dev", skill: "ticket-to-pr", verdict_check: "coverage_warned" })]),
      rec([phase({ verdict_check: "coverage_missing" }), phase({})]),
      rec([phase({ verdict_check: "coverage_warned" })]),
    ])).toBe(2);
  });
});
