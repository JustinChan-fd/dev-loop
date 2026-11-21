import { describe, expect, it } from "vitest";
import { findPendingHandoffs } from "../../src/worker/handoff.ts";
import type { IterationRecord, PhaseEntry } from "../../src/core/iteration-log.ts";

function phase(o: Partial<PhaseEntry> = {}): PhaseEntry {
  return {
    role: "research",
    skill: "ticket-refine",
    skill_version: "s",
    model: "sonnet",
    started: "2026-11-11T01:00:00.000Z",
    ended: "2026-11-11T01:10:00.000Z",
    outcome: "landed",
    phase_reached: "verify",
    cost_usd: 1,
    tokens: { in: 1, out: 1 },
    failure_category: null,
    detail: "d",
    pr: null,
    run_dir: "x",
    ...o,
  };
}

function rec(ticket: string, ended: string, phases: PhaseEntry[], o: Partial<IterationRecord> = {}): IterationRecord {
  return { ticket, session: "dev-1", loop_version: "2.0.0", started: ended, ended, outcome: "landed", phases, ...o };
}

const dev = (o: Partial<PhaseEntry> = {}) => phase({ role: "dev", skill: "ticket-to-pr", ...o });

describe("findPendingHandoffs", () => {
  it("handoff done → excluded", () => {
    expect(findPendingHandoffs([rec("TARS-1", "2026-11-11T01:00:00.000Z", [phase({ handoff: "done" })])])).toEqual([]);
  });

  it("a later dev record → excluded", () => {
    expect(
      findPendingHandoffs([
        rec("TARS-1", "2026-11-11T01:00:00.000Z", [phase({ handoff: "failed" })], { outcome: "handoff-pending" }),
        rec("TARS-1", "2026-11-11T02:00:00.000Z", [dev()]),
      ]),
    ).toEqual([]);
  });

  it("handoff failed → included", () => {
    expect(
      findPendingHandoffs([rec("TARS-1", "2026-11-11T01:00:00.000Z", [phase({ handoff: "failed" })], { outcome: "handoff-pending" })]),
    ).toEqual(["TARS-1"]);
  });

  it("handoff skipped-ceiling → included", () => {
    expect(
      findPendingHandoffs([
        rec("TARS-2", "2026-11-11T01:00:00.000Z", [phase({ handoff: "skipped-ceiling" })], { outcome: "handoff-pending" }),
      ]),
    ).toEqual(["TARS-2"]);
  });

  it("a landed research entry with no handoff field (research-only mode) → included", () => {
    expect(findPendingHandoffs([rec("TARS-3", "2026-11-11T01:00:00.000Z", [phase()])])).toEqual(["TARS-3"]);
  });

  it("a later handoff-dropped record (ticket closed in Jira) resolves it", () => {
    expect(
      findPendingHandoffs([
        rec("TARS-1", "2026-11-11T01:00:00.000Z", [phase()]),
        rec("TARS-1", "2026-11-11T02:00:00.000Z", [], { outcome: "handoff-dropped" }),
      ]),
    ).toEqual([]);
  });

  it("a later phase-less handoff-pending record (a step-1 retry failure) does not cancel it", () => {
    expect(
      findPendingHandoffs([
        rec("TARS-1", "2026-11-11T01:00:00.000Z", [phase()]),
        rec("TARS-1", "2026-11-11T02:00:00.000Z", [], { outcome: "handoff-pending" }),
      ]),
    ).toEqual(["TARS-1"]);
  });

  it("only the latest research entry counts: a later bounced re-refine → excluded", () => {
    expect(
      findPendingHandoffs([
        rec("TARS-1", "2026-11-11T01:00:00.000Z", [phase({ handoff: "failed" })]),
        rec("TARS-1", "2026-11-11T02:00:00.000Z", [phase({ outcome: "bounced" })], { outcome: "bounced" }),
      ]),
    ).toEqual([]);
  });

  it("research + dev in one record → excluded; bounced research → excluded; keeps first-seen order", () => {
    expect(
      findPendingHandoffs([
        rec("TARS-5", "2026-11-11T01:00:00.000Z", [phase({ handoff: "failed" })]),
        rec("TARS-1", "2026-11-11T01:00:00.000Z", [phase({ handoff: "done" }), dev()]),
        rec("TARS-2", "2026-11-11T01:00:00.000Z", [phase({ outcome: "bounced" })]),
        rec("TARS-4", "2026-11-11T01:30:00.000Z", [phase({ handoff: "skipped-ceiling" })]),
      ]),
    ).toEqual(["TARS-5", "TARS-4"]);
  });
});
