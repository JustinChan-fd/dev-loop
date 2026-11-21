import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureAttachments, fixtureMode, fixtureSpawn, parseFixtureArgs, pinnedGit, planLines, runFixture, LIVE_ENABLED, type FixtureRunDeps } from "../../src/eval/fixture-run.ts";
import type { Fixture } from "../../src/eval/fixture.ts";
import type { RunSkillFn } from "../../src/core/run-skill.ts";
import type { SpawnClaudeOpts, SpawnClaudeResult } from "../../src/core/spawn-claude.ts";
import { makeV2Config as makeConfig } from "../fixtures/config.ts";

describe("parseFixtureArgs", () => {
  it("defaults: 3 runs, $25 total", () => {
    expect(parseFixtureArgs(["--fixture=mc-1718"])).toEqual({ fixture: "mc-1718", runs: 3, maxTotalUsd: 25 });
  });
  it("--runs is 1..5 and --max-total is (0, 25]", () => {
    expect(parseFixtureArgs(["--fixture=a", "--runs=5", "--max-total=10"])).toEqual({ fixture: "a", runs: 5, maxTotalUsd: 10 });
    for (const bad of [["--fixture=a", "--runs=6"], ["--fixture=a", "--runs=0"], ["--fixture=a", "--runs=x"], ["--fixture=a", "--max-total=26"], ["--fixture=a", "--max-total=0"]]) {
      expect(() => parseFixtureArgs(bad)).toThrow();
    }
  });
  it("requires a valid --fixture and refuses unknown flags", () => {
    expect(() => parseFixtureArgs([])).toThrow(/--fixture/);
    expect(() => parseFixtureArgs(["--fixture=../x"])).toThrow(/fixture/);
    expect(() => parseFixtureArgs(["--fixture=a", "--live"])).toThrow(/--live/);
  });
});

describe("fixtureMode", () => {
  it("dry by default; live only for DRY_RUN=0; anything else refused", () => {
    expect(fixtureMode({})).toBe("dry");
    expect(fixtureMode({ DRY_RUN: "" })).toBe("dry");
    expect(fixtureMode({ DRY_RUN: "1" })).toBe("dry");
    expect(fixtureMode({ DRY_RUN: "0" })).toBe("live");
    expect(() => fixtureMode({ DRY_RUN: "true" })).toThrow(/DRY_RUN/);
  });
  it("live is refused inside a Claude Code session", () => {
    expect(() => fixtureMode({ DRY_RUN: "0", CLAUDECODE: "1" })).toThrow(/CLAUDECODE/);
    expect(fixtureMode({ CLAUDECODE: "1" })).toBe("dry");
  });
  it("live is not enabled yet (the guard hook and a first watched run come first)", () => {
    expect(LIVE_ENABLED).toBe(false);
  });
});

describe("pinnedGit", () => {
  it("rewrites show origin/<branch>:<file> to <sha>:<file>, and nothing else", async () => {
    const seen: string[][] = [];
    const g = pinnedGit(async (args) => (seen.push(args), "out"), "3be2731f");
    await g(["show", "origin/main:app/.nvmrc"], "/r");
    await g(["status"], "/r");
    expect(seen).toEqual([["show", "3be2731f:app/.nvmrc"], ["status"]]);
  });
});

describe("fixtureSpawn", () => {
  it("applies the guard and appends ground-dir= to the prompt", async () => {
    let got: SpawnClaudeOpts | undefined;
    const spawn = fixtureSpawn(async (o) => ((got = o), {} as SpawnClaudeResult), { groundDir: "/abs/repo/.claude/worktrees/FX-1-20261121T010203Z-ground", ghConfigDir: "/abs/run/.gh-empty" });
    await spawn({ prompt: "/ticket-refine FX-1 run-dir=/a/.pipeline/v2/x repo-dir=/abs/repo", allowedTools: "mcp__atlassian__getJiraIssue,Bash", env: { GH_TOKEN: "t" } } as unknown as SpawnClaudeOpts);
    expect(got!.prompt).toBe("/ticket-refine FX-1 run-dir=/a/.pipeline/v2/x repo-dir=/abs/repo ground-dir=/abs/repo/.claude/worktrees/FX-1-20261121T010203Z-ground");
    expect(got!.allowedTools).not.toMatch(/mcp__/);
    expect(got!.denyTools).toContain("Bash(gh:*)");
    expect(got!.env.GH_TOKEN).toBeUndefined();
    expect(got!.env.DEVLOOP_EVAL_KEYS).toBe("");
  });
  it("refuses an unsafe ground dir", () => {
    expect(() => fixtureSpawn(async () => ({}) as SpawnClaudeResult, { groundDir: "/abs/x y", ghConfigDir: "/abs/g" })).toThrow();
  });
});

