import { describe, it, expect } from "vitest";
import { buildSizeContext, nearestRank, type DevRunFact } from "../../src/core/size-context.ts";
import { makeV2Config } from "../fixtures/config.ts";

const now = new Date("2026-11-20T12:00:00.000Z");
const config = makeV2Config();

function run(ticket: string, o: Partial<DevRunFact> = {}): DevRunFact {
  return {
    ticket, started: "2026-11-01T10:00:00.000Z", ended: "2026-11-01T10:20:00.000Z",
    outcome: "landed", cost_usd: 3, verify_loops: 1, pr: `https://github.com/o/r/pull/${ticket}`, diff_stats: null, ...o,
  };
}

describe("buildSizeContext", () => {
  it("no history gives empty stats plus the limits", () => {
    expect(buildSizeContext({ devRuns: [], research: [], sidecar: {}, config, now })).toEqual({
      generated: now.toISOString(),
      limits: { dev_max_cost_per_run_usd: 20, dev_run_timeout_min: 75, max_cost_per_ticket_usd: 50 },
      window: 30,
      stats: { tickets: 0, cost_usd: null, minutes: null },
      tickets: [],
    });
  });

  it("sums every dev run of a landed ticket", () => {
    const c = buildSizeContext({
      devRuns: [
        run("T-1", { outcome: "error", cost_usd: 2, started: "2026-11-01T09:00:00.000Z", ended: "2026-11-01T09:10:00.000Z", verify_loops: null, pr: null }),
        run("T-1", { cost_usd: 3, verify_loops: 2 }),
      ],
      research: [], sidecar: {}, config, now,
    });
    expect(c.tickets).toHaveLength(1);
    expect(c.tickets[0]).toMatchObject({ ticket: "T-1", cost_usd: 5, minutes: 30, dev_runs: 2, qa_loops: 2, landed: "2026-11-01T10:20:00.000Z" });
  });

  it("a ticket with no landed dev run is left out", () => {
    const c = buildSizeContext({ devRuns: [run("T-2", { outcome: "bounced", pr: null })], research: [], sidecar: {}, config, now });
    expect(c.tickets).toEqual([]);
  });

  it("keeps only the newest `window` tickets, newest first", () => {
    const c = buildSizeContext({
      devRuns: [
        run("T-1", { ended: "2026-11-01T10:20:00.000Z" }),
        run("T-3", { started: "2026-11-03T10:00:00.000Z", ended: "2026-11-03T10:20:00.000Z" }),
        run("T-2", { started: "2026-11-02T10:00:00.000Z", ended: "2026-11-02T10:20:00.000Z" }),
      ],
      research: [], sidecar: {}, config, now, window: 2,
    });
    expect(c.window).toBe(2);
    expect(c.tickets.map((t) => t.ticket)).toEqual(["T-3", "T-2"]);
  });

  it("diff stats come from the entry, else the sidecar by PR URL, else null", () => {
    const c = buildSizeContext({
      devRuns: [
        run("T-1", { diff_stats: { files: 1, additions: 2, deletions: 3 } }),
        run("T-2", { started: "2026-11-02T10:00:00.000Z", ended: "2026-11-02T10:20:00.000Z" }),
        run("T-3", { started: "2026-11-03T10:00:00.000Z", ended: "2026-11-03T10:20:00.000Z" }),
      ],
      research: [], sidecar: { "https://github.com/o/r/pull/T-2": { files: 29, additions: 2400, deletions: 100 } }, config, now,
    });
    const by = Object.fromEntries(c.tickets.map((t) => [t.ticket, [t.files, t.additions, t.deletions]]));
    expect(by).toEqual({ "T-1": [1, 2, 3], "T-2": [29, 2400, 100], "T-3": [null, null, null] });
  });

  it("research estimate and AC count are the latest research fact for that ticket", () => {
    const c = buildSizeContext({
      devRuns: [run("T-1")],
      research: [
        { ticket: "T-1", ended: "2026-10-30T00:00:00.000Z", size_estimate: "XL", ac_count: 14 },
        { ticket: "T-1", ended: "2026-10-31T00:00:00.000Z", size_estimate: "M", ac_count: 6 },
      ],
      sidecar: {}, config, now,
    });
    expect(c.tickets[0]).toMatchObject({ research_estimate: "M", ac_count: 6 });
  });

  it("median and p90 by nearest rank", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(nearestRank(xs, 0.5)).toBe(5);
    expect(nearestRank(xs, 0.9)).toBe(9);
    const devRuns = xs.map((c, i) => run(`T-${i + 1}`, { cost_usd: c, started: `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`, ended: `2026-11-${String(i + 1).padStart(2, "0")}T10:20:00.000Z` }));
    const s = buildSizeContext({ devRuns, research: [], sidecar: {}, config, now }).stats;
    expect(s.tickets).toBe(10);
    expect(s.cost_usd).toEqual({ median: 5, p90: 9 });
    expect(s.minutes).toEqual({ median: 20, p90: 20 });
  });

  it("minutes are rounded to one decimal", () => {
    const c = buildSizeContext({ devRuns: [run("T-1", { ended: "2026-11-01T10:08:30.000Z" })], research: [], sidecar: {}, config, now });
    expect(c.tickets[0].minutes).toBe(8.5);
  });
});

describe("loadSizeContext", () => {
  it("reads v2 phases, the v1 dev log and the sidecar under a root; bad lines skipped", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadSizeContext } = await import("../../src/core/size-context.ts");
    const root = await mkdtemp(join(tmpdir(), "sizectx-"));
    try {
      await mkdir(join(root, "runs/v2"), { recursive: true });
      await mkdir(join(root, "runs/v1/dev"), { recursive: true });
      const v2 = { ticket: "T-2", phases: [
        { role: "research", ended: "2026-11-02T09:00:00.000Z", size_estimate: "S", ac_count: 3 },
        { role: "dev", started: "2026-11-02T10:00:00.000Z", ended: "2026-11-02T10:10:00.000Z", outcome: "landed", cost_usd: 2, verify_loops: 1, pr: "https://x/pull/2", diff_stats: { files: 4, additions: 50, deletions: 5 } },
      ] };
      await writeFile(join(root, "runs/v2/proj.jsonl"), `${JSON.stringify(v2)}\nnot json\n`);
      const v1 = { ticket: "T-1", started: "2026-10-01T10:00:00.000Z", ended: "2026-10-01T10:30:00.000Z", outcome: "landed", cost_usd: 7, verify_loops: 3, pr: "https://x/pull/1" };
      await writeFile(join(root, "runs/v1/dev/proj.jsonl"), `${JSON.stringify(v1)}\n`);
      await writeFile(join(root, "runs/v1/dev/proj.diff-stats.json"), JSON.stringify({ "https://x/pull/1": { files: 29, additions: 2400, deletions: 10 } }));
      const c = await loadSizeContext("proj", config, now, root);
      expect(c.tickets.map((t) => [t.ticket, t.files, t.research_estimate])).toEqual([["T-2", 4, "S"], ["T-1", 29, null]]);
      expect(c.stats.tickets).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no logs at all: empty history, limits present", async () => {
    const { loadSizeContext } = await import("../../src/core/size-context.ts");
    const c = await loadSizeContext("proj", config, now, "/nonexistent-root-xyz");
    expect(c.tickets).toEqual([]);
    expect(c.limits.max_cost_per_ticket_usd).toBe(50);
  });
});
