import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FALLBACK_STEPS } from "../../src/dashboard/model.ts";
import { jiraBaseFrom, liveDirs, loadProjects, readRunLog, readSnapshot, readStepLists, safeRunDir } from "../../src/dashboard/read.ts";

let root: string;
const NOW = Date.parse("2026-11-21T05:03:00Z");
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

async function put(rel: string, body: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), body);
}
const cfg = (repo: string) => JSON.stringify({ targetRepo: { url: `git@github.com:org/${repo}.git` }, github: { repo: `org/${repo}` } });
const jl = (...xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
const prog = (ts: string, phase: string, event: string, detail: string) => ({ ts, phase, event, detail });
const entry = (o: Record<string, unknown>) => ({
  role: "dev", skill: "ticket-to-pr", started: "2026-11-21T01:00:00Z", ended: "2026-11-21T01:10:00Z", outcome: "landed",
  phase_reached: "pr", cost_usd: 1, failure_category: null, detail: "PR opened", pr: null, ...o,
});
const rec = (ticket: string, phases: unknown[], o: Record<string, unknown> = {}) =>
  ({ ticket, session: "dev-1", started: "2026-11-21T01:00:00Z", ended: "2026-11-21T01:10:00Z", outcome: "landed", phases, ...o });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dash-read-"));
  await put("pipeline.web.config.json", cfg("web"));
  await put("pipeline.eval.config.json", cfg("dev-loop-eval-sandbox"));
  await put("pipeline.loop.config.json", "{}");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadProjects", () => {
  it("lists every project config except loop, with its slug and GitHub repo", async () => {
    const { projects } = await loadProjects(root);
    expect(projects).toEqual([
      { name: "eval", slug: "dev-loop-eval-sandbox", repo: "org/dev-loop-eval-sandbox" },
      { name: "web", slug: "web", repo: "org/web" },
    ]);
  });
  it("--project picks one by config name", async () => {
    expect((await loadProjects(root, "eval")).projects.map((p) => p.slug)).toEqual(["dev-loop-eval-sandbox"]);
  });
  it("an unknown --project throws, naming the ones available", async () => {
    await expect(loadProjects(root, "nope")).rejects.toThrow(/eval, web/);
  });
  it("an unreadable config is a warning, not a crash", async () => {
    await put("pipeline.broken.config.json", "{");
    const r = await loadProjects(root);
    expect(r.projects.map((p) => p.name)).toEqual(["eval", "web"]);
    expect(r.warnings.join("\n")).toMatch(/pipeline\.broken\.config\.json/);
  });
});

describe("readStepLists", () => {
  it("reads each skill's declared steps, falling back when a SKILL.md is missing", async () => {
    await put(".claude/skills/ticket-to-pr/SKILL.md", '{"ts": "x", "phase": "intake|red|pr", "event": "note"}');
    expect(await readStepLists(root)).toEqual({ dev: ["intake", "red", "pr"], research: FALLBACK_STEPS.research });
  });
});

describe("jiraBaseFrom", () => {
  it("takes an https JIRA_BASE_URL without its trailing slash; anything else is null", () => {
    expect(jiraBaseFrom("https://acme.atlassian.net/")).toBe("https://acme.atlassian.net");
    expect(jiraBaseFrom(undefined)).toBeNull();
    expect(jiraBaseFrom("javascript:alert(1)")).toBeNull();
    expect(jiraBaseFrom("http://acme.atlassian.net")).toBeNull();
  });
});

describe("safeRunDir", () => {
  it("resolves a v2 run dir under the root, refuses anything else", () => {
    expect(safeRunDir(root, ".pipeline/v2/web/dev-1/TARS-1/dev-20261121T010000Z")).toBe(join(root, ".pipeline/v2/web/dev-1/TARS-1/dev-20261121T010000Z"));
    expect(safeRunDir(root, "../.pipeline/v2/web/dev-1/TARS-1/dev-20261121T010000Z")).toBeNull();
    expect(safeRunDir(root, `${root}/.pipeline/v2/web/dev-1/TARS-1/dev-20261121T010000Z`)).toBeNull();
  });
});