describe("fixtureAttachments", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fxatt-"));
    await mkdir(join(dir, "attachments"));
    await writeFile(join(dir, "attachments", "a.json"), "{}");
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));
  it("lists the ticket's attachments and reads each from the fixture folder; a missing file rejects (a failed entry)", async () => {
    const d = fixtureAttachments(dir, [
      { id: "1", filename: "a.json", size: 2, mimeType: "application/json" },
      { id: "2", filename: "gone.png", size: 9, mimeType: "image/png" },
    ]);
    expect((await d.list("FX-1")).map((a) => a.filename)).toEqual(["a.json", "gone.png"]);
    expect((await d.download({ id: "1", filename: "a.json", size: 2, mimeType: "" })).toString()).toBe("{}");
    await expect(d.download({ id: "2", filename: "gone.png", size: 9, mimeType: "" })).rejects.toThrow(/gone\.png/);
  });
});

// ---------------------------------------------------------------------------

const fixture = (dir: string, over: Partial<Fixture["expect"]> = {}): Fixture => ({
  name: "fx-test",
  dir,
  ticket: {
    key: "FX-1", summary: "s", issue_type: "Story", description: "d", comments: [], github: { title: "", comments: [], not_planned: [] },
    linked: {}, prior_tickets: [], attachments: [], reviewed: true,
  },
  repo: { project: "webtarsthree", sha: "3be2731f", verified: true },
  expect: { outcomes: ["ready"], ...over },
});

const READY = { outcome: "ready", phase_reached: "verify", failure_category: null, detail: "ready", size_estimate: "M", ac_count: 4 };
const GROUNDED = '{"phase":"ground","event":"phase_end"}\n';

