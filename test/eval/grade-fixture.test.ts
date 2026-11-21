import { describe, expect, it } from "vitest";
import { aggregate, gradeRun, phaseEndsBefore, validateExpectation, type FixtureRun } from "../../src/eval/grade-fixture.ts";
import { parseVerdict } from "../../src/core/verdict.ts";
import type { AttachmentManifest } from "../../src/core/attachments.ts";

const GROUNDED = [
  { phase: "triage", event: "phase_start" },
  { phase: "ground", event: "phase_end" },
  { phase: "scope", event: "note", detail: "step4_tshirt: M" },
].map((l) => JSON.stringify(l)).join("\n");
const UNGROUNDED = [{ phase: "triage", event: "phase_start" }, { phase: "scope", event: "note" }, { phase: "ground", event: "phase_end" }].map((l) => JSON.stringify(l)).join("\n");

const manifest = (files: string[]): AttachmentManifest => ({
  ticket: "FX-1",
  dir: "attachments",
  attachments: files.map((f, i) => ({ id: String(i), filename: f, size: 1, status: "fetched" as const, path: `attachments/${f}` })),
});

function run(over: Partial<FixtureRun> & { verdictJson?: Record<string, unknown> } = {}): FixtureRun {
  const v = over.verdictJson ?? { outcome: "ready", phase_reached: "verify", failure_category: null, detail: "ok", size_estimate: "M", ac_count: 10 };
  return {
    verdict: parseVerdict(JSON.stringify(v), "refine"),
    check: { action: "accept" },
    progressRaw: GROUNDED,
    manifest: null,
    outbox: [{ file: "001-github-comment.md", text: "## ✅ research-loop - spec" }],
    costUsd: 2,
    ...over,
  };
}

describe("validateExpectation", () => {
  it("accepts an empty object (every field optional)", () => {
    expect(validateExpectation({})).toEqual({ ok: true, expectation: {} });
  });
  it("accepts every documented field", () => {
    const e = {
      outcomes: ["ready", "bounced"],
      failureCategory: { allow: ["spec_ambiguous"], forbid: ["too_large"] },
      loopAction: ["accept"],
      forbidVerdictCheck: ["too_large_ungrounded"],
      groundedBeforeScope: true,
      coverageComplete: true,
      sizeEstimate: ["M", "L"],
      acCount: { min: 3, max: 20 },
      outbox: { publishedSpec: true, forbid: ["/variant C/i"], require: ["Out of scope"], allowSpecWins: false },
      maxCostUsd: 5,
      passRate: 0.67,
      sizeContext: { tickets: [] },
    };
    expect(validateExpectation(e).ok).toBe(true);
  });
  it("names each bad field", () => {
    const r = validateExpectation({ outcomes: ["maybe"], sizeEstimate: ["XXL"], passRate: 2, acCount: { min: -1 }, loopAction: ["shrug"], outbox: { forbid: ["/(/"] }, extra: 1 });
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.errors.join("\n") : "";
    for (const f of ["outcomes", "sizeEstimate", "passRate", "acCount", "loopAction", "outbox.forbid", "extra"]) expect(msg).toContain(f);
  });
  it("rejects a non-object", () => {
    expect(validateExpectation(null).ok).toBe(false);
    expect(validateExpectation([1]).ok).toBe(false);
  });
});

describe("phaseEndsBefore", () => {
  it("true when a's phase_end comes before b's first line", () => expect(phaseEndsBefore(GROUNDED, "ground", "scope")).toBe(true));
  it("false when b shows up first", () => expect(phaseEndsBefore(UNGROUNDED, "ground", "scope")).toBe(false));
  it("true when b never appears and a ended; false when a never ended", () => {
    expect(phaseEndsBefore(JSON.stringify({ phase: "ground", event: "phase_end" }), "ground", "scope")).toBe(true);
    expect(phaseEndsBefore(JSON.stringify({ phase: "scope", event: "note" }), "ground", "scope")).toBe(false);
    expect(phaseEndsBefore(null, "ground", "scope")).toBe(false);
  });
  it("skips bad lines", () => expect(phaseEndsBefore(`garbage\n${GROUNDED}`, "ground", "scope")).toBe(true));
});

