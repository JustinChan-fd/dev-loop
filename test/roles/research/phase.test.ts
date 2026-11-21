import { describe, it, expect, vi } from "vitest";
import { runResearchPhase } from "../../../src/roles/research/phase.ts";
import type { ResearchPhaseDeps } from "../../../src/roles/research/phase.ts";
import type { JiraClient, JiraTicket } from "../../../src/core/jira-client.ts";
import type { RunSkillFn, RunSkillResult } from "../../../src/core/run-skill.ts";
import { roleView } from "../../../src/core/config.ts";
import { makeV2Config } from "../../fixtures/config.ts";

function makeTicket(o: Partial<JiraTicket> = {}): JiraTicket {
  return { key: "PROJ-142", status: "In Progress", labels: ["auto-promote"], assignee: "user-123", ...o };
}

function makeMockJiraClient(o: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => null),
    pollAllMatching: vi.fn(async () => []),
    claimTicket: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => undefined),
    swapLabel: vi.fn(async () => undefined),
    removeLabel: vi.fn(async () => undefined),
    assignTicket: vi.fn(async () => undefined),
    addComment: vi.fn(async () => undefined),
    closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
    getBlockedBy: vi.fn(async () => []),
    ...o,
  };
}

const verdict = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ outcome: "ready", phase_reached: "verify", failure_category: null, detail: "Looks good.", ...o });

function skill(verdictRaw: string | undefined, o: Partial<RunSkillResult> = {}): RunSkillFn & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    verdictRaw,
    started: "2026-08-16T14:02:11.000Z",
    ended: "2026-08-16T14:19:40.000Z",
    // Deliberately different from any verdict cost/tokens: the measured values must be recorded.
    costUsd: 4.5,
    tokens: { in: 1234, out: 567 },
    skillVersion: "abc1234",
    model: "sonnet",
    ...o,
  })) as unknown as RunSkillFn & ReturnType<typeof vi.fn>;
}

function makeDeps(o: Partial<ResearchPhaseDeps> = {}): ResearchPhaseDeps {
  return {
    jira: makeMockJiraClient(),
    view: roleView(makeV2Config(), "research"),
    runSkill: skill(verdict()),
    runDir: ".pipeline/v2/repo/dev-1/PROJ-142/research-20260816T140211Z",
    maxBudgetUsd: 50,
    now: () => new Date("2026-08-16T14:00:00.000Z"),
    ...o,
  };
}

