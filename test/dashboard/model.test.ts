import { describe, expect, it } from "vitest";
import {
  FALLBACK_STEPS,
  QUIET_MS,
  activityFrom,
  buildFinishedRun,
  buildLiveRun,
  endedStep,
  githubUrl,
  groupLog,
  parseJsonl,
  parseLockBody,
  parseProgress,
  parseRunDir,
  seedsFromRecords,
  stepListFromSkill,
  stepStates,
  stepsFor,
} from "../../src/dashboard/model.ts";

const T = (s: string) => Date.parse(s);
const line = (ts: string, phase: string, event: string, detail: string) => JSON.stringify({ ts, phase, event, detail });
const DEV = ["intake", "plan", "red", "green", "verify", "pr"];
const RESEARCH = FALLBACK_STEPS.research;

describe("parseJsonl", () => {
  it("skips blank, malformed and a truncated last line", () => {
    expect(parseJsonl('{"a":1}\n\nnot json\n{"b":2}\n{"c":')).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it("is empty for an empty file", () => {
    expect(parseJsonl("")).toEqual([]);
  });
});

describe("parseProgress", () => {
  it("keeps lines with string ts/phase/event and a parseable ts; detail defaults to empty", () => {
    const raw = [
      line("2026-11-21T01:01:14Z", "intake", "phase_start", "intake MC-1"),
      JSON.stringify({ ts: "2026-11-21T01:02:00Z", phase: "intake", event: "note" }),
      JSON.stringify({ ts: "bad", phase: "intake", event: "note", detail: "x" }),
      JSON.stringify({ ts: "2026-11-21T01:03:00Z", phase: 3, event: "note", detail: "x" }),
      '{"ts":"2026-11-21T01:04:00Z","phase":"red"',
    ].join("\n");
    expect(parseProgress(raw)).toEqual([
      { ts: T("2026-11-21T01:01:14Z"), phase: "intake", event: "phase_start", detail: "intake MC-1" },
      { ts: T("2026-11-21T01:02:00Z"), phase: "intake", event: "note", detail: "" },
    ]);
  });
});

describe("step lists", () => {
  it("reads the declared phase names from a SKILL.md progress line", () => {
    const md = 'Each line:\n   {"ts": "<ISO>", "phase": "intake|plan|red|green|verify|pr", "event": "phase_start|phase_end|note"}\n';
    expect(stepListFromSkill(md)).toEqual(DEV);
  });
  it("is null when no list is declared", () => {
    expect(stepListFromSkill("# nothing here")).toBeNull();
  });
  it("fallback lists match today's skills (no qa step in dev)", () => {
    expect(FALLBACK_STEPS.dev).toEqual(DEV);
    expect(FALLBACK_STEPS.research).toEqual(["triage", "interpret", "ground", "attack", "scope", "blocked-check", "synthesize", "verify"]);
  });
  it("appends phases a run logged that the list doesn't declare, in the order seen", () => {
    expect(stepsFor(DEV, ["intake", "qa", "pr", "qa", "deploy"])).toEqual([...DEV, "qa", "deploy"]);
  });
});

describe("parseRunDir", () => {
  it("splits a v2 run dir", () => {
    expect(parseRunDir(".pipeline/v2/webtarsthree/dev-1/TARS-1634/dev-20261117T193417Z")).toEqual({
      project: "webtarsthree", session: "dev-1", ticket: "TARS-1634", phase: "dev", runId: "20261117T193417Z",
    });
  });
  it("refuses absolute, escaping, v1 and malformed paths", () => {
    for (const p of [
      "/abs/.pipeline/v2/w/dev-1/T-1/dev-20261117T193417Z",
      ".pipeline/v2/w/dev-1/T-1/../../../../.env",
      ".pipeline/v1/w/dev-1/TARS-1/dev-20261117T193417Z",
      ".pipeline/v2/w/dev-1/TARS-1/qa-20261117T193417Z",
      ".pipeline/v2/W/dev-1/TARS-1/dev-20261117T193417Z",
      ".pipeline/v2/w/dev-1/tars-1/dev-20261117T193417Z",
    ]) expect(parseRunDir(p)).toBeNull();
  });
});

describe("parseLockBody", () => {
  it("reads pid, started and a valid inFlight", () => {
    const body = { pid: 53679, started: 1794884870, inFlight: { ticket: "TARS-1", role: "dev", runDir: ".pipeline/v2/w/dev-1/TARS-1/dev-20261117T031247Z", since: "2026-11-17T03:12:47.174Z" } };
    expect(parseLockBody(JSON.stringify(body))).toEqual(body);
  });
  it("keeps a lock with no run in flight", () => {
    expect(parseLockBody('{"pid":5,"started":7,"inFlight":null}')).toEqual({ pid: 5, started: 7, inFlight: null });
  });
  it("refuses corrupt bodies and bad inFlight records", () => {
    for (const raw of ["", "{", '{"pid":"5","started":7,"inFlight":null}', '{"pid":5,"inFlight":null}',
      '{"pid":5,"started":7,"inFlight":{"ticket":"bad","role":"dev","runDir":"x","since":"y"}}',
      '{"pid":5,"started":7,"inFlight":{"ticket":"T-1","role":"qa","runDir":"x","since":"y"}}']) {
      expect(parseLockBody(raw)).toBeNull();
    }
  });
});

const phase = (o: Record<string, unknown>) => ({
  role: "dev", skill: "ticket-to-pr", started: "2026-11-21T01:00:47Z", ended: "2026-11-21T01:10:44Z", outcome: "landed",
  phase_reached: "pr", cost_usd: 1.73, failure_category: null, detail: "ready to push", pr: null,
  run_dir: ".pipeline/v2/cat/dev-1/MC-1/dev-20261121T010047Z", ...o,
});

describe("seedsFromRecords", () => {
  it("makes one seed per phase entry", () => {
    const recs = [{
      ticket: "MC-1", session: "dev-1", outcome: "landed", started: "2026-11-21T00:55:30Z", ended: "2026-11-21T01:10:44Z",
      phases: [
        phase({ role: "research", skill: "ticket-refine", outcome: "landed", phase_reached: "verify", run_dir: ".pipeline/v2/cat/dev-1/MC-1/research-20261121T005530Z", cost_usd: 1.17, started: "2026-11-21T00:55:30Z", ended: "2026-11-21T01:00:40Z" }),
        phase({ pr: "https://github.com/org/repo/pull/237" }),
      ],
    }];
    const s = seedsFromRecords("cat", recs);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ project: "cat", ticket: "MC-1", session: "dev-1", phase: "research", outcome: "landed", cost: 1.17, phaseReached: "verify" });
    expect(s[1]).toMatchObject({ phase: "dev", outcome: "landed", pr: "https://github.com/org/repo/pull/237", runDir: ".pipeline/v2/cat/dev-1/MC-1/dev-20261121T010047Z" });
    expect(s[1].started).toBe(T("2026-11-21T01:00:47Z"));
    expect(s[1].ended).toBe(T("2026-11-21T01:10:44Z"));
  });
  it("makes a Parked seed from a parked record's refused run", () => {
    const recs = [{
      ticket: "TARS-2", session: "dev-1", outcome: "parked", started: "2026-11-21T02:00:00Z", ended: "2026-11-21T02:03:00Z", phases: [],
      detail: "dev parked: sandbox refused network cognito-idp",
      parked: { role: "dev", failure_category: "sandbox_denied", denied: [], cost_usd: 0.4, run_dir: ".pipeline/v2/w/dev-1/TARS-2/dev-20261121T020000Z" },
    }];
    expect(seedsFromRecords("w", recs)).toEqual([expect.objectContaining({
      phase: "dev", outcome: "parked", cost: 0.4, detail: "dev parked: sandbox refused network cognito-idp", phaseReached: null, failureCategory: "sandbox_denied",
    })]);
  });
  it("makes nothing for phase-less records and skips malformed entries", () => {
    const recs = [
      { ticket: "MC-2", session: "dev-1", outcome: "skipped-blocked", started: "x", ended: "x", phases: [] },
      { ticket: "MC-2", session: "reconcile", outcome: "handoff-dropped", started: "x", ended: "x", phases: [] },
      { ticket: "MC-2", session: "dev-1", outcome: "error", phases: [{ role: "dev" }, phase({ run_dir: 7 }), phase({ ended: "nope" }), phase({ outcome: "weird" })] },
      { ticket: "bad key", phases: [phase({})] },
      null,
      "str",
    ];
    expect(seedsFromRecords("cat", recs)).toEqual([]);
  });
});