describe("gradeRun", () => {
  it("passes an empty expectation, except the default spec-wins forbid", () => {
    expect(gradeRun({}, run())).toEqual({ pass: true, reasons: [] });
    const g = gradeRun({}, run({ outbox: [{ file: "001-github-comment.md", text: "Where they differ, this spec wins." }] }));
    expect(g.pass).toBe(false);
    expect(g.reasons.join()).toMatch(/001-github-comment\.md matches forbidden \/spec wins\/i/);
  });
  it("allowSpecWins turns the default forbid off", () => {
    expect(gradeRun({ outbox: { allowSpecWins: true } }, run({ outbox: [{ file: "a.md", text: "this spec wins" }] })).pass).toBe(true);
  });
  it("outcomes: ready counts as ready even after the loop maps it", () => {
    expect(gradeRun({ outcomes: ["ready"] }, run()).pass).toBe(true);
    const g = gradeRun({ outcomes: ["bounced"] }, run());
    expect(g.pass).toBe(false);
    expect(g.reasons[0]).toMatch(/outcome ready.*bounced/);
  });
  it("failureCategory allow and forbid", () => {
    const tl = run({ verdictJson: { outcome: "bounced", phase_reached: "plan", failure_category: "too_large", detail: "x" } });
    expect(gradeRun({ failureCategory: { forbid: ["too_large"] } }, tl).pass).toBe(false);
    expect(gradeRun({ failureCategory: { allow: ["spec_ambiguous"] } }, tl).pass).toBe(false);
    expect(gradeRun({ failureCategory: { allow: ["too_large"] } }, tl).pass).toBe(true);
    // null category (a ready verdict) is never "forbidden" and allow only applies to bounces.
    expect(gradeRun({ failureCategory: { allow: ["spec_ambiguous"], forbid: ["too_large"] } }, run()).pass).toBe(true);
  });
  it("loopAction and forbidVerdictCheck read the loop's own check", () => {
    const refused = run({ check: { action: "refuse", check: "too_large_ungrounded", detail: "d" } });
    expect(gradeRun({ loopAction: ["accept"] }, refused).reasons.join()).toMatch(/loop action refuse/);
    expect(gradeRun({ forbidVerdictCheck: ["too_large_ungrounded"] }, refused).pass).toBe(false);
    expect(gradeRun({ forbidVerdictCheck: ["coverage_warned"] }, run({ check: { action: "accept", check: "coverage_warned", note: "n" } })).pass).toBe(false);
  });
  it("groundedBeforeScope", () => {
    expect(gradeRun({ groundedBeforeScope: true }, run()).pass).toBe(true);
    expect(gradeRun({ groundedBeforeScope: true }, run({ progressRaw: UNGROUNDED })).reasons.join()).toMatch(/ground/);
  });
  it("coverageComplete: every fetched attachment named with a mapping", () => {
    const m = manifest(["a.html", "b.json"]);
    const v = { outcome: "ready", phase_reached: "verify", failure_category: null, detail: "ok" };
    const cov = (names: string[]) => names.map((n) => ({ attachment: n, kind: "design", mapped_to: ["AC1"], out_of_scope: [] }));
    expect(gradeRun({ coverageComplete: true }, run({ manifest: m, verdictJson: { ...v, attachment_coverage: cov(["a.html", "b.json"]) } })).pass).toBe(true);
    const g = gradeRun({ coverageComplete: true }, run({ manifest: m, verdictJson: { ...v, attachment_coverage: cov(["a.html"]) } }));
    expect(g.reasons.join()).toMatch(/b\.json/);
    // Matched by the fetched file's basename too, exactly as the loop's check does.
    const renamed: AttachmentManifest = { ticket: "FX-1", dir: "attachments", attachments: [{ id: "1", filename: "a b.html", size: 1, status: "fetched", path: "attachments/a_b.html" }] };
    expect(gradeRun({ coverageComplete: true }, run({ manifest: renamed, verdictJson: { ...v, attachment_coverage: cov(["a_b.html"]) } })).pass).toBe(true);
    // Nothing fetched: trivially complete. No manifest at all: not graded as complete.
    expect(gradeRun({ coverageComplete: true }, run({ manifest: { ticket: "FX-1", dir: "a", attachments: [] } })).pass).toBe(true);
    expect(gradeRun({ coverageComplete: true }, run()).reasons.join()).toMatch(/no attachments\.json/);
  });
  it("sizeEstimate and acCount; a missing value fails", () => {
    expect(gradeRun({ sizeEstimate: ["M"], acCount: { min: 5, max: 12 } }, run()).pass).toBe(true);
    expect(gradeRun({ sizeEstimate: ["XL"] }, run()).pass).toBe(false);
    expect(gradeRun({ acCount: { max: 9 } }, run()).pass).toBe(false);
    const bare = run({ verdictJson: { outcome: "ready", phase_reached: "verify", failure_category: null, detail: "ok" } });
    expect(gradeRun({ sizeEstimate: ["M"] }, bare).reasons.join()).toMatch(/no size_estimate/);
    expect(gradeRun({ acCount: { min: 1 } }, bare).reasons.join()).toMatch(/no ac_count/);
  });
  it("outbox: publishedSpec, require and forbid (regex or plain text)", () => {
    const ob = [
      { file: "001-github-comment.md", text: "## ✅ research-loop - spec\nOut of scope: variant C (shown in the mockup)" },
      { file: "002-jira-comment.md", text: "✅ research-loop - pointer" },
    ];
    expect(gradeRun({ outbox: { publishedSpec: true, require: ["/out of scope: variant c/i"], forbid: ["variant A is chosen"] } }, run({ outbox: ob })).pass).toBe(true);
    expect(gradeRun({ outbox: { publishedSpec: true } }, run({ outbox: [] })).reasons.join()).toMatch(/published/);
    expect(gradeRun({ outbox: { publishedSpec: false } }, run({ outbox: ob })).pass).toBe(false);
    expect(gradeRun({ outbox: { require: ["Variant B"] } }, run({ outbox: ob })).pass).toBe(false);
  });
  it("maxCostUsd", () => {
    expect(gradeRun({ maxCostUsd: 1 }, run()).reasons.join()).toMatch(/\$2\.00 > \$1\.00/);
  });
  it("collects every failing reason", () => {
    expect(gradeRun({ outcomes: ["bounced"], sizeEstimate: ["S"], maxCostUsd: 0.5 }, run()).reasons).toHaveLength(3);
  });
});

