import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSaveArgs, saveFixture, scrubTicket, type RawTicket, type SaveDeps } from "../../src/eval/fixture-save.ts";
import { validateTicket } from "../../src/eval/fixture.ts";

const raw = (over: Partial<RawTicket> = {}): RawTicket => ({
  key: "MC-1718",
  summary: "MC-1718: availability source picker",
  issueType: "Story",
  description: "See MC-1718 and MC-1435. Mail jane.doe@example.com. Files at /Users/jane/Desktop/x.json.",
  comments: [
    { id: "10", author: "Jane Doe", created: "2026-11-20T10:00:00Z", body: "✅ research-loop - refined MC-1718" },
    { id: "11", author: "Bob", created: "2026-11-20T11:00:00Z", body: "Accept as scoped. TOKEN=abcd1234abcd1234abcd" },
    { id: "12", author: "Jane Doe", created: "2026-11-20T12:00:00Z", body: "❌ research-loop - bounced" },
  ],
  attachments: [{ id: "1", filename: "a.json", size: 2, mimeType: "application/json" }],
  links: [{ key: "MC-1431", summary: "blocker MC-1431", description: "d", comments: [{ id: "20", author: "Bob", created: "t", body: "b" }] }],
  ...over,
});

describe("scrubTicket", () => {
  const t = scrubTicket(raw(), { fxNumber: 7, home: "/Users/jane" });

  it("gives a fake FX key everywhere the real key appears, and a valid ticket.json", () => {
    expect(t.key).toBe("FX-7");
    expect(t.summary).toBe("FX-7: availability source picker");
    expect(t.description).toContain("See FX-7 and");
    expect(JSON.stringify(t)).not.toContain("MC-1718");
    expect(validateTicket(t).ok).toBe(true);
  });
  it("authors become user-N in first-seen order, and links keep their own authors' numbers", () => {
    expect(t.comments.map((c) => c.author)).toEqual(["user-1", "user-2", "user-1"]);
    expect(t.linked["MC-1431"]!.comments[0]!.author).toBe("user-2");
    expect(JSON.stringify(t)).not.toMatch(/Jane|Bob/);
  });
  it("@-mentions of a known author become their user-N; any other @-mention becomes @user", () => {
    const m = scrubTicket(
      raw({ comments: [{ id: "1", author: "Jane Doe", created: "c", body: "hi" }, { id: "2", author: "Bob", created: "c", body: "@[Jane Doe] please check, cc @[Carol King]. Jane Doe agreed." }], description: "Ask @[Bob]." }),
      { fxNumber: 1, home: "/Users/jane" },
    );
    expect(m.comments[1]!.body).toBe("@user-1 please check, cc @user. user-1 agreed.");
    expect(m.description).toBe("Ask @user-2.");
    expect(JSON.stringify(m)).not.toMatch(/Jane|Bob|Carol/);
  });
  it("two attachments with the same name get distinct file names", () => {
    const m = scrubTicket(raw({ attachments: [{ id: "1", filename: "mock.png", size: 1, mimeType: "image/png" }, { id: "2", filename: "mock.png", size: 1, mimeType: "image/png" }] }), { fxNumber: 1, home: "" });
    const names = m.attachments.map((a) => a.filename);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe("mock.png");
  });
  it("marks the pipeline's own comments", () => {
    expect(t.comments.map((c) => c.is_pipeline)).toEqual([true, false, true]);
  });
  it("redacts emails, secrets and the home path", () => {
    const s = JSON.stringify(t);
    expect(s).not.toContain("jane.doe@example.com");
    expect(s).not.toContain("abcd1234abcd1234abcd");
    expect(s).not.toContain("/Users/jane");
  });
  it("starts unreviewed, with no GitHub mirror", () => {
    expect(t.reviewed).toBe(false);
    expect(t.github).toEqual({ title: "", comments: [], not_planned: [] });
  });
});