describe("runResearchPhase", () => {
  it("calls runSkill with role research, the key, the run dir and the budget; never claims, polls, assigns or swaps", async () => {
    const deps = makeDeps();
    await runResearchPhase(makeTicket(), deps);
    expect(deps.runSkill).toHaveBeenCalledWith({
      role: "research",
      ticketKey: "PROJ-142",
      runDir: ".pipeline/v2/repo/dev-1/PROJ-142/research-20260816T140211Z",
      maxBudgetUsd: 50,
    });
    for (const m of ["claimTicket", "pollOldestMatching", "assignTicket", "swapLabel", "transitionStatus"] as const) {
      expect(deps.jira[m]).not.toHaveBeenCalled();
    }
  });

  it('"ready" → landed, with the measured cost/tokens, run dir, and pr always null — and no label swap even with auto-promote (the cycle owns the handoff)', async () => {
    const deps = makeDeps({ runSkill: skill(verdict({ pr: "https://github.com/org/repo/pull/1" })) });
    const entry = await runResearchPhase(makeTicket(), deps);
    expect(entry).toMatchObject({
      role: "research",
      skill: "ticket-refine",
      skill_version: "abc1234",
      model: "sonnet",
      outcome: "landed",
      phase_reached: "verify",
      cost_usd: 4.5,
      tokens: { in: 1234, out: 567 },
      failure_category: null,
      detail: "Looks good.",
      pr: null,
      run_dir: ".pipeline/v2/repo/dev-1/PROJ-142/research-20260816T140211Z",
    });
    expect(entry.handoff).toBeUndefined();
    expect(deps.jira.swapLabel).not.toHaveBeenCalled();
  });

  it("bounced → transitions to the bounced status", async () => {
    const deps = makeDeps({ runSkill: skill(verdict({ outcome: "bounced", failure_category: "spec_contradicted", detail: "AC2 vs AC4" })) });
    const entry = await runResearchPhase(makeTicket(), deps);
    expect(entry.outcome).toBe("bounced");
    expect(deps.jira.transitionStatus).toHaveBeenCalledWith("PROJ-142", "Blocked");
    expect(deps.jira.swapLabel).not.toHaveBeenCalled();
  });

  it("a bounced-status transition failure never throws: surfaced via jira_sync_error", async () => {
    const jira = makeMockJiraClient({
      transitionStatus: vi.fn(async () => {
        throw new Error("Jira 500");
      }),
    });
    const entry = await runResearchPhase(makeTicket(), makeDeps({ jira, runSkill: skill(verdict({ outcome: "bounced" })) }));
    expect(entry.outcome).toBe("bounced");
    expect(entry.jira_sync_error).toMatch(/Jira 500/);
  });

  it("malformed or missing verdict.json → error / agent_error, no Jira write", async () => {
    for (const raw of ["{nope", undefined]) {
      const deps = makeDeps({ runSkill: skill(raw) });
      const entry = await runResearchPhase(makeTicket(), deps);
      expect(entry.outcome).toBe("error");
      expect(entry.failure_category).toBe("agent_error");
      expect(deps.jira.transitionStatus).not.toHaveBeenCalled();
    }
  });

  it("runSkill throws → error entry with agent_error and the message, no throw", async () => {
    const runSkill = vi.fn(async () => {
      throw new Error("ENOENT claude");
    }) as unknown as RunSkillFn;
    const entry = await runResearchPhase(makeTicket(), makeDeps({ runSkill }));
    expect(entry.outcome).toBe("error");
    expect(entry.failure_category).toBe("agent_error");
    expect(entry.detail).toMatch(/ENOENT claude/);
    expect(entry.cost_usd).toBe(0);
  });

  describe("verdict checks (bounce criteria v2)", () => {
    const GROUND = '{"phase":"ground","event":"phase_end"}\n';
    const fetchedManifest = { ticket: "PROJ-142", dir: "/r/attachments", attachments: [{ id: "1", filename: "mock.html", size: 1, status: "fetched" as const, path: "/r/attachments/mock.html" }] };
    const factsDeps = (f: Partial<import("../../../src/roles/research/verdict-checks.ts").ResearchFacts>) => ({
      readFacts: async () => ({ progressRaw: GROUND, manifest: null, coverageWarnsSoFar: 0, coverageWarnRuns: 5, ...f }),
    });

    it("a refused verdict becomes an agent_error entry with verdict_check and no Jira transition", async () => {
      const deps = makeDeps({ runSkill: skill(verdict({ outcome: "bounced", phase_reached: "plan", failure_category: "too_large", detail: "XL" })), ...factsDeps({ progressRaw: "" }) });
      const e = await runResearchPhase(makeTicket(), deps);
      expect(e).toMatchObject({ outcome: "error", failure_category: "agent_error", verdict_check: "too_large_ungrounded", cost_usd: 4.5 });
      expect(e.detail.startsWith("loop refused the verdict: ")).toBe(true);
      expect(deps.jira.transitionStatus).not.toHaveBeenCalled();
    });

    it("a refused verdict posts one '❌ research-loop -' comment saying the skill's comment is superseded", async () => {
      const deps = makeDeps({ runSkill: skill(verdict({ outcome: "bounced", phase_reached: "plan", failure_category: "too_large", detail: "XL" })), ...factsDeps({ progressRaw: "" }) });
      await runResearchPhase(makeTicket(), deps);
      expect(deps.jira.addComment).toHaveBeenCalledTimes(1);
      const body = JSON.stringify((deps.jira.addComment as ReturnType<typeof vi.fn>).mock.calls[0][1]);
      expect(body).toContain("❌ research-loop - verdict refused by the loop (too_large_ungrounded)");
      expect(body).toContain("superseded");
    });

    it("a failed refusal comment is a sync error, never a throw", async () => {
      const jira = makeMockJiraClient({ addComment: vi.fn(async () => { throw new Error("Jira 500"); }) });
      const e = await runResearchPhase(makeTicket(), makeDeps({ jira, runSkill: skill(verdict({ outcome: "bounced", phase_reached: "plan", failure_category: "too_large" })), ...factsDeps({ progressRaw: "" }) }));
      expect(e.outcome).toBe("error");
      expect(e.jira_sync_error).toContain("Jira 500");
    });

    it("bounce_blocked moves the ticket to bounced and comments the manifest lines", async () => {
      const m = { ticket: "PROJ-142", dir: "/r", attachments: [{ id: "1", filename: "build.zip", size: 1, status: "skipped" as const, reason: "type .zip is not fetched" }] };
      const deps = makeDeps(factsDeps({ manifest: m }));
      const e = await runResearchPhase(makeTicket(), deps);
      expect(e).toMatchObject({ outcome: "bounced", failure_category: "blocked", verdict_check: "attachment_unreadable" });
      expect(e.detail).toContain("build.zip");
      expect(deps.jira.transitionStatus).toHaveBeenCalledWith("PROJ-142", deps.view.statusNames.bounced);
      expect(deps.jira.addComment).toHaveBeenCalledTimes(1);
      const body = JSON.stringify((deps.jira.addComment as ReturnType<typeof vi.fn>).mock.calls[0][1]);
      expect(body).toContain("build.zip");
      expect(body).toContain("❌ research-loop - blocked, attachment unreadable");
    });

    it("coverage_warned lands and records verdict_check", async () => {
      const e = await runResearchPhase(makeTicket(), makeDeps(factsDeps({ manifest: fetchedManifest })));
      expect(e).toMatchObject({ outcome: "landed", verdict_check: "coverage_warned" });
    });

    it("an accepted too_large bounce records size_evidence", async () => {
      const ev = { criterion: "B", comparison_tickets: ["TARS-1554"], risk_factors: ["async or stateful UI"] };
      const e = await runResearchPhase(makeTicket(), makeDeps({ runSkill: skill(verdict({ outcome: "bounced", phase_reached: "plan", failure_category: "too_large", size_evidence: ev })), ...factsDeps({}) }));
      expect(e).toMatchObject({ outcome: "bounced", failure_category: "too_large", size_evidence: ev });
      expect("verdict_check" in e).toBe(false);
    });
  });

  it("carries size_estimate and ac_count on a bounced run too", async () => {
    const e = await runResearchPhase(
      makeTicket(),
      makeDeps({ runSkill: skill(verdict({ outcome: "bounced", failure_category: "spec_ambiguous", size_estimate: "L", ac_count: 9 })) }),
    );
    expect(e.size_estimate).toBe("L");
    expect(e.ac_count).toBe(9);
  });

  describe("size_trajectory", () => {
    it("carries a well-formed size_trajectory", async () => {
      const entry = await runResearchPhase(
        makeTicket(),
        makeDeps({ runSkill: skill(verdict({ size_trajectory: { step4_tshirt: "M", delta: "unchanged", final_score: 4.5 } })) }),
      );
      expect(entry.size_trajectory).toEqual({ step4_tshirt: "M", delta: "unchanged", final_score: 4.5 });
    });

    it("drops a malformed size_trajectory and never flips outcome to error", async () => {
      const entry = await runResearchPhase(
        makeTicket(),
        makeDeps({ runSkill: skill(verdict({ size_trajectory: { step4_tshirt: "HUGE", delta: "grew", final_score: 999 } })) }),
      );
      expect(entry.outcome).toBe("landed");
      expect(entry.size_trajectory).toBeUndefined();
    });

    it("absent → no size_trajectory field", async () => {
      const entry = await runResearchPhase(makeTicket(), makeDeps());
      expect("size_trajectory" in entry).toBe(false);
    });
  });
});
