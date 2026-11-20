// The eval graders (Task 16, spec §9.2): pure functions over v2 iteration
// records plus injected GitHub/Jira state. Fixtures here stand in for
// runs/v2/<slug>.jsonl and the gathered state; nothing outward runs.

import { describe, expect, it } from "vitest";
import type { IterationRecord, PhaseEntry } from "../../src/core/iteration-log.ts";
import { grade as gradeClean } from "../../evals/check-clean.mjs";
import { grade as gradeAmbiguous } from "../../evals/check-ambiguous.mjs";
import { grade as gradeDevBounce } from "../../evals/check-dev-bounce.mjs";
import { grade as gradeBlocked } from "../../evals/check-blocked.mjs";
import { grade as gradeQueue } from "../../evals/check-queue.mjs";

const A = "TARS-9001";
const B = "TARS-9002";
const PR_URL = "https://github.com/JustinChan-fd/dev-loop-eval-sandbox/pull/1";

function phase(role: "research" | "dev", outcome: PhaseEntry["outcome"], extra: Partial<PhaseEntry> = {}): PhaseEntry {
  return {
    role,
    skill: role === "research" ? "ticket-refine" : "ticket-to-pr",
    skill_version: "2.0.0",
    model: "m",
    started: "2026-11-12T10:00:00.000Z",
    ended: "2026-11-12T10:20:00.000Z",
    outcome,
    phase_reached: "done",
    cost_usd: 3,
    tokens: { in: 1, out: 1 },
    failure_category: null,
    detail: "",
    pr: null,
    run_dir: "/x/.pipeline/v2/p/s1/run",
    ...extra,
  } as PhaseEntry;
}

function rec(ticket: string, outcome: IterationRecord["outcome"], phases: PhaseEntry[], extra: Partial<IterationRecord> = {}): IterationRecord {
  return {
    ticket,
    session: "s1",
    loop_version: "2.0.0",
    started: "2026-11-12T10:00:00.000Z",
    ended: "2026-11-12T10:40:00.000Z",
    outcome,
    phases,
    ...extra,
  };
}

const landedClean = (ticket = A) =>
  rec(ticket, "landed", [phase("research", "landed", { handoff: "done" }), phase("dev", "landed", { pr: PR_URL })]);
const openPr = (headlines = [`test(${A}): add failing tests for ACs`, `feat(${A}): implement clamp01`]) => ({
  url: PR_URL,
  state: "OPEN",
  commits: headlines.map((headline) => ({ headline })),
});

describe("check-clean", () => {
  it("passes: landed, 2 phases, PR open, RED commit before GREEN", () => {
    const r = gradeClean({ records: [landedClean()], pr: openPr(), jira: { key: A, status: "Code Review" } });
    expect(r).toEqual({ pass: true, reasons: [] });
  });

  it("fails: RED commit after GREEN", () => {
    const r = gradeClean({
      records: [landedClean()],
      pr: openPr([`feat(${A}): implement clamp01`, `test(${A}): add failing tests for ACs`]),
      jira: { key: A, status: "Code Review" },
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/RED/);
  });

  it("fails: no RED commit at all", () => {
    const r = gradeClean({ records: [landedClean()], pr: openPr([`feat(${A}): implement clamp01`]), jira: { key: A, status: "Code Review" } });
    expect(r.pass).toBe(false);
  });

  it("fails: only one phase recorded", () => {
    const r = gradeClean({ records: [rec(A, "landed", [phase("research", "landed")])], pr: openPr(), jira: { key: A, status: "Code Review" } });
    expect(r.pass).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/2 phases/);
  });

  it("fails: PR not open", () => {
    const r = gradeClean({ records: [landedClean()], pr: { ...openPr(), state: "CLOSED" }, jira: { key: A, status: "Code Review" } });
    expect(r.pass).toBe(false);
  });

  it("fails: no PR, and no record for the key", () => {
    expect(gradeClean({ records: [landedClean()], pr: null, jira: { key: A, status: "Code Review" } }).pass).toBe(false);
    expect(gradeClean({ records: [landedClean(B)], pr: openPr(), jira: { key: A, status: "Code Review" } }).pass).toBe(false);
  });

  it("fails: the recorded dev PR is not the PR graded", () => {
    const r = gradeClean({ records: [landedClean()], pr: { ...openPr(), url: `${PR_URL}0` }, jira: { key: A, status: "Code Review" } });
    expect(r.pass).toBe(false);
  });
});