describe("endedStep", () => {
  const p = (phase: string, event = "note") => ({ ts: 0, phase, event, detail: "" });
  it("is the result line's phase", () => {
    expect(endedStep(DEV, [p("intake"), p("red"), p("intake", "result")], null)).toBe("intake");
  });
  it("else the furthest step logged (a late note on an earlier step doesn't move it back)", () => {
    expect(endedStep(RESEARCH, [p("triage"), p("synthesize", "phase_end"), p("scope")], "plan")).toBe("synthesize");
  });
  it("with no log, phase_reached when it names a step, else null", () => {
    expect(endedStep(DEV, null, "red")).toBe("red");
    expect(endedStep(RESEARCH, null, "plan")).toBeNull();
    expect(endedStep(RESEARCH, [], null)).toBeNull();
  });
});

describe("stepStates", () => {
  it("landed: every step done", () => {
    expect(stepStates(DEV, "pr", "landed").map((s) => s.k)).toEqual(["done", "done", "done", "done", "done", "done"]);
  });
  it("landed with a step skipped (MC-1435's dev run had no plan or verify line): still all done", () => {
    expect(stepStates(DEV, "pr", "landed").every((s) => s.k === "done")).toBe(true);
  });
  it("bounced at ground: done before, the end step marked, the rest not reached", () => {
    expect(stepStates(RESEARCH, "ground", "bounced")).toEqual([
      { name: "triage", k: "done" }, { name: "interpret", k: "done" }, { name: "ground", k: "cur", end: "bounced" },
      { name: "attack", k: "skip" }, { name: "scope", k: "skip" }, { name: "blocked-check", k: "skip" }, { name: "synthesize", k: "skip" }, { name: "verify", k: "skip" },
    ]);
  });
  it("running / quiet: done, current, still to come", () => {
    expect(stepStates(DEV, "red", "running").map((s) => s.k)).toEqual(["done", "done", "cur", "todo", "todo", "todo"]);
    expect(stepStates(DEV, "red", "quiet")[2]).toEqual({ name: "red", k: "cur", quiet: true });
  });
  it("unknown end step: a finished run shows nothing reached, a live one nothing started", () => {
    expect(stepStates(DEV, null, "error").every((s) => s.k === "skip")).toBe(true);
    expect(stepStates(DEV, null, "running").every((s) => s.k === "todo")).toBe(true);
  });
});