describe("parseSaveArgs", () => {
  it("takes a key, --name, and optional --fx and --replace", () => {
    expect(parseSaveArgs(["MC-1718", "--name=mc-1718"])).toEqual({ key: "MC-1718", name: "mc-1718", fx: 1, replace: false });
    expect(parseSaveArgs(["MC-1718", "--name=mc-1718", "--fx=3", "--replace"])).toMatchObject({ fx: 3, replace: true });
  });
  it("refuses a bad key, name or flag", () => {
    for (const bad of [["mc-1", "--name=a"], ["MC-1"], ["MC-1", "--name=../a"], ["MC-1", "--name=a", "--fx=0"], ["MC-1", "--name=a", "--write"]]) {
      expect(() => parseSaveArgs(bad)).toThrow();
    }
  });
});

describe("saveFixture", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fxsave-"));
  });
  afterEach(async () => rm(root, { recursive: true, replace: true }));

  const deps = (files: Record<string, string>, over: Partial<RawTicket> = {}): SaveDeps => ({
    fixturesDir: root,
    home: "/Users/jane",
    read: async () => raw(over),
    download: async (a) => {
      if (!(a.filename in files)) throw new Error("404");
      return Buffer.from(files[a.filename]!);
    },
    log: () => {},
  });

  it("writes ticket.json (reviewed false) and attachments/, and runs no git", async () => {
    const r = await saveFixture({ key: "MC-1718", name: "mc-1718", fx: 1, replace: false }, deps({ "a.json": '{"x":1}' }));
    expect(r.ok).toBe(true);
    const t = JSON.parse(await readFile(join(root, "mc-1718", "ticket.json"), "utf8"));
    expect(t).toMatchObject({ key: "FX-1", reviewed: false });
    expect(await readFile(join(root, "mc-1718", "attachments", "a.json"), "utf8")).toBe('{"x":1}');
  });

  it("refuses when a text attachment holds a secret, and writes nothing", async () => {
    const r = await saveFixture({ key: "MC-1718", name: "s", fx: 1, replace: false }, deps({ "a.json": 'API_KEY="sk_live_abcdefghijklmnop1234"' }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/a\.json.*secret/);
    expect(existsSync(join(root, "s"))).toBe(false);
  });

  it("scrubs the real key, emails and the home path out of text attachments", async () => {
    await saveFixture({ key: "MC-1718", name: "t", fx: 2, replace: false }, deps({ "a.json": '{"t":"MC-1718 by jane.doe@example.com in /Users/jane/x"}' }));
    const body = await readFile(join(root, "t", "attachments", "a.json"), "utf8");
    expect(body).toContain("FX-2");
    expect(body).not.toMatch(/MC-1718|jane\.doe@example\.com|\/Users\/jane/);
  });

  it("an attachment that fails to download is kept in ticket.json with no file (a failed entry at run time)", async () => {
    const r = await saveFixture({ key: "MC-1718", name: "f", fx: 1, replace: false }, deps({}));
    expect(r.ok).toBe(true);
    expect(await readdir(join(root, "f", "attachments"))).toEqual([]);
    expect(r.ok && r.missing).toEqual(["a.json"]);
  });

  it("refuses to overwrite an existing fixture's ticket.json without --replace, but keeps its other files", async () => {
    await mkdir(join(root, "e"));
    await writeFile(join(root, "e", "ticket.json"), "{}");
    await writeFile(join(root, "e", "repo.json"), "{}");
    expect((await saveFixture({ key: "MC-1718", name: "e", fx: 1, replace: false }, deps({ "a.json": "{}" }))).ok).toBe(false);
    expect((await saveFixture({ key: "MC-1718", name: "e", fx: 1, replace: true }, deps({ "a.json": "{}" }))).ok).toBe(true);
    expect(await readFile(join(root, "e", "repo.json"), "utf8")).toBe("{}");
  });

  it("a fixture folder with only repo.json/expect.json (no ticket yet) is filled without --replace", async () => {
    await mkdir(join(root, "p"));
    await writeFile(join(root, "p", "repo.json"), "{}");
    expect((await saveFixture({ key: "MC-1718", name: "p", fx: 1, replace: false }, deps({ "a.json": "{}" }))).ok).toBe(true);
  });
});