describe("check-ambiguous", () => {
  const bounced = () => rec(A, "bounced", [phase("research", "bounced", { failure_category: "spec_ambiguous" })]);

  it("passes: research bounced, ticket in Blocked, 1 phase", () => {
    expect(gradeAmbiguous({ records: [bounced()], pr: null, jira: { key: A, status: "Blocked" } })).toEqual({ pass: true, reasons: [] });
  });

  it("fails: ticket not in Blocked", () => {
    const r = gradeAmbiguous({ records: [bounced()], pr: null, jira: { key: A, status: "To Do" } });
    expect(r.pass).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/Blocked/);
  });

  it("fails: research landed and dev ran (2 phases)", () => {
    const r = gradeAmbiguous({ records: [landedClean()], pr: null, jira: { key: A, status: "Blocked" } });
    expect(r.pass).toBe(false);
  });

  it("fails: a PR was opened", () => {
    expect(gradeAmbiguous({ records: [bounced()], pr: openPr(), jira: { key: A, status: "Blocked" } }).pass).toBe(false);
  });
});

describe("check-dev-bounce", () => {
  const devBounced = (category: PhaseEntry["failure_category"] = "spec_ambiguous") =>
    rec(A, "bounced", [phase("research", "landed", { handoff: "done" }), phase("dev", "bounced", { failure_category: category })]);

  it("passes: research landed, dev bounced spec_ambiguous", () => {
    expect(gradeDevBounce({ records: [devBounced()], pr: null, jira: { key: A, status: "Blocked" } })).toEqual({ pass: true, reasons: [] });
  });

  it("fails: dev bounced with another category", () => {
    const r = gradeDevBounce({ records: [devBounced("too_large")], pr: null, jira: { key: A, status: "Blocked" } });
    expect(r.pass).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/spec_ambiguous/);
  });

  it("fails: research bounced (dev never ran)", () => {
    const r = gradeDevBounce({
      records: [rec(A, "bounced", [phase("research", "bounced")])],
      pr: null,
      jira: { key: A, status: "Blocked" },
    });
    expect(r.pass).toBe(false);
  });

  it("fails: dev opened a PR and then bounced", () => {
    const r = gradeDevBounce({ records: [devBounced()], pr: openPr(), jira: { key: A, status: "Blocked" } });
    expect(r.pass).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/PR/);
  });

  it("fails: dev landed", () => {
    expect(gradeDevBounce({ records: [landedClean()], pr: openPr(), jira: { key: A, status: "Code Review" } }).pass).toBe(false);
  });
});

describe("check-blocked", () => {
  const skipped = () => rec(A, "skipped-blocked", [], { blocked_by: [B], detail: "blocker open" });
  const blockerPr = { url: `${PR_URL}`, state: "OPEN", commits: [] };

  it("passes: skipped-blocked by the open-PR blocker, no claim, status still To Do", () => {
    expect(gradeBlocked({ records: [skipped()], pr: blockerPr, jira: { key: A, status: "To Do", blocker: B } })).toEqual({
      pass: true,
      reasons: [],
    });
  });

  it("fails: a claim happened (a record with a phase run)", () => {
    const r = gradeBlocked({
      records: [skipped(), rec(A, "bounced", [phase("research", "bounced")])],
      pr: blockerPr,
      jira: { key: A, status: "To Do", blocker: B },
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/claim/);
  });

  it("fails: the ticket left To Do", () => {
    const r = gradeBlocked({ records: [skipped()], pr: blockerPr, jira: { key: A, status: "In Progress", blocker: B } });
    expect(r.pass).toBe(false);
  });

  it("fails: no skipped-blocked record, or blocked_by misses the blocker", () => {
    expect(gradeBlocked({ records: [], pr: blockerPr, jira: { key: A, status: "To Do", blocker: B } }).pass).toBe(false);
    expect(
      gradeBlocked({
        records: [rec(A, "skipped-blocked", [], { blocked_by: ["TARS-1"] })],
        pr: blockerPr,
        jira: { key: A, status: "To Do", blocker: B },
      }).pass,
    ).toBe(false);
  });

  it("fails: the blocker's PR is not open (the setup did not hold)", () => {
    const r = gradeBlocked({ records: [skipped()], pr: { ...blockerPr, state: "MERGED" }, jira: { key: A, status: "To Do", blocker: B } });
    expect(r.pass).toBe(false);
  });
});

describe("check-queue", () => {
  const first = () => rec(A, "bounced", [phase("research", "bounced")]);
  const second = () => landedClean(B);
  const jira = { keys: [A, B] };

  it("passes: two records, first bounced, second landed", () => {
    expect(gradeQueue({ records: [first(), second()], pr: { ...openPr(), url: PR_URL }, jira })).toEqual({ pass: true, reasons: [] });
  });

  it("fails: only one record", () => {
    const r = gradeQueue({ records: [first()], pr: null, jira });
    expect(r.pass).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/2 records/);
  });

  it("fails: the second ticket was not landed", () => {
    const r = gradeQueue({ records: [first(), rec(B, "bounced", [phase("research", "bounced")])], pr: null, jira });
    expect(r.pass).toBe(false);
  });

  it("fails: worked out of order (second ticket first)", () => {
    const r = gradeQueue({ records: [second(), first()], pr: openPr(), jira });
    expect(r.pass).toBe(false);
  });

  it("ignores records for keys outside the scenario", () => {
    const r = gradeQueue({ records: [first(), landedClean("TARS-1"), second()], pr: openPr(), jira });
    expect(r.pass).toBe(true);
  });
});

