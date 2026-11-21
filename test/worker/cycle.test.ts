import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordAdoptedFlights, runWorkerIteration } from "../../src/worker/cycle.ts";
import { ClaimMissingFieldsError } from "../../src/core/jira-client.ts";
import { findPendingHandoffs } from "../../src/worker/handoff.ts";
import { appendIteration, findLandedPrUrlAcross, readIterations } from "../../src/core/iteration-log.ts";
import type { IterationRecord, PhaseEntry } from "../../src/core/iteration-log.ts";
import { buildPollJql } from "../../src/core/jql.ts";
import { roleView } from "../../src/core/config.ts";
import { v2RunDir } from "../../src/core/paths.ts";
import { makeV2Config } from "../fixtures/config.ts";
import {
  DEV_LABEL,
  RESEARCH_LABEL,
  devBounce,
  devError,
  devTicket,
  harness,
  makeSession,
  researchBounce,
  researchVerdict,
  ticket,
  type Harness,
} from "./helpers.ts";

const MIN = 60_000;
let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const records = (x: Harness) => readIterations(x.logPath);
const runSkillCalls = (x: Harness) => x.events.filter((e) => e[0] === "runSkill");
const idx = (x: Harness, pred: (e: unknown[]) => boolean) => x.events.findIndex(pred);

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
    run_dir: ".pipeline/v2/repo/dev-1/TARS-90/research-20261111T010000Z",
    ...o,
  };
}

function rec(o: Partial<IterationRecord> = {}): IterationRecord {
  return {
    ticket: "TARS-90",
    session: "dev-1",
    loop_version: "2.0.0",
    started: "2026-11-11T01:00:00.000Z",
    ended: "2026-11-11T01:10:00.000Z",
    outcome: "landed",
    phases: [phase()],
    ...o,
  };
}