describe("readSnapshot", () => {
  const RD = ".pipeline/v2/web/dev-1/TARS-1/dev-20261121T010000Z";
  const LIVE = ".pipeline/v2/web/dev-1/TARS-2/research-20261121T050000Z";

  async function setup(): Promise<void> {
    await put("runs/v2/web.jsonl", jl(
      rec("TARS-1", [entry({ run_dir: RD })]),
      rec("TARS-3", [], { outcome: "skipped-blocked" }),
    ) + '{"ticket":"TARS-9","phases":[');
    await put("runs/v2/web.reset-archive.jsonl", jl(rec("TARS-7", [entry({ run_dir: ".pipeline/v2/web/dev-1/TARS-7/dev-20261121T010000Z" })])));
    await put(`${RD}/progress.jsonl`, jl(prog("2026-11-21T01:00:10Z", "intake", "phase_start", "intake"), prog("2026-11-21T01:09:00Z", "pr", "result", "RESULT: landed")));
    await put(`${LIVE}/progress.jsonl`, jl(prog("2026-11-21T05:01:00Z", "triage", "phase_start", "start"), prog("2026-11-21T05:02:00Z", "ground", "note", "recon-agent")));
    await put(".pipeline/v2/web/sessions/dev-1.lock", JSON.stringify({ pid: 111, started: 9, inFlight: { ticket: "TARS-2", role: "research", runDir: LIVE, since: "2026-11-21T05:00:00Z" } }));
    await put(".pipeline/v2/web/sessions/dev-1.lock.stale-20261117T033810Z-1-ab", JSON.stringify({ pid: 111, started: 9, inFlight: { ticket: "TARS-5", role: "dev", runDir: RD, since: "x" } }));
    await put(".pipeline/v2/web/sessions/dev-1.lock.adopted-20261117T033810Z-1-ab", "{}");
  }
  const snap = async (pids = [111], only?: string) => {
    const { projects } = await loadProjects(root, only);
    return readSnapshot({ root, projects, steps: FALLBACK_STEPS, now: NOW, isAlive: alive(pids), jiraBase: null });
  };

  it("reads finished runs from the log and live runs from live locks; ignores archives, stale/adopted locks and phase-less records", async () => {
    await setup();
    const s = await snap();
    expect(s.runs.map((r) => [r.ticket, r.phase, r.status, r.at])).toEqual([
      ["TARS-2", "research", "running", "ground"],
      ["TARS-1", "dev", "landed", "pr"],
    ]);
    expect(s.runs[1]).toMatchObject({ lines: 2, logGone: false, cost: 1 });
    expect(s.workers).toEqual([{ project: "web", session: "dev-1", ticket: "TARS-2", phase: "research" }]);
    expect(s.warnings).toEqual([]);
    expect(s.projects.map((p) => p.slug)).toEqual(["dev-loop-eval-sandbox", "web"]);
  });

  it("a lock whose process is gone is a warning, never a running card", async () => {
    await setup();
    const s = await snap([]);
    expect(s.runs.some((r) => r.live)).toBe(false);
    expect(s.warnings.join("\n")).toMatch(/dev-1.*TARS-2 research.*process is gone/);
  });

  it("a corrupt lock is a warning", async () => {
    await setup();
    await put(".pipeline/v2/web/sessions/dev-2.lock", "{");
    expect((await snap()).warnings.join("\n")).toMatch(/dev-2\.lock.*can't be read/);
  });

  it("a live run that is also in the log shows once, as finished", async () => {
    await setup();
    await put(".pipeline/v2/web/sessions/dev-1.lock", JSON.stringify({ pid: 111, started: 9, inFlight: { ticket: "TARS-1", role: "dev", runDir: RD, since: "2026-11-21T01:00:00Z" } }));
    const s = await snap();
    expect(s.runs.filter((r) => r.id === RD).map((r) => r.status)).toEqual(["landed"]);
  });

  it("a record whose run dir is gone says so; one whose run_dir escapes is never read", async () => {
    await put("runs/v2/web.jsonl", jl(
      rec("TARS-4", [entry({ run_dir: ".pipeline/v2/web/dev-1/TARS-4/dev-20261121T010000Z", outcome: "bounced", phase_reached: "red" })]),
      rec("TARS-6", [entry({ run_dir: "../../secrets" })]),
    ));
    await put("secrets/progress.jsonl", jl(prog("2026-11-21T01:00:10Z", "pr", "result", "leak")));
    const s = await snap();
    expect(s.runs.find((r) => r.ticket === "TARS-4")).toMatchObject({ logGone: true, at: "red", status: "bounced" });
    expect(s.runs.find((r) => r.ticket === "TARS-6")).toMatchObject({ logGone: true, lines: 0 });
  });

  it("a project with no log and no sessions dir yet is empty, not an error", async () => {
    const s = await snap();
    expect(s.runs).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  it("--project limits it to that project", async () => {
    await setup();
    await put("runs/v2/dev-loop-eval-sandbox.jsonl", jl(rec("TARS-8", [entry({ run_dir: ".pipeline/v2/dev-loop-eval-sandbox/dev-1/TARS-8/dev-20261121T010000Z" })])));
    expect((await snap([111], "eval")).runs.map((r) => r.ticket)).toEqual(["TARS-8"]);
  });

  it("collects the activity lines of the last 24 hours, newest first", async () => {
    await setup();
    const s = await snap();
    expect(s.activity.map((a) => a.detail)).toEqual(["recon-agent", "start", "RESULT: landed", "intake"]);
  });

  it("never writes: the tree is byte-for-byte the same after a read", async () => {
    await setup();
    const list = async (d: string): Promise<string[]> => (await readdir(d, { recursive: true })).sort();
    const before = await list(root);
    const mtime = (await stat(join(root, "runs/v2/web.jsonl"))).mtimeMs;
    await snap();
    expect(await list(root)).toEqual(before);
    expect((await stat(join(root, "runs/v2/web.jsonl"))).mtimeMs).toBe(mtime);
  });
});

describe("readRunLog", () => {
  it("returns a run's lines grouped by step, only for a run in the snapshot", async () => {
    const RD = ".pipeline/v2/web/dev-1/TARS-1/dev-20261121T010000Z";
    await put("runs/v2/web.jsonl", jl(rec("TARS-1", [entry({ run_dir: RD })])));
    await put(`${RD}/progress.jsonl`, jl(prog("2026-11-21T01:00:10Z", "intake", "phase_start", "a"), prog("2026-11-21T01:02:00Z", "red", "note", "b")));
    const { projects } = await loadProjects(root);
    const s = await readSnapshot({ root, projects, steps: FALLBACK_STEPS, now: NOW, isAlive: () => false, jiraBase: null });
    const log = await readRunLog(s, root, RD, NOW);
    expect(log).toMatchObject({ id: RD, path: `${RD}/progress.jsonl`, gone: false });
    expect(log!.groups.map((g) => g.step)).toEqual(["intake", "red"]);
    expect(await readRunLog(s, root, "../../.env", NOW)).toBeNull();
    expect(await readRunLog(s, root, ".pipeline/v2/web/dev-1/TARS-2/dev-20261121T010000Z", NOW)).toBeNull();
  });
});

describe("liveDirs", () => {
  it("lists the absolute dirs of live runs", async () => {
    const LIVE = ".pipeline/v2/web/dev-1/TARS-2/research-20261121T050000Z";
    await put(".pipeline/v2/web/sessions/dev-1.lock", JSON.stringify({ pid: 111, started: 9, inFlight: { ticket: "TARS-2", role: "research", runDir: LIVE, since: "2026-11-21T05:00:00Z" } }));
    const { projects } = await loadProjects(root);
    const s = await readSnapshot({ root, projects, steps: FALLBACK_STEPS, now: NOW, isAlive: alive([111]), jiraBase: null });
    expect(liveDirs(s, root)).toEqual([join(root, LIVE)]);
  });
});