describe("check-clean-app", async () => {
  const { grade: gradeCleanApp } = await import("../../evals/check-clean-app.mjs");
  const CANARY = "CANARY_ab12cd34ef";
  const good = () => ({
    records: [landedClean()],
    pr: openPr(),
    jira: { key: A, status: "Code Review" },
    progress: [
      '{"phase":"intake","event":"note","detail":"installed: direnv exec /c/.claude/worktrees/TARS-9001-20261120T010101Z/app npm ci; node v24.16.0"}',
    ].join("\n"),
    loopLog: "[worker] project: app folder app, node 24 (app/.nvmrc)\n[worker] robot env: 3 fake setting(s) from app/.env.example, node from ~/.nvm/versions/node/v24.16.0/bin\n",
    fakeEnvrc: "[ -d '/h/.nvm/versions/node/v24.16.0/bin' ] && PATH_add '/h/.nvm/versions/node/v24.16.0/bin'\nexport APP_API_URL='x'\n",
    texts: { "PR body": "Adds slugify.", "commit messages": "test(TARS-9001): x\nfeat(TARS-9001): y", "run dir TARS-9001/dev": "{}" },
    canary: CANARY,
    handover: { fakeNamesSeen: [] as string[] },
  });

  it("passes: landed, TDD PR, installed in app/ on node 24, fake from app/.env.example, no canary, no fake in the handover", () => {
    expect(gradeCleanApp(good())).toEqual({ pass: true, reasons: [] });
  });

  const failing: Array<[string, (g: ReturnType<typeof good>) => void, RegExp]> = [
    ["npm ci at the worktree root", (g) => void (g.progress = g.progress.replace("/app npm ci", " npm ci")), /npm ci.*app/],
    ["node 26 instead of the .nvmrc's 24", (g) => void (g.progress = g.progress.replace("v24.16.0", "v26.7.0")), /node v24/],
    ["no node PATH_add for v24 in the fake", (g) => void (g.fakeEnvrc = "export APP_API_URL='x'\n"), /PATH_add/],
    ["0 fake settings", (g) => void (g.loopLog = g.loopLog.replace("3 fake", "0 fake")), /fake setting/],
    ["the canary in a run dir", (g) => void (g.texts["run dir TARS-9001/dev"] = `x ${CANARY} y`), /canary.*run dir TARS-9001\/dev/],
    ["the canary in the PR body", (g) => void (g.texts["PR body"] = CANARY), /canary.*PR body/],
    ["a fake name in a person's handover", (g) => void (g.handover.fakeNamesSeen = ["APP_API_URL"]), /handover.*APP_API_URL/],
    ["GREEN before RED", (g) => void (g.pr = openPr([`feat(${A}): impl`, `test(${A}): tests`])), /RED commit/],
    ["no canary recorded", (g) => void (g.canary = ""), /canary/],
  ];
  it.each(failing)("fails: %s", (_name, mutate, reason) => {
    const g = good();
    mutate(g);
    const r = gradeCleanApp(g);
    expect(r.pass).toBe(false);
    expect(r.reasons.join("\n")).toMatch(reason);
  });
});