describe("buildFinishedRun", () => {
  const seed = seedsFromRecords("cat", [{ ticket: "MC-1", session: "dev-1", outcome: "bounced", started: "x", ended: "x",
    phases: [phase({ role: "research", outcome: "bounced", phase_reached: "plan", detail: "bounced (too_large) — two deliverables", run_dir: ".pipeline/v2/cat/dev-1/MC-1/research-20261121T002720Z", pr: "javascript:alert(1)" })] }])[0];
  const lines = parseProgress([
    line("2026-11-21T00:27:40Z", "triage", "phase_start", "start"),
    line("2026-11-21T00:28:00Z", "ground", "note", "recon"),
    line("2026-11-21T00:28:40Z", "ground", "result", "bounced (too_large) — two deliverables"),
  ].join("\n"));

  it("says where it ended, from the log", () => {
    const r = buildFinishedRun(seed, lines, RESEARCH);
    expect(r).toMatchObject({ id: seed.runDir, status: "bounced", live: false, at: "ground", lines: 3, logGone: false, note: "bounced (too_large) — two deliverables" });
    expect(r.track.find((s) => s.name === "ground")).toEqual({ name: "ground", k: "cur", end: "bounced" });
    expect(r.last).toBe(T("2026-11-21T00:28:40Z"));
  });
  it("never links a PR that isn't a github.com https URL", () => {
    expect(buildFinishedRun(seed, lines, RESEARCH).pr).toBeNull();
    expect(githubUrl("https://github.com/o/r/pull/3")).toBe("https://github.com/o/r/pull/3");
    expect(githubUrl("https://github.com.evil.io/x")).toBeNull();
    expect(githubUrl(null)).toBeNull();
  });
  it("marks the log gone when the run dir is gone", () => {
    const r = buildFinishedRun(seed, null, RESEARCH);
    expect(r).toMatchObject({ logGone: true, lines: 0, at: null });
  });
});

