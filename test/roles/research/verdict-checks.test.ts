import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkResearchVerdict, groundCompleted, readResearchFacts, type ResearchFacts } from "../../../src/roles/research/verdict-checks.ts";
import type { AttachmentManifest } from "../../../src/core/attachments.ts";
import type { Verdict } from "../../../src/core/types.ts";

const GROUND = '{"ts":"t","phase":"triage","event":"phase_start","detail":""}\n{"ts":"t","phase":"ground","event":"phase_end","detail":"done"}\n';
const TRIAGE_ONLY = '{"ts":"t","phase":"triage","event":"phase_start","detail":""}\n';

const ready = (o: Partial<Verdict> = {}): Verdict => ({ outcome: "ready", phase_reached: "verify", failure_category: null, detail: "ok", ...o });
const tooLarge = (o: Partial<Verdict> = {}): Verdict => ({ outcome: "bounced", phase_reached: "plan", failure_category: "too_large", detail: "big", ...o });

function manifest(entries: AttachmentManifest["attachments"], error?: string): AttachmentManifest {
  return { ticket: "MC-1", dir: "/run/attachments", attachments: entries, ...(error ? { error } : {}) };
}
const fetched = (filename: string) => ({ id: filename, filename, size: 1, status: "fetched" as const, path: `/run/attachments/${filename}` });

function facts(o: Partial<ResearchFacts> = {}): ResearchFacts {
  return { progressRaw: GROUND, manifest: null, coverageWarnsSoFar: 0, coverageWarnRuns: 5, ...o };
}

const evidenceA = { criterion: "A" as const, comparison_tickets: [], risk_factors: [], split: ["MC-1a: list", "MC-1b: detail"] };
const evidenceB = { criterion: "B" as const, comparison_tickets: ["TARS-1554"], risk_factors: ["async or stateful UI"] };

describe("checkResearchVerdict: too_large", () => {
  it("too_large without a ground phase_end is refused", () => {
    const r = checkResearchVerdict(tooLarge({ size_evidence: evidenceB }), facts({ progressRaw: TRIAGE_ONLY }));
    expect(r).toMatchObject({ action: "refuse", check: "too_large_ungrounded" });
    expect(r.action === "refuse" && r.detail).toContain("ground");
  });
  it("missing progress.jsonl counts as ungrounded", () => {
    expect(checkResearchVerdict(tooLarge({ size_evidence: evidenceB }), facts({ progressRaw: null }))).toMatchObject({ check: "too_large_ungrounded" });
  });
  it("too_large with grounding but no size_evidence is refused", () => {
    expect(checkResearchVerdict(tooLarge(), facts())).toMatchObject({ action: "refuse", check: "too_large_no_evidence" });
  });
  it("criterion A needs a split of 2+ parts", () => {
    const r = checkResearchVerdict(tooLarge({ size_evidence: { ...evidenceA, split: ["only one"] } }), facts());
    expect(r).toMatchObject({ action: "refuse", check: "too_large_no_evidence" });
  });
  it("criterion B needs a comparison ticket and a risk factor", () => {
    expect(checkResearchVerdict(tooLarge({ size_evidence: { ...evidenceB, comparison_tickets: [] } }), facts())).toMatchObject({ check: "too_large_no_evidence" });
    expect(checkResearchVerdict(tooLarge({ size_evidence: { ...evidenceB, risk_factors: [] } }), facts())).toMatchObject({ check: "too_large_no_evidence" });
  });
  it("grounded too_large with evidence is accepted", () => {
    expect(checkResearchVerdict(tooLarge({ size_evidence: evidenceA }), facts())).toEqual({ action: "accept" });
    expect(checkResearchVerdict(tooLarge({ size_evidence: evidenceB }), facts())).toEqual({ action: "accept" });
  });
});

describe("groundCompleted", () => {
  it("garbage lines are skipped, not thrown", () => {
    expect(groundCompleted('not json\n{"phase":"ground","event":"phase_end"}')).toBe(true);
  });
  it("a ground phase_start alone is not grounding", () => {
    expect(groundCompleted('{"phase":"ground","event":"phase_start"}\n')).toBe(false);
    expect(groundCompleted(null)).toBe(false);
  });
});