describe("aggregate", () => {
  const ok = { pass: true, reasons: [] };
  const bad = { pass: false, reasons: ["x"] };
  it("passes when the pass rate meets the expectation (default 1)", () => {
    expect(aggregate({}, [ok, ok])).toMatchObject({ pass: true, passRate: 1, runs: 2 });
    expect(aggregate({}, [ok, bad]).pass).toBe(false);
    expect(aggregate({ passRate: 0.5 }, [ok, bad])).toMatchObject({ pass: true, passRate: 0.5 });
  });
  it("2 of 3 meets a passRate of 0.67 (the bar is a share of runs, compared with a small tolerance)", () => {
    expect(aggregate({ passRate: 0.67 }, [ok, ok, bad]).pass).toBe(true);
    expect(aggregate({ passRate: 0.67 }, [ok, bad, bad]).pass).toBe(false);
    expect(aggregate({ passRate: 0.34 }, [ok, bad, bad]).pass).toBe(false);
    expect(aggregate({ passRate: 0.33 }, [ok, bad, bad]).pass).toBe(true);
  });
  it("no runs never passes", () => {
    expect(aggregate({}, [])).toMatchObject({ pass: false, runs: 0 });
  });
  it("lists the failing runs' reasons by run number", () => {
    expect(aggregate({}, [ok, bad]).reasons).toEqual(["run 2: x"]);
  });
});