describe("buildLiveRun", () => {
  const flight = { ticket: "TARS-9", role: "dev" as const, runDir: ".pipeline/v2/w/dev-1/TARS-9/dev-20261121T050000Z", since: "2026-11-21T05:00:00.000Z" };
  const lines = parseProgress([line("2026-11-21T05:00:30Z", "intake", "phase_start", "intake"), line("2026-11-21T05:02:00Z", "red", "note", "wrote 3 failing tests")].join("\n"));

  it("is running on the furthest step, with its latest message", () => {
    const r = buildLiveRun("w", "dev-1", flight, lines, DEV, T("2026-11-21T05:03:00Z"));
    expect(r).toMatchObject({ status: "running", live: true, at: "red", note: "wrote 3 failing tests", cost: null, started: T("2026-11-21T05:00:00.000Z"), ended: null, lines: 2 });
  });
  it("is quiet after 5 minutes with no progress line", () => {
    expect(QUIET_MS).toBe(5 * 60_000);
    const at = (iso: string) => buildLiveRun("w", "dev-1", flight, lines, DEV, T(iso)).status;
    expect(at("2026-11-21T05:06:59Z")).toBe("running");
    expect(at("2026-11-21T05:07:01Z")).toBe("quiet");
  });
  it("with no progress yet: no step, quiet counted from since", () => {
    const r = buildLiveRun("w", "dev-1", flight, null, DEV, T("2026-11-21T05:01:00Z"));
    expect(r).toMatchObject({ status: "running", at: null, lines: 0, logGone: false });
    expect(r.note).toMatch(/no progress line yet/);
    expect(buildLiveRun("w", "dev-1", flight, [], DEV, T("2026-11-21T05:06:00Z")).status).toBe("quiet");
  });
});

describe("groupLog", () => {
  it("groups consecutive lines by step, each group ending where the next starts", () => {
    const lines = parseProgress([
      line("2026-11-21T01:00:00Z", "intake", "phase_start", "a"),
      line("2026-11-21T01:01:00Z", "intake", "note", "b"),
      line("2026-11-21T01:04:00Z", "red", "note", "c"),
      line("2026-11-21T01:05:00Z", "pr", "result", "RESULT: landed"),
    ].join("\n"));
    const g = groupLog(lines, T("2026-11-21T01:09:00Z"));
    expect(g.map((x) => [x.step, x.lines.length, (x.end - x.start) / 60_000])).toEqual([["intake", 2, 4], ["red", 1, 1], ["pr", 1, 4]]);
  });
  it("is empty for no lines", () => {
    expect(groupLog([], 0)).toEqual([]);
  });
});

describe("activityFrom", () => {
  it("lists every line newer than the cutoff, newest first, tagged with its run", () => {
    const lines = parseProgress([line("2026-11-21T01:00:00Z", "intake", "note", "old"), line("2026-11-21T03:00:00Z", "red", "note", "new")].join("\n"));
    const a = activityFrom([{ id: "r1", lines }], T("2026-11-21T02:00:00Z"));
    expect(a).toEqual([{ run: "r1", ts: T("2026-11-21T03:00:00Z"), phase: "red", event: "note", detail: "new" }]);
  });
  it("caps the list", () => {
    const lines = parseProgress(Array.from({ length: 30 }, (_, i) => line(`2026-11-21T03:00:${String(i).padStart(2, "0")}Z`, "red", "note", String(i))).join("\n"));
    expect(activityFrom([{ id: "r", lines }], 0, 10)).toHaveLength(10);
  });
});
