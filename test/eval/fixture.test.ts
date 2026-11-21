import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture, validateRepoPin, validateTicket, type FixtureTicket } from "../../src/eval/fixture.ts";

const ticket = (over: Partial<FixtureTicket> = {}): FixtureTicket => ({
  key: "FX-1",
  summary: "Availability source picker",
  issue_type: "Story",
  description: "As a user ...",
  comments: [],
  github: { title: "FX-1: (refinement in progress)", comments: [], not_planned: [] },
  linked: {},
  prior_tickets: [],
  attachments: [],
  reviewed: true,
  ...over,
});

describe("validateTicket", () => {
  it("accepts a minimal ticket", () => {
    expect(validateTicket(ticket())).toEqual({ ok: true, value: ticket() });
  });
  it("defaults the optional lists", () => {
    const r = validateTicket({ key: "FX-2", summary: "s", issue_type: "Bug", description: "d", reviewed: false });
    expect(r.ok && r.value).toMatchObject({ comments: [], linked: {}, prior_tickets: [], attachments: [], github: { title: "", comments: [], not_planned: [] } });
  });
  it("requires a fake FX-<n> key, never a real one", () => {
    const r = validateTicket(ticket({ key: "MC-1435" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join()).toMatch(/FX-<n>/);
  });
  it("names every bad field", () => {
    const r = validateTicket({ key: "FX-1", summary: 3, description: null, comments: [{ id: 1 }], attachments: [{ filename: "../x" }], reviewed: "yes" });
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.errors.join("\n") : "";
    for (const f of ["summary", "issue_type", "description", "comments[0]", "attachments[0]", "reviewed"]) expect(msg).toContain(f);
  });
  it("an attachment filename must be a plain file name", () => {
    for (const filename of ["../x.json", "a/b.png", ".envrc", ""]) {
      expect(validateTicket(ticket({ attachments: [{ id: "1", filename, size: 1, mimeType: "x" }] })).ok).toBe(false);
    }
  });
  it("is_pipeline must be a boolean on each comment", () => {
    const c = { id: "1", author: "user-1", created: "2026-11-20T00:00:00Z", body: "hi" };
    expect(validateTicket(ticket({ comments: [{ ...c, is_pipeline: false }] })).ok).toBe(true);
    expect(validateTicket(ticket({ comments: [c as never] })).ok).toBe(false);
  });
  it("rejects a non-object", () => {
    expect(validateTicket(null).ok).toBe(false);
    expect(validateTicket([]).ok).toBe(false);
  });
});

describe("validateRepoPin", () => {
  const pin = { project: "catalog-ui-management", sha: "3be2731f", verified: true, verify_cmd: "git log -1" };
  it("accepts a verified short or full sha", () => {
    expect(validateRepoPin(pin).ok).toBe(true);
    expect(validateRepoPin({ ...pin, sha: "a".repeat(40) }).ok).toBe(true);
  });
  it("accepts an unverified or null pin as data (the runner refuses it)", () => {
    expect(validateRepoPin({ ...pin, verified: false }).ok).toBe(true);
    expect(validateRepoPin({ ...pin, sha: null, verified: false }).ok).toBe(true);
  });
  it("rejects a bad sha, a bad project, or verified with no sha", () => {
    for (const bad of [{ ...pin, sha: "HEAD" }, { ...pin, sha: "abc" }, { ...pin, sha: "z".repeat(8) }, { ...pin, project: "../x" }, { ...pin, sha: null, verified: true }]) {
      expect(validateRepoPin(bad).ok).toBe(false);
    }
  });
});

describe("loadFixture", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fixture-"));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  async function make(name: string, files: Record<string, unknown>): Promise<void> {
    await mkdir(join(root, name), { recursive: true });
    for (const [f, v] of Object.entries(files)) await writeFile(join(root, name, f), typeof v === "string" ? v : JSON.stringify(v));
  }
  const pin = { project: "catalog-ui-management", sha: "3be2731f", verified: true };

  it("loads a complete, reviewed, verified fixture", async () => {
    await make("ok", { "ticket.json": ticket(), "repo.json": pin, "expect.json": { outcomes: ["ready"] } });
    const r = await loadFixture(root, "ok");
    expect(r.ok).toBe(true);
    expect(r.ok && r.fixture).toMatchObject({ name: "ok", ticket: { key: "FX-1" }, repo: { sha: "3be2731f" }, expect: { outcomes: ["ready"] } });
  });
  it("refuses a missing ticket.json, naming the save command", async () => {
    await make("noticket", { "repo.json": pin, "expect.json": {} });
    const r = await loadFixture(root, "noticket");
    expect(!r.ok && r.problems.join()).toMatch(/ticket\.json.*fixture:save/);
  });
  it("refuses reviewed: false", async () => {
    await make("unrev", { "ticket.json": ticket({ reviewed: false }), "repo.json": pin, "expect.json": {} });
    expect(await loadFixture(root, "unrev")).toMatchObject({ ok: false, problems: [expect.stringMatching(/reviewed/)] });
  });
  it("refuses an unverified or null pin, printing its verify command", async () => {
    await make("unver", { "ticket.json": ticket(), "repo.json": { ...pin, verified: false, verify_cmd: "git -C x log -1 7521af60" }, "expect.json": {} });
    const r = await loadFixture(root, "unver");
    expect(!r.ok && r.problems.join()).toMatch(/UNVERIFIED.*git -C x log -1 7521af60/);
  });
  it("refuses an invalid expect.json, and a bad name before touching disk", async () => {
    await make("badexp", { "ticket.json": ticket(), "repo.json": pin, "expect.json": { outcomes: ["maybe"] } });
    expect((await loadFixture(root, "badexp")).ok).toBe(false);
    expect((await loadFixture(root, "../etc")).ok).toBe(false);
  });
  it("collects every problem, not just the first", async () => {
    await make("many", { "repo.json": { ...pin, verified: false }, "expect.json": "not json" });
    const r = await loadFixture(root, "many");
    expect(!r.ok && r.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the committed fixtures (evals/fixtures/)", () => {
  const ROOT = join(import.meta.dirname, "../../evals/fixtures");
  for (const name of ["mc-1435-xl", "mc-1718"]) {
    it(`${name}: repo.json and expect.json are valid, and the runner refuses it until its PENDING.md steps are done`, async () => {
      const { readFile } = await import("node:fs/promises");
      const { validateExpectation } = await import("../../src/eval/grade-fixture.ts");
      expect(validateRepoPin(JSON.parse(await readFile(join(ROOT, name, "repo.json"), "utf8"))).ok).toBe(true);
      expect(validateExpectation(JSON.parse(await readFile(join(ROOT, name, "expect.json"), "utf8"))).ok).toBe(true);
      const r = await loadFixture(ROOT, name);
      if (!r.ok) expect(r.problems.join("\n")).toMatch(/ticket\.json|UNVERIFIED|reviewed/);
    });
  }
});