describe("runFixture", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fxrun-"));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  function deps(o: { verdict?: unknown; cost?: number; throwOn?: number; runs?: number; maxTotalUsd?: number; exp?: Partial<Fixture["expect"]> } = {}) {
    const removed: string[] = [];
    const runDirs: string[] = [];
    let t = Date.parse("2026-11-21T01:02:03Z");
    let n = 0;
    const logs: string[] = [];
    const d: FixtureRunDeps = {
      fixture: fixture(join(root, "fixture"), o.exp),
      config: makeConfig(),
      runs: o.runs ?? 2,
      maxTotalUsd: o.maxTotalUsd ?? 25,
      maxBudgetUsd: 5,
      now: () => new Date((t += 60_000)),
      resolve: (rel) => join(root, rel),
      logPath: join(root, "runs/v2/fixtures/fx-test.jsonl"),
      pin: async (runId) => ({ dir: `/abs/repo/.claude/worktrees/FX-1-${runId}-ground`, sha: "3be2731f" + "0".repeat(32), remove: async () => void removed.push(runId) }),
      makeRunSkill: (): RunSkillFn => async ({ runDir }) => {
        n += 1;
        const abs = join(root, runDir);
        runDirs.push(abs);
        if (o.throwOn === n) throw new Error("spawn exploded");
        await mkdir(join(abs, "outbox"), { recursive: true });
        await writeFile(join(abs, "verdict.json"), JSON.stringify(o.verdict ?? READY));
        await writeFile(join(abs, "progress.jsonl"), GROUNDED);
        await writeFile(join(abs, "outbox", "001-github-comment.md"), "## ✅ research-loop - spec");
        return { verdictRaw: JSON.stringify(o.verdict ?? READY), started: "s", ended: "e", costUsd: o.cost ?? 1.5, tokens: { in: 1, out: 1 }, skillVersion: "abc", model: "sonnet" };
      },
      log: (m) => void logs.push(m),
    };
    return { d, removed, runDirs, logs };
  }

  it("runs N times in sequence, grades each, logs each to the fixture's own log, and removes every pin", async () => {
    const { d, removed, runDirs } = deps();
    const r = await runFixture(d);
    expect(r).toMatchObject({ pass: true, passRate: 1, runs: 2 });
    expect(removed).toHaveLength(2);
    expect(runDirs[0]).toMatch(/\.pipeline\/v2\/fixtures\/fx-test\/FX-1\/research-\d{8}T\d{6}Z$/);
    expect(runDirs[0]).not.toBe(runDirs[1]);
    const lines = (await readFile(d.logPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ fixture: "fx-test", ticket: "FX-1", outcome: "landed", pass: true, cost_usd: 1.5, sha: "3be2731f" + "0".repeat(32) });
  });

  it("writes ticket.json and repo-head.json into each run dir before the spawn", async () => {
    const { d, runDirs } = deps({ runs: 1 });
    await runFixture(d);
    expect(JSON.parse(await readFile(join(runDirs[0]!, "ticket.json"), "utf8"))).toMatchObject({ key: "FX-1" });
    expect(JSON.parse(await readFile(join(runDirs[0]!, "repo-head.json"), "utf8"))).toEqual({ project: "webtarsthree", sha: "3be2731f" + "0".repeat(32) });
  });

  it("a bounce goes to the outbox through the loop, never to Jira", async () => {
    const { d, runDirs } = deps({ runs: 1, verdict: { outcome: "bounced", phase_reached: "plan", failure_category: "spec_ambiguous", detail: "q" }, exp: { outcomes: ["bounced"] } });
    const r = await runFixture(d);
    expect(r.pass).toBe(true);
    expect(existsSync(join(runDirs[0]!, "outbox", "loop-001-transition.json"))).toBe(true);
  });

  it("grades what the loop's check did: an ungrounded too_large is refused and fails", async () => {
    const { d } = deps({ runs: 1, verdict: { outcome: "bounced", phase_reached: "plan", failure_category: "too_large", detail: "big" }, exp: { outcomes: ["ready", "bounced"], loopAction: ["accept"] } });
    // The fake writes a grounded progress.jsonl; a too_large with no size_evidence is still refused.
    const r = await runFixture(d);
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toMatch(/loop action refuse/);
  });

  it("a run that throws still removes its pin, counts as a failed run, and the series goes on", async () => {
    const { d, removed } = deps({ throwOn: 1 });
    const r = await runFixture(d);
    expect(removed).toHaveLength(2);
    expect(r).toMatchObject({ runs: 2, passRate: 0.5, pass: false });
  });

  it("stops once the spent cost reaches --max-total", async () => {
    const { d, removed } = deps({ runs: 5, cost: 4, maxTotalUsd: 8 });
    const r = await runFixture(d);
    expect(r.runs).toBe(2);
    expect(removed).toHaveLength(2);
    expect(r.stoppedAt).toMatch(/max-total/);
  });

  it("caps each spawn's budget at what is left of --max-total", async () => {
    const budgets: number[] = [];
    const { d } = deps({ runs: 2, cost: 4, maxTotalUsd: 7 });
    const inner = d.makeRunSkill;
    d.makeRunSkill = (c) => async (a) => (budgets.push(a.maxBudgetUsd), inner(c)(a));
    await runFixture(d);
    expect(budgets).toEqual([5, 3]);
  });
});

describe("planLines (the dry run)", () => {
  it("names the fixture, pin, runs, budget, run dir, tools and env, and says nothing runs", () => {
    const text = planLines(fixture("/abs/fx"), { fixture: "fx-test", runs: 3, maxTotalUsd: 25 }, "/abs/repo").join("\n");
    for (const s of ["fx-test", "FX-1", "webtarsthree", "3be2731f", "3 run(s)", "$5", "$25", ".pipeline/v2/fixtures/fx-test/FX-1/research-", "Bash,Read,Grep,Glob", "Bash(gh:*)", "GH_TOKEN", "DEVLOOP_EVAL_KEYS", "nothing runs"]) {
      expect(text).toContain(s);
    }
  });
});