describe("runWorkerIteration — the cycle (§6.3)", () => {
  it("a claimed-and-bounced research run writes jira_status_changed: true", async () => {
    h = await harness({ script: { research: [{ verdictRaw: researchBounce() }] } });
    h.jira.research = [ticket("TARS-1")];
    await runWorkerIteration(h.deps);
    const recs = await records(h);
    expect(recs[0].outcome).toBe("bounced");
    expect(recs[0].jira_status_changed).toBe(true);
  });

  it("a resume-dropped record has no jira_status_changed", async () => {
    h = await harness({
      session: makeSession("dev-1", { ticket: "TARS-1", role: "research", runDir: v2RunDir("repo", "dev-1", "TARS-1", "research", "20261111T110000Z"), since: "2026-11-11T11:00:00.000Z" }),
    });
    h.jira.statuses["TARS-1"] = "Done";
    await runWorkerIteration(h.deps);
    const dropped = (await records(h)).filter((r) => r.outcome === "resume-dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].jira_status_changed).toBeUndefined();
  });

  it.each([
    [45_000, "45s"],
    [60_000, "1m"],
    [119_000, "1m"],
  ])("a held ticket logs its age (%i ms -> %s)", async (ms, text) => {
    h = await harness();
    await appendIteration(h.logPath, rec({ ticket: "TARS-1", ended: new Date(h.clock.t - ms).toISOString(), jira_status_changed: true }));
    await runWorkerIteration(h.deps);
    expect(h.logs).toContain(`[worker] TARS-1 skipped: a run on it ended ${text} ago`);
  });

  it("research green → handoff → dev landed", async () => {
    h = await harness();
    h.jira.research = [ticket("TARS-1")];

    const result = await runWorkerIteration(h.deps);

    const recs = await records(h);
    expect(recs).toHaveLength(1);
    expect(recs[0].ticket).toBe("TARS-1");
    expect(recs[0].outcome).toBe("landed");
    expect(recs[0].phases.map((p) => [p.role, p.outcome])).toEqual([
      ["research", "landed"],
      ["dev", "landed"],
    ]);
    expect(recs[0].phases[0].handoff).toBe("done");
    expect(recs[0].session).toBe("dev-1");
    expect(recs[0].loop_version).toBe("2.0.0");
    expect(h.jira.calls("claimTicket")).toEqual([["claimTicket", "TARS-1", "To Do", "In Progress"]]);

    const swap = idx(h, (e) => e[0] === "swapLabel");
    const devRun = idx(h, (e) => e[0] === "runSkill" && e[1] === "dev");
    expect(h.events[swap]).toEqual(["swapLabel", "TARS-1", "pipeline:v2", "pipeline:v2:dev"]);
    expect(swap).toBeGreaterThan(-1);
    expect(devRun).toBeGreaterThan(swap);
    expect(h.events[devRun][2]).toBe("TARS-1");
    expect(result).toEqual({ kind: "did", record: recs[0] });
    expect(h.session.current).toBeNull();
  });

  it("research bounce → Blocked, dev never runs", async () => {
    h = await harness({ script: { research: [{ verdictRaw: researchBounce() }] } });
    h.jira.research = [ticket("TARS-1")];

    const result = await runWorkerIteration(h.deps);

    expect(h.jira.calls("transitionStatus")).toEqual([["transitionStatus", "TARS-1", "Blocked", undefined]]);
    expect(runSkillCalls(h).map((e) => e[1])).toEqual(["research"]);
    expect(h.jira.calls("swapLabel")).toEqual([]);
    const [r] = await records(h);
    expect(r.outcome).toBe("bounced");
    expect(r.phases).toHaveLength(1);
    expect(result.kind).toBe("did");
  });

  it("research green, dev bounce → record outcome bounced, 2 phases", async () => {
    h = await harness({ script: { dev: [{ verdictRaw: devBounce() }] } });
    h.jira.research = [ticket("TARS-1")];

    await runWorkerIteration(h.deps);

    const [r] = await records(h);
    expect(r.outcome).toBe("bounced");
    expect(r.phases.map((p) => p.outcome)).toEqual(["landed", "bounced"]);
    expect(h.jira.calls("transitionStatus").at(-1)).toEqual(["transitionStatus", "TARS-1", "Blocked", undefined]);
  });

  it("resume-at-dev: the dev poll returns a ticket, no claim, the record has only a dev phase", async () => {
    h = await harness();
    h.jira.dev = [devTicket("TARS-3")];
    h.jira.research = [ticket("TARS-4")];

    const result = await runWorkerIteration(h.deps);

    expect(h.jira.calls("claimTicket")).toEqual([]);
    const recs = await records(h);
    expect(recs).toHaveLength(1);
    expect(recs[0].ticket).toBe("TARS-3");
    expect(recs[0].phases.map((p) => p.role)).toEqual(["dev"]);
    expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["dev", "TARS-3"]]);
    expect(result.kind).toBe("did");
  });

  it("blocked ticket skipped, next ticket in the same iteration runs", async () => {
    h = await harness();
    h.jira.research = [ticket("TARS-1"), ticket("TARS-3")];
    h.jira.blockers = { "TARS-1": ["TARS-2"] };

    await runWorkerIteration(h.deps);

    const recs = await records(h);
    expect(recs.map((r) => [r.ticket, r.outcome])).toEqual([
      ["TARS-1", "skipped-blocked"],
      ["TARS-3", "landed"],
    ]);
    expect(recs[0].blocked_by).toEqual(["TARS-2"]);
    expect(recs[0].phases).toEqual([]);
    const researchPolls = h.jira.polls.filter((q) => q.includes(`"${RESEARCH_LABEL}"`));
    expect(researchPolls[1]).toContain('key not in ("TARS-1")');
    expect(h.jira.calls("claimTicket").map((e) => e[1])).toEqual(["TARS-3"]);
  });

  it("claim throws → claim-error record, next ticket runs", async () => {
    h = await harness();
    h.jira.research = [ticket("TARS-1"), ticket("TARS-3")];
    h.jira.claimImpl = async (k) => {
      if (k === "TARS-1") throw new Error("Jira request failed: 400 required field");
      return true;
    };

    const result = await runWorkerIteration(h.deps);

    const recs = await records(h);
    expect(recs.map((r) => [r.ticket, r.outcome])).toEqual([
      ["TARS-1", "claim-error"],
      ["TARS-3", "landed"],
    ]);
    expect(recs[0].detail).toMatch(/400 required field/);
    expect(result.kind).toBe("did");
  });

  describe("claim blocked by required fields", () => {
    const missing = (fields: string[]) => async (k: string) => {
      if (k === "TARS-1") throw new ClaimMissingFieldsError(fields);
      return true;
    };
    const commentText = (c: { body: Record<string, unknown> }) => JSON.stringify(c.body);

    it("(a) records the field names, comments once on the ticket, next ticket runs", async () => {
      h = await harness();
      h.jira.research = [ticket("TARS-1"), ticket("TARS-3")];
      h.jira.claimImpl = missing(["Story Points"]);

      await runWorkerIteration(h.deps);

      const recs = await records(h);
      expect(recs.map((r) => [r.ticket, r.outcome])).toEqual([
        ["TARS-1", "claim-error"],
        ["TARS-3", "landed"],
      ]);
      expect(recs[0].detail).toBe("claim blocked: required field(s) missing: Story Points");
      const cs = h.jira.comments.filter((c) => c.key === "TARS-1");
      expect(cs).toHaveLength(1);
      expect(commentText(cs[0])).toContain("Story Points");
      expect(commentText(cs[0])).toContain("dev-loop could not start this ticket: ");
    });

    it("(b) the same missing field on a later iteration posts no second comment", async () => {
      h = await harness();
      h.jira.research = [ticket("TARS-1")];
      h.jira.claimImpl = missing(["Story Points"]);
      await runWorkerIteration(h.deps);
      h.clock.advance(11 * MIN);
      await runWorkerIteration(h.deps);

      expect((await records(h)).filter((r) => r.ticket === "TARS-1" && r.outcome === "claim-error")).toHaveLength(2);
      expect(h.jira.comments.filter((c) => c.key === "TARS-1")).toHaveLength(1);
    });

    it("(c) a changed field set posts a second comment", async () => {
      h = await harness();
      h.jira.research = [ticket("TARS-1")];
      h.jira.claimImpl = missing(["Story Points"]);
      await runWorkerIteration(h.deps);
      h.clock.advance(11 * MIN);
      h.jira.claimImpl = missing(["Story Points", "Sprint"]);
      await runWorkerIteration(h.deps);

      const cs = h.jira.comments.filter((c) => c.key === "TARS-1");
      expect(cs).toHaveLength(2);
      expect(commentText(cs[1])).toContain("Sprint");
    });

    it("(d) a failing addComment is swallowed: record appended, next ticket runs", async () => {
      h = await harness();
      h.jira.research = [ticket("TARS-1"), ticket("TARS-3")];
      h.jira.claimImpl = missing(["Story Points"]);
      let attempts = 0;
      h.jira.addComment = async () => {
        attempts++;
        throw new Error("comment API down");
      };

      await runWorkerIteration(h.deps);

      expect(attempts).toBe(1);
      const recs = await records(h);
      expect(recs.map((r) => [r.ticket, r.outcome])).toEqual([
        ["TARS-1", "claim-error"],
        ["TARS-3", "landed"],
      ]);
      expect(recs[0].jira_sync_error).toMatch(/comment API down/);
    });

    it("(d2) a failed comment is retried next iteration: 2 attempts, 1 posted", async () => {
      h = await harness();
      h.jira.research = [ticket("TARS-1")];
      h.jira.claimImpl = missing(["Story Points"]);
      const realAdd = h.jira.addComment.bind(h.jira);
      let attempts = 0;
      h.jira.addComment = async (k, b) => {
        attempts++;
        if (attempts === 1) throw new Error("comment API down");
        return realAdd(k, b);
      };

      await runWorkerIteration(h.deps);
      h.clock.advance(11 * MIN);
      await runWorkerIteration(h.deps);
      h.clock.advance(11 * MIN);
      await runWorkerIteration(h.deps);

      expect(attempts).toBe(2);
      expect(h.jira.comments.filter((c) => c.key === "TARS-1")).toHaveLength(1);
    });

    it("(e) a plain claim Error keeps the old detail and posts no comment", async () => {
      h = await harness();
      h.jira.research = [ticket("TARS-1"), ticket("TARS-3")];
      h.jira.claimImpl = async (k) => {
        if (k === "TARS-1") throw new Error("boom 500");
        return true;
      };

      await runWorkerIteration(h.deps);

      const recs = await records(h);
      expect(recs[0].detail).toMatch(/^claim failed: .*boom 500/);
      expect(h.jira.comments.filter((c) => c.key === "TARS-1")).toHaveLength(0);
    });
  });

  it("claim lost race (false) → re-polls excluding it, no record for it", async () => {
    h = await harness();
    h.jira.research = [ticket("TARS-1"), ticket("TARS-3")];
    h.jira.claimImpl = async (k) => k !== "TARS-1";

    await runWorkerIteration(h.deps);

    expect((await records(h)).map((r) => r.ticket)).toEqual(["TARS-3"]);
  });

  it("runSkill throws → error phase, no crash, ticket recorded", async () => {
    h = await harness({ script: { research: [new Error("spawn exploded")] } });
    h.jira.research = [ticket("TARS-1")];

    const result = await runWorkerIteration(h.deps);

    const [r] = await records(h);
    expect(r.ticket).toBe("TARS-1");
    expect(r.outcome).toBe("error");
    expect(r.phases[0].outcome).toBe("error");
    expect(r.phases[0].failure_category).toBe("agent_error");
    expect(r.phases[0].detail).toMatch(/spawn exploded/);
    expect(result.kind).toBe("did");
    expect(h.session.current).toBeNull();
  });

  it("queue: first bounces, second still lands (over two iterations)", async () => {
    h = await harness({ script: { research: [{ verdictRaw: researchBounce() }] } });
    h.jira.research = [ticket("TARS-1"), ticket("TARS-2")];

    await runWorkerIteration(h.deps);
    h.clock.advance(5_000);
    await runWorkerIteration(h.deps); // stub still returns TARS-1 first (index lag)

    const recs = await records(h);
    expect(recs.map((r) => [r.ticket, r.outcome])).toEqual([
      ["TARS-1", "bounced"],
      ["TARS-2", "landed"],
    ]);
  });

  it("blocked (bounced) ticket not re-picked: both poll JQLs exclude the bounced status", () => {
    const config = makeV2Config();
    const research = buildPollJql(roleView(config, "research"), { assigneeAccountId: "acc-1" });
    const dev = buildPollJql(roleView(config, "dev"), { assigneeAccountId: "acc-1" });
    expect(research).toContain('status = "To Do"');
    expect(dev).toContain('status != "Blocked"');
  });

  it("a just-bounced ticket is excluded even across a restart", async () => {
    h = await harness({ script: { research: [{ verdictRaw: researchBounce() }] } });
    h.jira.research = [ticket("TARS-1")];
    await runWorkerIteration(h.deps);
    const before = (await records(h)).length;

    h.clock.advance(30_000);
    const fresh = h.restart();
    const result = await runWorkerIteration(fresh);

    expect(result).toEqual({ kind: "idle" });
    expect((await records(h)).length).toBe(before);
    expect(runSkillCalls(h)).toHaveLength(1);
    expect(h.jira.polls.at(-1)).toContain('key not in ("TARS-1")');
  });

  it("crash mid-research → resumed without claim", async () => {
    const runDir = v2RunDir("repo", "dev-1", "TARS-1", "research", "20261111T110000Z");
    h = await harness({
      session: makeSession("dev-1", { ticket: "TARS-1", role: "research", runDir, since: "2026-11-11T11:00:00.000Z" }),
    });

    await runWorkerIteration(h.deps);

    expect(h.jira.calls("claimTicket")).toEqual([]);
    expect(runSkillCalls(h)[0].slice(1, 3)).toEqual(["research", "TARS-1"]);
    const recs = await records(h);
    // The lost run is recorded first (an error phase: a failed attempt, durable before the re-run
    // starts), then the resumed run's own record.
    expect(recs[0]).toMatchObject({ ticket: "TARS-1", outcome: "error" });
    expect(recs[0].phases).toHaveLength(1);
    expect(recs[0].phases[0]).toMatchObject({ role: "research", outcome: "error", failure_category: "agent_error", run_dir: runDir });
    expect(recs[0].phases[0].detail).toMatch(/in-flight/);
    expect(recs[1].ticket).toBe("TARS-1");
    expect(recs[1].phases[0]).toMatchObject({ role: "research", outcome: "landed" });

    // Recovery happens once: the next iteration does not resume again.
    h.clock.advance(20 * MIN);
    await runWorkerIteration(h.deps);
    expect(runSkillCalls(h).filter((e) => e[1] === "research")).toHaveLength(1);
  });

  it("crash mid-dev, PR exists → self-heal, no rebuild", async () => {
    const runDir = v2RunDir("repo", "dev-1", "TARS-2", "dev", "20261111T110000Z");
    h = await harness({
      session: makeSession("dev-1", { ticket: "TARS-2", role: "dev", runDir, since: "2026-11-11T11:00:00.000Z" }),
      deps: { findOpenPrUrl: async (k) => (k === "TARS-2" ? "https://github.com/org/repo/pull/77" : null) },
    });

    const result = await runWorkerIteration(h.deps);

    expect(runSkillCalls(h)).toEqual([]);
    const [t] = h.jira.calls("transitionStatus");
    expect(t.slice(1, 3)).toEqual(["TARS-2", "Code Review"]);
    const fields = t[3] as Record<string, unknown>;
    expect(fields.customfield_13504).toEqual([{ id: "14310" }]);
    expect(JSON.stringify(fields.customfield_14226)).toContain("https://github.com/org/repo/pull/77");
    const recs = await records(h);
    expect(recs).toHaveLength(1);
    expect(recs[0].outcome).toBe("skipped-pr-exists");
    expect(recs[0].ticket).toBe("TARS-2");
    // A resolved dev phase carrying the PR (resets failedAttempts, teaches findLandedPrUrlAcross); no crash error phase.
    expect(recs[0].phases.map((p) => [p.role, p.outcome, p.pr])).toEqual([["dev", "landed", "https://github.com/org/repo/pull/77"]]);
    expect(recs[0].phases[0].detail).toMatch(/self-heal: existing PR/);
    expect(recs[0].phases[0].run_dir).toBe(runDir);
    expect(recs[0].detail).toContain("https://github.com/org/repo/pull/77");
    expect(result.kind).toBe("did");
  });

  it("crash mid-dev, no PR → re-runs the dev phase (no claim)", async () => {
    const runDir = v2RunDir("repo", "dev-1", "TARS-2", "dev", "20261111T110000Z");
    h = await harness({
      session: makeSession("dev-1", { ticket: "TARS-2", role: "dev", runDir, since: "2026-11-11T11:00:00.000Z" }),
    });

    await runWorkerIteration(h.deps);

    expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["dev", "TARS-2"]]);
    expect(h.jira.calls("claimTicket")).toEqual([]);
  });

  describe("resume re-reads the Jira status first (M5)", () => {
    const researchFlight = () =>
      makeSession("dev-1", { ticket: "TARS-1", role: "research", runDir: v2RunDir("repo", "dev-1", "TARS-1", "research", "20261111T110000Z"), since: "2026-11-11T11:00:00.000Z" });
    const devFlight = (interrupted = false) =>
      makeSession("dev-1", { ticket: "TARS-2", role: "dev", runDir: v2RunDir("repo", "dev-1", "TARS-2", "dev", "20261111T110000Z"), since: "2026-11-11T11:00:00.000Z", ...(interrupted ? { interrupted } : {}) });

    it("(a) research flight, status now Done -> resume-dropped, no run, no claim, not resumed again", async () => {
      h = await harness({ session: researchFlight() });
      h.jira.statuses["TARS-1"] = "Done";

      const result = await runWorkerIteration(h.deps);

      // Dropping is bookkeeping: with nothing else to do the iteration is idle.
      expect(result.kind).toBe("idle");
      expect(runSkillCalls(h)).toEqual([]);
      expect(h.jira.calls("claimTicket")).toEqual([]);
      const recs = await records(h);
      expect(recs).toHaveLength(2);
      expect(recs[1]).toMatchObject({
        ticket: "TARS-1",
        outcome: "resume-dropped",
        phases: [],
        detail: 'resume of the research phase dropped: status is now "Done", not "In Progress"',
      });
      expect(recs[1].resume).toBeUndefined();

      h.clock.advance(20 * MIN);
      await runWorkerIteration(h.deps);
      expect(runSkillCalls(h)).toEqual([]);
      expect((await records(h)).filter((r) => r.outcome === "resume-dropped")).toHaveLength(1);
    });

    it("(b) interrupted dev flight, status Blocked -> dropped, no open-PR lookup, no run", async () => {
      const findOpenPrUrl = vi.fn(async () => "https://github.com/org/repo/pull/9");
      h = await harness({ session: devFlight(true), deps: { findOpenPrUrl } });
      h.jira.statuses["TARS-2"] = "Blocked";

      await runWorkerIteration(h.deps);

      expect(runSkillCalls(h)).toEqual([]);
      expect(h.jira.calls("transitionStatus")).toEqual([]);
      const recs = await records(h);
      expect(recs.at(-1)).toMatchObject({
        ticket: "TARS-2",
        outcome: "resume-dropped",
        phases: [],
        detail: 'resume of the dev phase dropped: status is now "Blocked", not "In Progress"',
      });
      expect(findOpenPrUrl).not.toHaveBeenCalled();
    });

    it("(e) crashed dev flight with an open PR, status Blocked -> no self-heal transition, resume-dropped record", async () => {
      h = await harness({
        session: devFlight(),
        deps: { findOpenPrUrl: async () => "https://github.com/org/repo/pull/9" },
      });
      h.jira.statuses["TARS-2"] = "Blocked";

      await runWorkerIteration(h.deps);

      expect(h.jira.calls("transitionStatus")).toEqual([]);
      expect(runSkillCalls(h)).toEqual([]);
      const recs = await records(h);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ ticket: "TARS-2", outcome: "resume-dropped", phases: [] });
      expect(recs[0].resume).toBeUndefined();
      expect(recs[0].detail).toContain('status is now "Blocked", not "In Progress"');
    });

    it("(f) crashed dev flight with an open PR, status lookup fails -> recorded as crashed with resume (no self-heal)", async () => {
      h = await harness({
        session: devFlight(),
        deps: { findOpenPrUrl: async () => "https://github.com/org/repo/pull/9" },
      });
      h.jira.statusImpl = async () => {
        throw new Error("jira 503");
      };

      await runWorkerIteration(h.deps);

      expect(h.jira.calls("transitionStatus")).toEqual([]);
      const recs = await records(h);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ ticket: "TARS-2", outcome: "error", resume: "dev" });
    });

    describe("dev resume at Code Review (Ruling 51)", () => {
      const PR = "https://github.com/org/repo/pull/9";

      it("(g) crashed dev flight, status Code Review, open PR -> one skipped-pr-exists record with the PR, no transition, no run", async () => {
        h = await harness({ session: devFlight(), deps: { findOpenPrUrl: async (k) => (k === "TARS-2" ? PR : null) } });
        h.jira.statuses["TARS-2"] = "Code Review";

        const result = await runWorkerIteration(h.deps);

        expect(result.kind).toBe("did");
        expect(h.jira.calls("transitionStatus")).toEqual([]);
        expect(runSkillCalls(h)).toEqual([]);
        const recs = await records(h);
        expect(recs).toHaveLength(1);
        expect(recs[0]).toMatchObject({ ticket: "TARS-2", outcome: "skipped-pr-exists" });
        expect(recs[0].resume).toBeUndefined();
        expect(recs[0].jira_sync_error).toBeUndefined();
        expect(recs[0].phases.map((p) => [p.role, p.outcome, p.pr])).toEqual([["dev", "landed", PR]]);
        expect(recs[0].detail).toContain(PR);

        h.clock.advance(20 * MIN);
        await runWorkerIteration(h.deps);
        expect(runSkillCalls(h)).toEqual([]);
        expect((await records(h)).filter((r) => r.outcome === "skipped-pr-exists")).toHaveLength(1);
      });

      it("(h) interrupted dev flight resumed through resumeNext, status Code Review, open PR -> skipped-pr-exists, no transition, no run", async () => {
        h = await harness({ session: devFlight(true), deps: { findOpenPrUrl: async (k) => (k === "TARS-2" ? PR : null) } });
        h.jira.statuses["TARS-2"] = "Code Review";

        await runWorkerIteration(h.deps);

        expect(h.jira.calls("transitionStatus")).toEqual([]);
        expect(runSkillCalls(h)).toEqual([]);
        const recs = await records(h);
        expect(recs.map((r) => r.outcome)).toEqual(["interrupted", "skipped-pr-exists"]);
        expect(recs[1].ticket).toBe("TARS-2");
        expect(recs[1].resume).toBeUndefined();
        expect(recs[1].phases.map((p) => [p.role, p.outcome, p.pr])).toEqual([["dev", "landed", PR]]);
      });

      it("(i) crashed dev flight, status Code Review, no open PR -> resume-dropped naming it, no run", async () => {
        h = await harness({ session: devFlight() });
        h.jira.statuses["TARS-2"] = "Code Review";

        await runWorkerIteration(h.deps);

        expect(runSkillCalls(h)).toEqual([]);
        expect(h.jira.calls("transitionStatus")).toEqual([]);
        const recs = await records(h);
        expect(recs).toHaveLength(1);
        expect(recs[0]).toMatchObject({ ticket: "TARS-2", outcome: "resume-dropped", phases: [] });
        expect(recs[0].resume).toBeUndefined();
        expect(recs[0].detail).toContain("Code Review with no open PR");
      });

      it("(j) interrupted dev flight, status Code Review, open-PR lookup fails -> resume-dropped, no run", async () => {
        h = await harness({
          session: devFlight(true),
          deps: {
            findOpenPrUrl: async () => {
              throw new Error("gh 502");
            },
          },
        });
        h.jira.statuses["TARS-2"] = "Code Review";

        await runWorkerIteration(h.deps);

        expect(runSkillCalls(h)).toEqual([]);
        expect(h.jira.calls("transitionStatus")).toEqual([]);
        const recs = await records(h);
        expect(recs.map((r) => r.outcome)).toEqual(["interrupted", "resume-dropped"]);
        expect(recs[1].detail).toContain("Code Review with no open PR");

        h.clock.advance(20 * MIN);
        await runWorkerIteration(h.deps);
        expect(runSkillCalls(h)).toEqual([]);
      });

      it("(k) research flight, status Code Review -> resume-dropped as before (research is unchanged)", async () => {
        h = await harness({ session: researchFlight() });
        h.jira.statuses["TARS-1"] = "Code Review";

        await runWorkerIteration(h.deps);

        expect(runSkillCalls(h)).toEqual([]);
        const recs = await records(h);
        expect(recs.at(-1)).toMatchObject({
          ticket: "TARS-1",
          outcome: "resume-dropped",
          detail: 'resume of the research phase dropped: status is now "Code Review", not "In Progress"',
        });
      });
    });

    it("(l) a dropped resume is bookkeeping: the same iteration goes on to poll and runs the ticket", async () => {
      // Reset put the ticket back to To Do while the dead lock still named its old dev run (TARS-1634, 2026-11-16).
      h = await harness({ session: devFlight() });
      h.jira.statuses["TARS-2"] = "To Do";
      h.jira.dev = [devTicket("TARS-2")];

      const result = await runWorkerIteration(h.deps);

      expect(result.kind).toBe("did");
      expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["dev", "TARS-2"]]);
      const recs = await records(h);
      expect(recs[0]).toMatchObject({ ticket: "TARS-2", outcome: "resume-dropped" });
      expect(recs.at(-1)!.phases.map((p) => p.role)).toEqual(["dev"]);
    });

    it("(m) several dropped resumes are all resolved in one iteration, then nothing to do is idle", async () => {
      h = await harness({ session: researchFlight() });
      h.jira.statuses["TARS-1"] = "Done";
      await appendIteration(h.logPath, rec({ ticket: "TARS-9", outcome: "interrupted", phases: [], resume: "dev", detail: "x" }));
      h.jira.statuses["TARS-9"] = "Blocked";

      const result = await runWorkerIteration(h.deps);

      expect(result.kind).toBe("idle");
      expect(runSkillCalls(h)).toEqual([]);
      expect((await records(h)).filter((r) => r.outcome === "resume-dropped").map((r) => r.ticket).sort()).toEqual(["TARS-1", "TARS-9"]);
    });

    it("(c) status In Progress -> resumes as before", async () => {
      h = await harness({ session: researchFlight() });
      h.jira.statuses["TARS-1"] = "In Progress";
      await runWorkerIteration(h.deps);
      expect(runSkillCalls(h)[0].slice(1, 3)).toEqual(["research", "TARS-1"]);
      expect((await records(h)).some((r) => r.outcome === "resume-dropped")).toBe(false);
    });

    it("(d) getStatus throws -> no record, nothing resumed, ticket not claimed/run; next iteration resumes", async () => {
      h = await harness({ session: researchFlight() });
      h.jira.research = [ticket("TARS-1")];
      h.jira.statusImpl = async () => {
        throw new Error("jira 503");
      };

      await runWorkerIteration(h.deps);

      const recs = await records(h);
      expect(recs).toHaveLength(1); // only the recorded crash flight
      expect(recs[0]).toMatchObject({ ticket: "TARS-1", resume: "research" });
      expect(runSkillCalls(h)).toEqual([]);
      expect(h.jira.calls("claimTicket")).toEqual([]);

      // Past the recent window with the lookup still failing: ctx.exclude (not `recent`) keeps the
      // pending ticket from being polled, claimed and run as a fresh ticket.
      h.clock.advance(20 * MIN);
      await runWorkerIteration(h.deps);
      expect(runSkillCalls(h)).toEqual([]);
      expect(h.jira.calls("claimTicket")).toEqual([]);
      expect(h.jira.polls.every((q) => q.includes('"TARS-1"'))).toBe(true);
      expect(await records(h)).toHaveLength(1);

      h.jira.statusImpl = async () => {};
      h.clock.advance(20 * MIN);
      await runWorkerIteration(h.deps);
      expect(runSkillCalls(h)[0].slice(1, 3)).toEqual(["research", "TARS-1"]);
      expect(h.jira.calls("claimTicket")).toEqual([]);
    });
  });

  it("orphanedInFlight records are resumed after the primary one, one per iteration, never dropped", async () => {
    const rd = (k: string, r: "research" | "dev") => v2RunDir("repo", "dev-1", k, r, "20261111T110000Z");
    h = await harness({
      session: makeSession(
        "dev-1",
        { ticket: "TARS-1", role: "research", runDir: rd("TARS-1", "research"), since: "2026-11-11T11:00:00.000Z" },
        [{ ticket: "TARS-5", role: "dev", runDir: rd("TARS-5", "dev"), since: "2026-11-11T11:00:00.000Z" }],
      ),
    });

    await runWorkerIteration(h.deps);
    expect(runSkillCalls(h)[0].slice(1, 3)).toEqual(["research", "TARS-1"]);
    // Both crash records are durable after the first iteration, before the orphan is resumed.
    const afterFirst = await records(h);
    expect(afterFirst.slice(0, 2).map((r) => [r.ticket, r.outcome, r.resume])).toEqual([
      ["TARS-1", "error", "research"],
      ["TARS-5", "error", "dev"],
    ]);
    expect(runSkillCalls(h).some((e) => e[2] === "TARS-5")).toBe(false);
    h.clock.advance(5_000);
    await runWorkerIteration(h.deps);

    expect(runSkillCalls(h).some((e) => e[1] === "dev" && e[2] === "TARS-5")).toBe(true);
    const crash = (await records(h)).filter((r) => r.phases.some((p) => p.outcome === "error" && /in-flight/.test(p.detail)));
    expect(crash.map((r) => r.ticket).sort()).toEqual(["TARS-1", "TARS-5"]);
    expect(h.logs.some((m) => /orphan/i.test(m) && m.includes("TARS-5"))).toBe(true);
  });

  it("two failed dev attempts → Blocked with comment, never polled again", async () => {
    h = await harness({ script: { dev: [{ verdictRaw: devError() }, { verdictRaw: devError() }] } });
    h.jira.dev = [devTicket("TARS-7")];

    await runWorkerIteration(h.deps);
    h.clock.advance(11 * MIN);
    await runWorkerIteration(h.deps);
    h.clock.advance(11 * MIN);
    await runWorkerIteration(h.deps);
    h.clock.advance(11 * MIN);
    await runWorkerIteration(h.deps);

    expect(runSkillCalls(h)).toHaveLength(2);
    expect(h.jira.comments).toHaveLength(1);
    const text = JSON.stringify(h.jira.comments[0].body);
    expect(text).toMatch(/2 failed dev attempts/);
    expect(h.jira.calls("transitionStatus").filter((e) => e[2] === "Blocked")).toEqual([
      ["transitionStatus", "TARS-7", "Blocked", undefined],
    ]);
    const recs = await records(h);
    expect(recs.filter((r) => r.outcome === "blocked-attempts").map((r) => r.ticket)).toEqual(["TARS-7"]);
    const devPolls = h.jira.polls.filter((q) => q.includes(`"${DEV_LABEL}"`));
    expect(devPolls.at(-1)).toContain('"TARS-7"');
    expect(devPolls.at(-2)).toContain('"TARS-7"');
  });

  it("assign throws after green research → still handed off and dev runs", async () => {
    h = await harness();
    h.jira.research = [ticket("TARS-1", { assignee: null })];
    h.jira.assignImpl = async () => {
      throw new Error("assign 403");
    };

    await runWorkerIteration(h.deps);

    expect(h.jira.calls("assignTicket")).toEqual([["assignTicket", "TARS-1", "acc-1"]]);
    expect(h.jira.calls("swapLabel")).toHaveLength(1);
    expect(runSkillCalls(h).map((e) => e[1])).toEqual(["research", "dev"]);
    const [r] = await records(h);
    expect(r.outcome).toBe("landed");
    expect(r.jira_sync_error).toMatch(/assign 403/);
    expect(buildPollJql(roleView(makeV2Config(), "dev"), { assigneeAccountId: "acc-1" })).not.toMatch(/assignee/i);
  });

  it("blocked ticket logged once while blockers are unchanged, once more when the set changes", async () => {
    h = await harness();
    h.jira.research = [ticket("TARS-1")];
    h.jira.blockers = { "TARS-1": ["TARS-2"] };

    for (let i = 0; i < 3; i++) {
      await runWorkerIteration(h.deps);
      h.clock.advance(11 * MIN);
    }
    expect((await records(h)).filter((r) => r.outcome === "skipped-blocked")).toHaveLength(1);
    expect(h.jira.calls("getBlockedBy").length).toBeGreaterThanOrEqual(2);

    h.jira.blockers = { "TARS-1": ["TARS-2", "TARS-8"] };
    await runWorkerIteration(h.deps);

    const skips = (await records(h)).filter((r) => r.outcome === "skipped-blocked");
    expect(skips.map((r) => r.blocked_by)).toEqual([["TARS-2"], ["TARS-2", "TARS-8"]]);
    expect(runSkillCalls(h)).toEqual([]);
  });

  it("a cross-project blocker in a jira.blockerClearedStatuses status lets the ticket run", async () => {
    h = await harness({ config: (c) => { c.jira.blockerClearedStatuses = ["Deployed to INT"]; } });
    h.jira.research = [ticket("TARS-1")];
    h.jira.blockers = { "TARS-1": ["MC-9"] };
    h.jira.statusDetails = { "MC-9": { name: "Deployed to INT", done: false } };

    await runWorkerIteration(h.deps);

    expect((await records(h)).filter((r) => r.outcome === "skipped-blocked")).toEqual([]);
    expect(h.jira.calls("claimTicket").map((e) => e[1])).toEqual(["TARS-1"]);
  });

  it("without jira.blockerClearedStatuses the same blocker still skips the ticket", async () => {
    h = await harness();
    h.jira.research = [ticket("TARS-1")];
    h.jira.blockers = { "TARS-1": ["MC-9"] };
    h.jira.statusDetails = { "MC-9": { name: "Deployed to INT", done: false } };

    await runWorkerIteration(h.deps);

    expect((await records(h)).map((r) => r.outcome)).toEqual(["skipped-blocked"]);
    expect(h.jira.calls("getStatusDetail")).toEqual([]);
  });

  it("handoff swap fails three iterations running → one handoff-pending record", async () => {
    h = await harness();
    h.jira.research = [ticket("TARS-1")];
    h.jira.swapImpl = async () => {
      throw new Error("Jira down");
    };

    for (let i = 0; i < 3; i++) {
      const result = await runWorkerIteration(h.deps);
      expect(result.kind).not.toBe("paused");
      h.clock.advance(11 * MIN);
    }

    expect(h.jira.calls("swapLabel").length).toBe(3);
    const recs = await records(h);
    expect(recs.filter((r) => r.outcome === "handoff-pending")).toHaveLength(1);
    expect(recs).toHaveLength(1);
    expect(runSkillCalls(h).map((e) => e[1])).toEqual(["research"]);
  });

  it("21 blocked candidates → 20 skipped, iteration returns idle", async () => {
    h = await harness();
    h.jira.research = Array.from({ length: 21 }, (_, i) => ticket(`TARS-${100 + i}`));
    h.jira.blockers = Object.fromEntries(h.jira.research.map((t) => [t.key, ["TARS-999"]]));

    const result = await runWorkerIteration(h.deps);

    expect(result).toEqual({ kind: "idle" });
    expect(h.jira.calls("getBlockedBy")).toHaveLength(20);
    expect((await records(h)).filter((r) => r.outcome === "skipped-blocked")).toHaveLength(20);
    expect(h.jira.calls("claimTicket")).toEqual([]);
  });

  it("research cost breach → no handoff, record handoff-pending, paused", async () => {
    h = await harness({ script: { research: [{ costUsd: 60 }] } });
    h.jira.research = [ticket("TARS-1")];

    const result = await runWorkerIteration(h.deps);

    expect(h.jira.calls("swapLabel")).toEqual([]);
    expect(runSkillCalls(h).map((e) => e[1])).toEqual(["research"]);
    const [r] = await records(h);
    expect(r.outcome).toBe("handoff-pending");
    expect(r.phases[0].handoff).toBe("skipped-ceiling");
    expect(result.kind).toBe("paused");
    if (result.kind === "paused") {
      expect(result.reason).toMatch(/maxCostPerRunUsd/);
      expect(result.record).toEqual(r);
    }
  });

  it("handoff swap throws → handoff failed, dev not run, worker not paused", async () => {
    h = await harness();
    h.jira.research = [ticket("TARS-1")];
    h.jira.swapImpl = async () => {
      throw new Error("swap 500");
    };

    const result = await runWorkerIteration(h.deps);

    expect(result.kind).toBe("did");
    const [r] = await records(h);
    expect(r.outcome).toBe("handoff-pending");
    expect(r.phases[0].handoff).toBe("failed");
    expect(r.phases[0].jira_sync_error ?? r.jira_sync_error).toMatch(/swap 500/);
    expect(runSkillCalls(h).map((e) => e[1])).toEqual(["research"]);
  });

  it("pending handoff completed at next iteration start", async () => {
    h = await harness();
    await appendIteration(
      h.logPath,
      rec({ ticket: "TARS-9", outcome: "handoff-pending", phases: [phase({ handoff: "skipped-ceiling" })] }),
    );

    await runWorkerIteration(h.deps);

    expect(h.jira.calls("swapLabel")[0]).toEqual(["swapLabel", "TARS-9", RESEARCH_LABEL, DEV_LABEL]);
    // Step 1 runs first; the handed-off ticket is step 3's candidate ahead of the dev poll.
    expect(idx(h, (e) => e[0] === "swapLabel")).toBeLessThan(idx(h, (e) => e[0] === "runSkill"));
    expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["dev", "TARS-9"]]);
    expect(findPendingHandoffs(await records(h))).toEqual([]);
  });

  it("a pending handoff on a ticket closed in Jira is dropped: no swap, no dev run, one handoff-dropped record", async () => {
    h = await harness();
    await appendIteration(h.logPath, rec({ ticket: "TARS-9", phases: [phase()] })); // research-only landed, no handoff
    h.jira.statusDetails["TARS-9"] = { name: "Closed", done: true };

    await runWorkerIteration(h.deps);

    expect(h.jira.calls("swapLabel")).toEqual([]);
    expect(runSkillCalls(h).filter((e) => e[2] === "TARS-9")).toEqual([]);
    const recs = (await records(h)).filter((r) => r.ticket === "TARS-9");
    expect(recs.map((r) => r.outcome)).toEqual(["landed", "handoff-dropped"]);
    expect(recs[1]).toMatchObject({ phases: [] });
    expect(recs[1].detail).toContain("Closed");
    expect(findPendingHandoffs(await records(h))).toEqual([]);

    // Resolved: a later iteration does not look again.
    await runWorkerIteration(h.deps);
    expect((await records(h)).filter((r) => r.outcome === "handoff-dropped")).toHaveLength(1);
  });

  it("a pending handoff whose status cannot be read is left pending: no swap, no record", async () => {
    h = await harness();
    await appendIteration(h.logPath, rec({ ticket: "TARS-9", phases: [phase()] }));
    h.jira.getStatusDetail = async () => {
      throw new Error("Jira 503");
    };

    await runWorkerIteration(h.deps);

    expect(h.jira.calls("swapLabel")).toEqual([]);
    expect(findPendingHandoffs(await records(h))).toEqual(["TARS-9"]);
    expect((await records(h)).filter((r) => r.ticket === "TARS-9").map((r) => r.outcome)).toEqual(["landed"]);
  });

  it("per-role runs/day: research at 100 and dev at 3 → a dev candidate runs; only research candidates → paused", async () => {
    const seed = async (x: Harness) => {
      for (let i = 0; i < 100; i++) {
        await appendIteration(x.logPath, rec({ ticket: `TARS-${500 + i}`, outcome: "bounced", phases: [phase({ outcome: "bounced" })] }));
      }
      for (let i = 0; i < 3; i++) {
        await appendIteration(
          x.logPath,
          rec({ ticket: `TARS-${700 + i}`, phases: [phase({ role: "dev", skill: "ticket-to-pr", pr: `https://github.com/org/repo/pull/${i}` })] }),
        );
      }
    };

    h = await harness();
    await seed(h);
    h.jira.dev = [devTicket("TARS-3")];
    h.jira.research = [ticket("TARS-4")];
    const ran = await runWorkerIteration(h.deps);
    expect(ran.kind).toBe("did");
    expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["dev", "TARS-3"]]);
    await h.cleanup();

    h = await harness();
    await seed(h);
    h.jira.research = [ticket("TARS-4")];
    const paused = await runWorkerIteration(h.deps);
    expect(paused.kind).toBe("paused");
    if (paused.kind === "paused") expect(paused.reason).toMatch(/research.*maxRunsPerDay|maxRunsPerDay.*research/);
    expect(h.jira.calls("claimTicket")).toEqual([]);
    expect(runSkillCalls(h)).toEqual([]);
  });

  it("session suffix: the bounce comment ADF's last paragraph is '— dev-1' (and the GitHub detail comment ends with it)", async () => {
    h = await harness({ script: { dev: [{ verdictRaw: devBounce("needs a human call") }] } });
    h.jira.dev = [devTicket("TARS-3")];

    await runWorkerIteration(h.deps);

    const body = h.jira.comments[0].body as { content: Array<{ type: string; content: Array<{ text: string }> }> };
    const last = body.content.at(-1)!;
    expect(last.type).toBe("paragraph");
    expect(last.content.map((n) => n.text).join("")).toBe("— dev-1");
    expect(JSON.stringify(body)).toContain("needs a human call");
    expect(h.github.comments.at(-1)!.body.endsWith("— dev-1")).toBe(true);
  });

  describe("budget (Ruling 16)", () => {
    it("research gets min(research cap, ticket cap); research cost $45 → dev budget $5", async () => {
      h = await harness({ script: { research: [{ costUsd: 45 }] } });
      h.jira.research = [ticket("TARS-1")];

      await runWorkerIteration(h.deps);

      const calls = runSkillCalls(h);
      expect(calls.map((e) => [e[1], e[3]])).toEqual([
        ["research", 50],
        ["dev", 5],
      ]);
    });

    it("research cost $49.50 → dev deferred: record [research] landed, handoff done", async () => {
      h = await harness({ script: { research: [{ costUsd: 49.5 }] } });
      h.jira.research = [ticket("TARS-1")];

      const result = await runWorkerIteration(h.deps);

      expect(runSkillCalls(h).map((e) => e[1])).toEqual(["research"]);
      expect(h.jira.calls("swapLabel")).toHaveLength(1);
      const [r] = await records(h);
      expect(r.outcome).toBe("landed");
      expect(r.phases).toHaveLength(1);
      expect(r.phases[0].handoff).toBe("done");
      expect(result.kind).toBe("did");
      expect(findPendingHandoffs(await records(h))).toEqual([]);
    });

    it("dev-only iterations get min(dev cap, ticket cap)", async () => {
      h = await harness();
      h.jira.dev = [devTicket("TARS-3")];
      await runWorkerIteration(h.deps);
      expect(runSkillCalls(h)[0][3]).toBe(20);
    });
  });

  it("the run dir passed to runSkill and recorded is v2RunDir(slug, session, ticket, phase, runId)", async () => {
    h = await harness();
    h.jira.dev = [devTicket("TARS-3")];

    await runWorkerIteration(h.deps);

    const expected = v2RunDir("repo", "dev-1", "TARS-3", "dev", "20261111T120000Z");
    expect(runSkillCalls(h)[0][4]).toBe(expected);
    expect((await records(h))[0].phases[0].run_dir).toBe(expected);
    expect(h.session.setInFlight).toHaveBeenNthCalledWith(1, {
      ticket: "TARS-3",
      role: "dev",
      runDir: expected,
      since: "2026-11-11T12:00:00.000Z",
    });
    expect(h.session.setInFlight).toHaveBeenLastCalledWith(null);
  });

  it("landed guard: a dev candidate whose recorded PR is still open is skipped, the next one runs", async () => {
    h = await harness({
      deps: {
        gate: {
          findLandedPrUrl: async (k) => (k === "TARS-3" ? "https://github.com/org/repo/pull/3" : null),
          execGhPrView: async () => JSON.stringify({ state: "OPEN", mergedAt: null, baseRefName: "main" }),
          execGhFindMergedPr: async () => null,
          mergedCache: new Map(),
        },
      },
    });
    h.jira.dev = [devTicket("TARS-3"), devTicket("TARS-4")];

    await runWorkerIteration(h.deps);

    expect(runSkillCalls(h).map((e) => e[2])).toEqual(["TARS-4"]);
    expect(h.logs.some((m) => m.includes("TARS-3") && /PR still open/.test(m))).toBe(true);
  });

  it("landed guard over findLandedPrUrlAcross: a v1-only landed ticket (pre-cutover runs/<slug>.jsonl) and a v2-only one are both skipped", async () => {
    h = await harness();
    const root = h.dir;
    await mkdir(join(root, "runs/v2"), { recursive: true });
    await writeFile(
      join(root, "runs/repo.jsonl"),
      JSON.stringify({ ticket: "TARS-3", outcome: "landed", pr: "https://github.com/org/repo/pull/3", ended: "2026-11-01T00:00:00Z" }) + "\n",
    );
    await appendIteration(join(root, "runs/v2/repo.jsonl"), {
      ticket: "TARS-4", session: "dev-1", loop_version: "2.0.0", started: "2026-11-02T00:00:00.000Z", ended: "2026-11-02T00:00:00.000Z",
      outcome: "landed", phases: [phase({ role: "dev", skill: "ticket-to-pr", outcome: "landed", phase_reached: "pr", pr: "https://github.com/org/repo/pull/4" })],
    });
    h.deps.gate.findLandedPrUrl = (k) => findLandedPrUrlAcross("repo", k, root);
    h.deps.gate.execGhPrView = async () => JSON.stringify({ state: "OPEN", mergedAt: null, baseRefName: "main" });
    h.jira.dev = [devTicket("TARS-3"), devTicket("TARS-4"), devTicket("TARS-5")];

    await runWorkerIteration(h.deps);

    expect(runSkillCalls(h).map((e) => e[2])).toEqual(["TARS-5"]);
    expect(h.logs.some((m) => m.includes("TARS-3") && m.includes("pull/3"))).toBe(true);
    expect(h.logs.some((m) => m.includes("TARS-4") && m.includes("pull/4"))).toBe(true);
  });

  it("an invalid key in a poll result is skipped and logged, never interpolated or recorded", async () => {
    h = await harness();
    h.jira.research = [ticket('TARS-1" OR key != "x')];

    const result = await runWorkerIteration(h.deps);

    expect(result).toEqual({ kind: "idle" });
    expect(h.jira.calls("claimTicket")).toEqual([]);
    expect(await records(h)).toEqual([]);
    expect(h.logs.some((m) => /invalid ticket key/i.test(m))).toBe(true);
  });

  it("auth failure on the poll → paused with the reason (worker-wide), not a throw", async () => {
    h = await harness();
    h.jira.pollError = new Error("Jira request failed: POST /rest/api/3/search/jql -> 401 Unauthorized.");

    const result = await runWorkerIteration(h.deps);

    expect(result.kind).toBe("paused");
    if (result.kind === "paused") expect(result.reason).toMatch(/401/);
    expect(await records(h)).toEqual([]);
  });

  it("an idle iteration writes no record", async () => {
    h = await harness();
    expect(await runWorkerIteration(h.deps)).toEqual({ kind: "idle" });
    expect(await records(h)).toEqual([]);
  });

  describe("restricted to one role (--phase)", () => {
    it("research-only: green research is not handed off and dev never runs; the handoff stays pending", async () => {
      h = await harness({ deps: { roles: ["research"] } });
      h.jira.research = [ticket("TARS-1")];
      h.jira.dev = [devTicket("TARS-3")];

      await runWorkerIteration(h.deps);

      expect(h.jira.calls("swapLabel")).toEqual([]);
      expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["research", "TARS-1"]]);
      expect(h.jira.polls.some((q) => q.includes(`"${DEV_LABEL}"`))).toBe(false);
      const [r] = await records(h);
      expect(r.outcome).toBe("landed");
      expect(findPendingHandoffs(await records(h))).toEqual(["TARS-1"]);
    });

    it("dev-only: never polls or claims research, completes pending handoffs", async () => {
      h = await harness({ deps: { roles: ["dev"] } });
      h.jira.research = [ticket("TARS-1")];
      await appendIteration(h.logPath, rec({ ticket: "TARS-9", phases: [phase()] })); // research-only landed, no handoff

      const result = await runWorkerIteration(h.deps);

      expect(h.jira.calls("swapLabel")).toEqual([["swapLabel", "TARS-9", RESEARCH_LABEL, DEV_LABEL]]);
      expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["dev", "TARS-9"]]);
      expect(result.kind).toBe("did");
      expect(h.jira.polls.some((q) => q.includes(`"${RESEARCH_LABEL}"`) && !q.includes(`"${DEV_LABEL}"`))).toBe(false);
      expect(h.jira.calls("claimTicket")).toEqual([]);
    });
  });
  describe("fix round 1", () => {
    const rd = (k: string, r: "research" | "dev") => v2RunDir("repo", "dev-1", k, r, "20261111T110000Z");
    const flight = (k: string, r: "research" | "dev", o: Record<string, unknown> = {}) => ({
      ticket: k,
      role: r,
      runDir: rd(k, r),
      since: "2026-11-11T11:00:00.000Z",
      ...o,
    });

    it("a --phase dev process adopting a crashed research flight records it but never runs research; a research process resumes it", async () => {
      h = await harness({ deps: { roles: ["dev"] }, session: makeSession("dev-1", flight("TARS-1", "research")) });

      await runWorkerIteration(h.deps);

      expect(runSkillCalls(h)).toEqual([]);
      const [crash] = await records(h);
      expect(crash).toMatchObject({ ticket: "TARS-1", outcome: "error", resume: "research" });
      expect(crash.phases[0]).toMatchObject({ role: "research", outcome: "error", failure_category: "agent_error" });
      h.clock.advance(5_000);
      await runWorkerIteration(h.deps);
      expect(runSkillCalls(h)).toEqual([]);

      h.clock.advance(5_000);
      await runWorkerIteration(h.restart({ roles: ["research"] }));
      expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["research", "TARS-1"]]);
      expect(h.jira.calls("claimTicket")).toEqual([]);
      const last = (await records(h)).at(-1)!;
      expect(last).toMatchObject({ ticket: "TARS-1", outcome: "landed" });
      expect(last.resume).toBeUndefined();
    });

    it("a --phase research process adopting a crashed dev flight records it but never runs dev; a dev process resumes it", async () => {
      h = await harness({ deps: { roles: ["research"] }, session: makeSession("dev-1", flight("TARS-2", "dev")) });

      await runWorkerIteration(h.deps);

      expect(runSkillCalls(h)).toEqual([]);
      expect(h.jira.calls("transitionStatus")).toEqual([]);
      expect((await records(h))[0]).toMatchObject({ ticket: "TARS-2", outcome: "error", resume: "dev" });

      h.clock.advance(5_000);
      await runWorkerIteration(h.restart({ roles: ["dev"] }));
      expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["dev", "TARS-2"]]);
      h.clock.advance(5_000);
      await runWorkerIteration(h.restart({ roles: ["dev"] }));
      expect(runSkillCalls(h)).toHaveLength(1);
    });

    it("a resume pending in the log is not re-run once the ticket is at maxAttemptsPerTicket (step 2 blocks it)", async () => {
      h = await harness({ session: makeSession("dev-1", flight("TARS-2", "dev")) });
      await appendIteration(
        h.logPath,
        rec({ ticket: "TARS-2", outcome: "error", phases: [phase({ role: "dev", skill: "ticket-to-pr", outcome: "error" })] }),
      );

      await runWorkerIteration(h.deps);

      expect(runSkillCalls(h)).toEqual([]);
      expect((await records(h)).at(-1)!.outcome).toBe("blocked-attempts");
    });

    it("an interrupted flight (SIGINT/SIGTERM mid-phase) is resumed with no crash error phase (not a failed attempt)", async () => {
      h = await harness({ session: makeSession("dev-1", flight("TARS-1", "research", { interrupted: true })) });

      await runWorkerIteration(h.deps);

      const recs = await records(h);
      expect(recs[0]).toMatchObject({ ticket: "TARS-1", outcome: "interrupted", phases: [], resume: "research" });
      expect(recs.flatMap((r) => r.phases).some((p) => p.outcome === "error")).toBe(false);
      expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["research", "TARS-1"], ["dev", "TARS-1"]]);
    });

    it("setInFlight(dev) throws after research landed + handoff: the research record (and its cost) is appended, then paused", async () => {
      h = await harness({
        script: { research: [{ costUsd: 7 }] },
        session: makeSession("dev-1", null, [], (f) => f?.role === "dev"),
      });
      h.jira.research = [ticket("TARS-1")];

      const result = await runWorkerIteration(h.deps);

      expect(result.kind).toBe("paused");
      const [r] = await records(h);
      expect(r.ticket).toBe("TARS-1");
      expect(r.phases.map((p) => [p.role, p.outcome, p.cost_usd, p.handoff])).toEqual([["research", "landed", 7, "done"]]);
      if (result.kind === "paused") {
        expect(result.reason).toMatch(/session lock lost/);
        expect(result.record).toEqual(r);
      }
      expect(runSkillCalls(h).map((e) => e[1])).toEqual(["research"]);
    });

    it("setInFlight(research) throws right after the claim: a record (claimed, not run, resume research) is appended, then paused; the next start resumes it", async () => {
      h = await harness({ session: makeSession("dev-1", null, [], (f) => f?.role === "research") });
      h.jira.research = [ticket("TARS-1")];

      const result = await runWorkerIteration(h.deps);

      expect(result.kind).toBe("paused");
      expect(runSkillCalls(h)).toEqual([]);
      const [r] = await records(h);
      expect(r).toMatchObject({ ticket: "TARS-1", outcome: "error", phases: [], resume: "research" });
      expect(r.detail).toMatch(/claimed/);
      if (result.kind === "paused") expect(result.record).toEqual(r);

      h.clock.advance(5_000);
      await runWorkerIteration(h.restart());
      expect(runSkillCalls(h)[0].slice(1, 3)).toEqual(["research", "TARS-1"]);
      expect(h.jira.calls("claimTicket")).toHaveLength(1);
    });

    it("a bad-key ticket returned first doesn't stall the queue: excluded by id, the next ticket runs", async () => {
      h = await harness();
      h.jira.research = [ticket("bad key", { id: "555" }), ticket("TARS-3")];

      await runWorkerIteration(h.deps);

      expect(runSkillCalls(h).map((e) => e[2])).toEqual(["TARS-3", "TARS-3"]);
      const researchPolls = h.jira.polls.filter((q) => !q.includes(`"${DEV_LABEL}"`));
      expect(researchPolls[0]).not.toMatch(/id not in/);
      expect(researchPolls[1]).toMatch(/id not in \(555\)/);
      expect(h.logs.filter((m) => /invalid ticket key/i.test(m))).toHaveLength(1);
    });

    it("a bad-key ticket with a bad id too: logged, that role's poll stops this iteration (no injection)", async () => {
      h = await harness();
      h.jira.research = [ticket("bad key", { id: "5) OR (1" }), ticket("TARS-3")];

      expect(await runWorkerIteration(h.deps)).toEqual({ kind: "idle" });
      expect(h.jira.polls.every((q) => !q.includes("OR (1"))).toBe(true);
    });

    it("a successful step-1 swap is recorded (handoff-done): three iterations with dev capped → one swap call", async () => {
      h = await harness({ config: (c) => (c.ceilings.maxRunsPerDay = 1) });
      await appendIteration(h.logPath, rec({ ticket: "TARS-9", phases: [phase()] }));
      await appendIteration(
        h.logPath,
        rec({ ticket: "TARS-8", started: "2026-11-11T02:00:00.000Z", ended: "2026-11-11T02:10:00.000Z", phases: [phase({ role: "dev", skill: "ticket-to-pr", started: "2026-11-11T02:00:00.000Z" })] }),
      );

      for (let i = 0; i < 3; i++) {
        await runWorkerIteration(h.deps);
        h.clock.advance(11 * MIN);
      }

      expect(h.jira.calls("swapLabel")).toHaveLength(1);
      const done = (await records(h)).filter((r) => r.outcome === "handoff-done");
      expect(done.map((r) => [r.ticket, r.phases])).toEqual([["TARS-9", []]]);
      expect(findPendingHandoffs(await records(h))).toEqual([]);
      expect(runSkillCalls(h)).toEqual([]);
    });

    it("dev assigns an unassigned ticket (non-fatal), as v1 did", async () => {
      h = await harness();
      h.jira.dev = [devTicket("TARS-3", { assignee: null })];
      h.jira.assignImpl = async () => {
        throw new Error("assign 403");
      };

      await runWorkerIteration(h.deps);

      expect(h.jira.calls("assignTicket")).toEqual([["assignTicket", "TARS-3", "acc-1"]]);
      expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["dev", "TARS-3"]]);
      expect((await records(h))[0].jira_sync_error).toMatch(/assign 403/);
    });

    it("dev does not reassign an assigned ticket", async () => {
      h = await harness();
      h.jira.dev = [devTicket("TARS-3")];
      await runWorkerIteration(h.deps);
      expect(h.jira.calls("assignTicket")).toEqual([]);
    });
  });
  describe("fix round 2", () => {
    const researchError = () => researchVerdict({ outcome: "error", failure_category: "agent_error", detail: "crashed in ground" });
    const researchKilled = () => researchVerdict({ outcome: "killed", failure_category: "killed_ceiling", detail: "timeout" });

    it("research error after a claim → resumed next iteration (no claim) → second failure → Blocked with comment; never polled again (Ruling 20)", async () => {
      h = await harness({ script: { research: [{ verdictRaw: researchError() }, { verdictRaw: researchKilled() }] } });
      h.jira.research = [ticket("TARS-1")]; // index lag: still returned

      await runWorkerIteration(h.deps);
      let recs = await records(h);
      expect(recs[0]).toMatchObject({ ticket: "TARS-1", outcome: "error", resume: "research" });

      h.clock.advance(5_000);
      await runWorkerIteration(h.deps);
      recs = await records(h);
      expect(recs[1]).toMatchObject({ ticket: "TARS-1", outcome: "killed", resume: "research" });

      for (let i = 0; i < 3; i++) {
        h.clock.advance(11 * MIN);
        await runWorkerIteration(h.deps);
      }

      expect(h.jira.calls("claimTicket")).toHaveLength(1);
      expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([
        ["research", "TARS-1"],
        ["research", "TARS-1"],
      ]);
      expect(h.jira.comments).toHaveLength(1);
      expect(JSON.stringify(h.jira.comments[0].body)).toMatch(/2 failed research attempts/);
      expect(h.jira.calls("transitionStatus").filter((e) => e[2] === "Blocked")).toEqual([["transitionStatus", "TARS-1", "Blocked", undefined]]);
      expect((await records(h)).filter((r) => r.outcome === "blocked-attempts").map((r) => r.ticket)).toEqual(["TARS-1"]);
    });

    it("a dev error carries no resume: the dev poll re-finds it (dev label, status not Blocked/Code Review)", async () => {
      h = await harness({ script: { dev: [{ verdictRaw: devError() }] } });
      h.jira.dev = [devTicket("TARS-3")];

      await runWorkerIteration(h.deps);

      const [r] = await records(h);
      expect(r.outcome).toBe("error");
      expect(r.resume).toBeUndefined();
    });

    it("step-0 resume respects maxRunsPerDay for its role: research capped → no resume, paused", async () => {
      h = await harness({ config: (c) => (c.ceilings.maxRunsPerDay = 1), deps: { roles: ["research"] } });
      await appendIteration(
        h.logPath,
        rec({ ticket: "TARS-1", outcome: "error", resume: "research", started: "2026-11-11T11:00:00.000Z", ended: "2026-11-11T11:10:00.000Z", phases: [phase({ outcome: "error", started: "2026-11-11T11:00:00.000Z" })] }),
      );

      const result = await runWorkerIteration(h.deps);

      expect(runSkillCalls(h)).toEqual([]);
      expect(result.kind).toBe("paused");
    });

    it("the attempt cap acts only for roles this process runs: --phase research never Blocks for dev failures; --phase dev does", async () => {
      h = await harness({ deps: { roles: ["research"] } });
      const devErr = (ended: string) =>
        rec({ ticket: "TARS-7", outcome: "error", started: ended, ended, phases: [phase({ role: "dev", skill: "ticket-to-pr", outcome: "error", started: ended })] });
      await appendIteration(h.logPath, devErr("2026-11-11T01:00:00.000Z"));
      await appendIteration(h.logPath, devErr("2026-11-11T02:00:00.000Z"));

      await runWorkerIteration(h.deps);
      expect(h.jira.comments).toEqual([]);
      expect(h.jira.calls("transitionStatus")).toEqual([]);
      expect((await records(h)).some((r) => r.outcome === "blocked-attempts")).toBe(false);

      await runWorkerIteration(h.restart({ roles: ["dev"] }));
      expect((await records(h)).filter((r) => r.outcome === "blocked-attempts").map((r) => r.ticket)).toEqual(["TARS-7"]);
    });

    it("recordAdoptedFlights records the adopted flights before the first iteration; the first iteration doesn't re-record them", async () => {
      const f = { ticket: "TARS-1", role: "research" as const, runDir: v2RunDir("repo", "dev-1", "TARS-1", "research", "20261111T110000Z"), since: "2026-11-11T11:00:00.000Z" };
      h = await harness({ session: makeSession("dev-1", f, [{ ...f, ticket: "TARS-5", runDir: v2RunDir("repo", "dev-1", "TARS-5", "research", "20261111T110000Z") }]) });

      await recordAdoptedFlights(h.deps);
      expect((await records(h)).map((r) => [r.ticket, r.resume])).toEqual([
        ["TARS-1", "research"],
        ["TARS-5", "research"],
      ]);
      expect(runSkillCalls(h)).toEqual([]);

      await runWorkerIteration(h.deps);
      const crash = (await records(h)).filter((r) => r.phases.some((p) => /in-flight/.test(p.detail)));
      expect(crash).toHaveLength(2);
      expect(runSkillCalls(h)[0].slice(1, 3)).toEqual(["research", "TARS-1"]);
    });
  });

  describe("sandbox metadata on phase entries (spec 6)", () => {
    it("each PhaseEntry carries sandbox {adapter, instance, prepare_ms} when its run was sandboxed", async () => {
      const r = { adapter: "fake", instance: "dl-4-repo-tars-1-research-aaaaaa", prepare_ms: 900 };
      const d = { adapter: "fake", instance: "dl-4-repo-tars-1-dev-bbbbbb", prepare_ms: 1100 };
      h = await harness({ script: { research: [{ sandbox: r }], dev: [{ sandbox: d }] } });
      h.jira.research = [ticket("TARS-1")];
      await runWorkerIteration(h.deps);
      const [rec0] = await records(h);
      expect(rec0.phases.map((p) => p.sandbox)).toEqual([r, d]);
    });

    it("an unsandboxed PhaseEntry has no sandbox key", async () => {
      h = await harness({ script: { dev: [{}] } });
      h.jira.dev = [devTicket("TARS-3")];
      await runWorkerIteration(h.deps);
      const [rec0] = await records(h);
      expect(rec0.phases).toHaveLength(1);
      expect("sandbox" in rec0.phases[0]).toBe(false);
    });
  });

  describe("parked: an enforcing sandbox refused the run (spec 4.6)", () => {
    const denied = [{ kind: "network" as const, target: "evil.example" }];
    const parkedStep = (o: Record<string, unknown> = {}) => ({
      verdictRaw: undefined,
      parked: { denied, approveHint: "allow evil.example" },
      costUsd: 0.5,
      ...o,
    });
    const after = (x: Harness, i: number, names: string[]) => x.events.slice(i + 1).filter((e) => names.includes(e[0] as string));
    const JIRA_WRITES = ["transitionStatus", "addComment", "swapLabel", "removeLabel", "assignTicket", "claimTicket", "gh.addComment"];

    it("a parked dev run appends one parked record with resume dev and no phases, and notifies", async () => {
      const notify = vi.fn();
      h = await harness({ script: { dev: [parkedStep()] }, deps: { notify } });
      h.jira.dev = [devTicket("TARS-3")];

      const result = await runWorkerIteration(h.deps);

      const recs = await records(h);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({
        ticket: "TARS-3",
        outcome: "parked",
        phases: [],
        resume: "dev",
        detail: "sandbox refused: network evil.example",
        parked: { role: "dev", failure_category: "sandbox_denied", denied, approveHint: "allow evil.example", cost_usd: 0.5 },
      });
      expect(recs[0].parked!.run_dir).toBe(runSkillCalls(h)[0][4]);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith("dev-loop: TARS-3 parked", "sandbox refused evil.example; run npm run sandbox:approvals");
      expect(result).toEqual({ kind: "did", record: recs[0] });
      expect(h.session.current).toBeNull();
    });

    it("a parked dev after a landed research keeps the research phase in the parked record", async () => {
      h = await harness({ script: { research: [{ costUsd: 2 }], dev: [parkedStep()] } });
      h.jira.research = [ticket("TARS-1")];

      const result = await runWorkerIteration(h.deps);

      const recs = await records(h);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ ticket: "TARS-1", outcome: "parked", resume: "dev", parked: { role: "dev", cost_usd: 0.5 } });
      expect(recs[0].phases.map((p) => [p.role, p.outcome, p.handoff, p.cost_usd])).toEqual([["research", "landed", "done", 2]]);
      expect(result.kind).toBe("did");
    });

    it("a parked research run appends parked with resume research", async () => {
      h = await harness({ script: { research: [parkedStep()] } });
      h.jira.research = [ticket("TARS-1")];

      const result = await runWorkerIteration(h.deps);

      const recs = await records(h);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({
        ticket: "TARS-1",
        outcome: "parked",
        phases: [],
        resume: "research",
        parked: { role: "research", failure_category: "sandbox_denied", denied },
      });
      expect(runSkillCalls(h).map((e) => e[1])).toEqual(["research"]);
      expect(result.kind).toBe("did");
    });

    it("a parked ticket is excluded from the next iteration's poll and not resumed", async () => {
      h = await harness({ script: { dev: [parkedStep()] } });
      h.jira.dev = [devTicket("TARS-3")];
      await runWorkerIteration(h.deps);
      expect((await records(h))[0].outcome).toBe("parked");

      // Past the recently-ended window: only the parked exclusion keeps it out.
      h.clock.advance(11 * MIN);
      const mark = h.events.length;
      const result = await runWorkerIteration(h.deps);

      expect(result).toEqual({ kind: "idle" });
      expect(runSkillCalls(h)).toHaveLength(1);
      const later = h.events.slice(mark);
      expect(later.filter((e) => e[0] === "getStatus")).toEqual([]); // resumeNext never picked it
      const devPolls = later.filter((e) => e[0] === "poll" && String(e[1]).includes(`"${DEV_LABEL}"`));
      expect(devPolls.length).toBeGreaterThan(0);
      for (const p of devPolls) expect(p[1]).toContain('key not in ("TARS-3")');
      expect(await records(h)).toHaveLength(1);
    });

    it("after an unparked record, pendingResumes returns the ticket and the next iteration resumes it", async () => {
      h = await harness({ script: { dev: [parkedStep()] } });
      h.jira.dev = [devTicket("TARS-3")];
      await runWorkerIteration(h.deps);
      h.clock.advance(11 * MIN);
      const t = new Date(h.clock.t).toISOString();
      await appendIteration(h.logPath, rec({ ticket: "TARS-3", session: "approvals", started: t, ended: t, outcome: "unparked", phases: [], resume: "dev", detail: "cleared by sandbox:approvals" }));

      const result = await runWorkerIteration(h.deps);

      expect(result.kind).toBe("did");
      expect(runSkillCalls(h).map((e) => [e[1], e[2]])).toEqual([["dev", "TARS-3"], ["dev", "TARS-3"]]);
      const recs = await records(h);
      expect(recs.map((r) => r.outcome)).toEqual(["parked", "unparked", "landed"]);
      expect(h.jira.calls("claimTicket")).toEqual([]);
    });

    it("a parked dev run over maxCostPerRunUsd pauses the loop after the parked record", async () => {
      h = await harness({ script: { dev: [parkedStep({ costUsd: 30 })] } });
      h.jira.dev = [devTicket("TARS-3")];

      const result = await runWorkerIteration(h.deps);

      const [r] = await records(h);
      expect(r).toMatchObject({ outcome: "parked", parked: { cost_usd: 30 } });
      expect(result.kind).toBe("paused");
      if (result.kind === "paused") {
        expect(result.reason).toMatch(/maxCostPerRunUsd/);
        expect(result.record).toEqual(r);
      }
    });

    it("a parked research run over runTimeoutMin pauses the loop after the parked record", async () => {
      h = await harness({ script: { research: [parkedStep({ started: "2026-11-11T08:00:00.000Z", ended: "2026-11-11T11:00:00.000Z" })] } });
      h.jira.research = [ticket("TARS-1")];

      const result = await runWorkerIteration(h.deps);

      const [r] = await records(h);
      expect(r).toMatchObject({ outcome: "parked", resume: "research" });
      expect(result.kind).toBe("paused");
      if (result.kind === "paused") {
        expect(result.reason).toMatch(/^research: runDurationMin/);
        expect(result.record).toEqual(r);
      }
    });

    it("a parked run within the ceilings does not pause", async () => {
      h = await harness({ script: { dev: [parkedStep({ costUsd: 19 })] } });
      h.jira.dev = [devTicket("TARS-3")];
      expect((await runWorkerIteration(h.deps)).kind).toBe("did");
    });

    it("an all-infra park writes one parked record, notifies, then pauses the worker naming the --clear command", async () => {
      const notify = vi.fn();
      const infra = [{ kind: "infra" as const, target: "prepare" }];
      h = await harness({
        script: { dev: [parkedStep({ parked: { denied: infra, approveHint: "sandbox prepare failed: daemon down", allInfra: true } })] },
        deps: { notify },
      });
      h.jira.dev = [devTicket("TARS-3"), devTicket("TARS-4")];

      const result = await runWorkerIteration(h.deps);

      const recs = await records(h);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ ticket: "TARS-3", outcome: "parked", resume: "dev", parked: { role: "dev", denied: infra } });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("paused");
      if (result.kind === "paused") {
        expect(result.reason).toMatch(/^sandbox infrastructure failed:/);
        expect(result.reason).toContain("npm run sandbox:approvals -- --clear=TARS-3");
        expect(result.record).toEqual(recs[0]);
      }
      expect(runSkillCalls(h)).toHaveLength(1);
    });

    it("an all-infra park with a lost session lock pauses with the lock reason (fatal first)", async () => {
      const infra = [{ kind: "infra" as const, target: "prepare" }];
      h = await harness({
        script: { dev: [parkedStep({ parked: { denied: infra, allInfra: true } })] },
        session: makeSession("dev-1", null, [], (f, n) => f === null && n === 2),
      });
      h.jira.dev = [devTicket("TARS-3")];
      const result = await runWorkerIteration(h.deps);
      expect(result.kind).toBe("paused");
      if (result.kind === "paused") expect(result.reason).toMatch(/session's in-flight record/);
    });

    it("a mixed network + infra park returns did, as before", async () => {
      const mixed = [...denied, { kind: "infra" as const, target: "inspect" }];
      h = await harness({ script: { dev: [parkedStep({ parked: { denied: mixed } })] } });
      h.jira.dev = [devTicket("TARS-3")];
      const result = await runWorkerIteration(h.deps);
      expect(result.kind).toBe("did");
    });

    it("the parked record carries sandbox {adapter, instance, prepare_ms} when the run was sandboxed", async () => {
      const meta = { adapter: "fake", instance: "dl-4-repo-tars-3-dev-a1b2c3", prepare_ms: 1200 };
      h = await harness({ script: { dev: [parkedStep({ sandbox: meta })] } });
      h.jira.dev = [devTicket("TARS-3")];
      await runWorkerIteration(h.deps);
      expect((await records(h))[0].parked!.sandbox).toEqual(meta);
    });

    it("a parked record without sandbox metadata has no sandbox key", async () => {
      h = await harness({ script: { dev: [parkedStep()] } });
      h.jira.dev = [devTicket("TARS-3")];
      await runWorkerIteration(h.deps);
      expect("sandbox" in (await records(h))[0].parked!).toBe(false);
    });

    it("a parked run makes no Jira transition or comment", async () => {
      h = await harness({ script: { research: [parkedStep()] } });
      h.jira.research = [ticket("TARS-1")];
      await runWorkerIteration(h.deps);
      const claim = idx(h, (e) => e[0] === "claimTicket");
      expect(claim).toBeGreaterThan(-1);
      expect(h.jira.calls("claimTicket")).toHaveLength(1);
      expect(after(h, claim, JIRA_WRITES)).toEqual([]);
      await h.cleanup();

      // Dev (no claim at all): nothing is written to Jira or GitHub.
      h = await harness({ script: { dev: [parkedStep()] } });
      h.jira.dev = [devTicket("TARS-3")];
      await runWorkerIteration(h.deps);
      expect(after(h, -1, JIRA_WRITES)).toEqual([]);
      expect(h.github.comments).toEqual([]);
    });
  });
});