describe("checkResearchVerdict: attachments on a ready verdict", () => {
  it("a skipped attachment bounces blocked, naming it and the reason", () => {
    const m = manifest([{ id: "1", filename: "build.zip", size: 1, status: "skipped", reason: "type .zip is not fetched" }]);
    const r = checkResearchVerdict(ready(), facts({ manifest: m }));
    expect(r.action).toBe("bounce_blocked");
    expect(r.action === "bounce_blocked" && r.detail).toContain("build.zip");
    expect(r.action === "bounce_blocked" && r.detail).toContain("type .zip is not fetched");
  });
  it("a failed attachment bounces blocked with its error", () => {
    const m = manifest([{ id: "1", filename: "mock.html", size: 1, status: "failed", error: "Jira request failed: 403" }]);
    const r = checkResearchVerdict(ready(), facts({ manifest: m }));
    expect(r.action === "bounce_blocked" && r.detail).toContain("Jira request failed: 403");
  });
  it("a manifest that failed to list bounces blocked", () => {
    const r = checkResearchVerdict(ready(), facts({ manifest: manifest([], "Jira 503") }));
    expect(r.action).toBe("bounce_blocked");
    expect(r.action === "bounce_blocked" && r.detail).toContain("Jira 503");
  });
  it("no manifest, or no attachments, needs no coverage", () => {
    expect(checkResearchVerdict(ready(), facts({ manifest: null }))).toEqual({ action: "accept" });
    expect(checkResearchVerdict(ready(), facts({ manifest: manifest([]) }))).toEqual({ action: "accept" });
  });
  it("fetched attachments with no coverage warn while under the warn count", () => {
    const r = checkResearchVerdict(ready(), facts({ manifest: manifest([fetched("mock.html")]), coverageWarnsSoFar: 4 }));
    expect(r).toMatchObject({ action: "accept", check: "coverage_warned" });
  });
  it("…and are refused once the count is reached, naming the file", () => {
    const r = checkResearchVerdict(ready(), facts({ manifest: manifest([fetched("mock.html")]), coverageWarnsSoFar: 5 }));
    expect(r).toMatchObject({ action: "refuse", check: "coverage_missing" });
    expect(r.action === "refuse" && r.detail).toContain("mock.html");
  });
  it("coverageWarnRuns 0 refuses from the first run", () => {
    expect(checkResearchVerdict(ready(), facts({ manifest: manifest([fetched("a.png")]), coverageWarnRuns: 0 }))).toMatchObject({ action: "refuse" });
  });
  it("coverage must name every fetched attachment", () => {
    const v = ready({ attachment_coverage: [{ attachment: "a.png", kind: "design", mapped_to: ["AC1"], out_of_scope: [] }] });
    const r = checkResearchVerdict(v, facts({ manifest: manifest([fetched("a.png"), fetched("b.html")]), coverageWarnRuns: 0 }));
    expect(r).toMatchObject({ action: "refuse", check: "coverage_missing" });
    expect(r.action === "refuse" && r.detail).toContain("b.html");
    expect(r.action === "refuse" && r.detail).not.toContain("a.png");
  });
  it("coverage matches the manifest filename or the path's basename", () => {
    const m = manifest([{ id: "2", filename: "a.json", size: 1, status: "fetched", path: "/run/attachments/2-a.json" }, fetched("Mock.HTML")]);
    const v = ready({ attachment_coverage: [
      { attachment: "2-a.json", kind: "data", mapped_to: ["AC3"], out_of_scope: [] },
      { attachment: "Mock.HTML", kind: "design", mapped_to: [], out_of_scope: ["dark mode (shown in the mockup)"] },
    ] });
    expect(checkResearchVerdict(v, facts({ manifest: m, coverageWarnRuns: 0 }))).toEqual({ action: "accept" });
  });
  it("an entry with neither mapped_to nor out_of_scope does not count", () => {
    const v = ready({ attachment_coverage: [{ attachment: "a.png", kind: "design", mapped_to: [], out_of_scope: [] }] });
    expect(checkResearchVerdict(v, facts({ manifest: manifest([fetched("a.png")]), coverageWarnRuns: 0 }))).toMatchObject({ action: "refuse" });
  });
});

describe("checkResearchVerdict: everything else passes untouched", () => {
  it("other bounces and errors are accepted, even with unreadable attachments", () => {
    const m = manifest([], "Jira 503");
    for (const v of [
      { outcome: "bounced", phase_reached: "plan", failure_category: "spec_ambiguous", detail: "q" },
      { outcome: "error", phase_reached: "intake", failure_category: "agent_error", detail: "x" },
    ] as Verdict[]) {
      expect(checkResearchVerdict(v, facts({ manifest: m, progressRaw: null }))).toEqual({ action: "accept" });
    }
  });
});

describe("readResearchFacts", () => {
  it("reads progress.jsonl and attachments.json; missing or bad files are null, never a throw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rfacts-"));
    try {
      expect(await readResearchFacts(dir, 2, 5)).toEqual({ progressRaw: null, manifest: null, coverageWarnsSoFar: 2, coverageWarnRuns: 5 });
      await writeFile(join(dir, "progress.jsonl"), GROUND);
      await writeFile(join(dir, "attachments.json"), "{not json");
      const f = await readResearchFacts(dir, 0, 5);
      expect(f.progressRaw).toBe(GROUND);
      expect(f.manifest).toBeNull();
      await writeFile(join(dir, "attachments.json"), JSON.stringify(manifest([fetched("a.png")])));
      expect((await readResearchFacts(dir, 0, 5)).manifest?.attachments).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
