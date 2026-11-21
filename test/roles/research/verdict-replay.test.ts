// Replay tests (eval fixtures): real research run folders, saved under
// test/fixtures/replay/<name>/, go through the loop's own verdict path
// (parseVerdict -> readResearchFacts -> checkResearchVerdict) and the fixture
// grader. A rule change that would treat a real run differently fails here,
// for free. Add a folder to add a case; expected.json says what must happen.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseVerdict } from "../../../src/core/verdict.ts";
import { checkResearchVerdict, DEFAULT_COVERAGE_WARN_RUNS, readResearchFacts } from "../../../src/roles/research/verdict-checks.ts";
import { gradeRun, validateExpectation } from "../../../src/eval/grade-fixture.ts";

const ROOT = resolve(import.meta.dirname, "../../fixtures/replay");

interface Expected {
  source: string;
  cases: Array<{ coverageWarnsSoFar: number; check: { action: string; check?: string } }>;
  /** `reasons`: text each expected failure reason must contain (one per reason, same count). */
  grade?: { expect: unknown; pass: boolean; reasons?: string[] };
}

const names = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

describe("verdict replay: saved real runs through the loop's checks", () => {
  it("has the first four replays", () => {
    expect(names).toEqual(expect.arrayContaining(["mc-1435-ready-no-coverage", "mc-1435-unreadable-attachment", "mc-1435-xl-ungrounded", "mc-1718-ready"]));
  });

  for (const name of names) {
    const dir = join(ROOT, name);
    const exp = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
    const verdict = parseVerdict(readFileSync(join(dir, "verdict.json"), "utf8"), "refine");

    it(`${name}: verdict.json parses (never agent_error)`, () => {
      expect(verdict.failure_category).not.toBe("agent_error");
    });

    for (const c of exp.cases) {
      it(`${name}: with ${c.coverageWarnsSoFar} earlier coverage warnings the loop does ${c.check.action}${c.check.check ? ` (${c.check.check})` : ""}`, async () => {
        const facts = await readResearchFacts(dir, c.coverageWarnsSoFar, DEFAULT_COVERAGE_WARN_RUNS);
        const got = checkResearchVerdict(verdict, facts);
        expect({ action: got.action, ...("check" in got && got.check ? { check: got.check } : {}) }).toEqual(c.check);
      });
    }

    if (exp.grade) {
      const g = exp.grade;
      it(`${name}: the grader ${g.pass ? "passes" : "fails"} it`, async () => {
        const v = validateExpectation(g.expect);
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        const facts = await readResearchFacts(dir, 0, DEFAULT_COVERAGE_WARN_RUNS);
        const grade = gradeRun(v.expectation, { verdict, check: checkResearchVerdict(verdict, facts), progressRaw: facts.progressRaw, manifest: facts.manifest, outbox: [], costUsd: 0 });
        expect(grade.pass, grade.reasons.join("; ")).toBe(g.pass);
        if (g.pass) expect(grade.reasons).toEqual([]);
        else {
          // A failing replay must fail for the stated reasons, not just fail.
          expect(g.reasons?.length ?? 0).toBeGreaterThan(0);
          expect(grade.reasons).toHaveLength(g.reasons!.length);
          for (const r of g.reasons!) expect(grade.reasons.some((x) => x.includes(r)), `${r} in ${grade.reasons.join("; ")}`).toBe(true);
        }
      });
    }
  }
});
