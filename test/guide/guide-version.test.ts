// The guide page carries its own version (DATA.guideVersion) and a changelog
// (docs/guide/guide-changes.js, shown on docs/guide/changelog.html). These
// checks keep the two from drifting: every guide change bumps the version and
// adds an entry, in the same change (CLAUDE.md, "The guide page").

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";

const GUIDE = resolve(import.meta.dirname, "../../docs/guide");
const read = (f: string): string => readFileSync(join(GUIDE, f), "utf8");

type Change = { version: string; date: string; title: string; items: { text: string; links?: { label: string; href: string }[] }[] };

function loadChanges(src: string = read("guide-changes.js")): Change[] {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  runInNewContext(src, sandbox);
  return sandbox.window.GUIDE_CHANGES as Change[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (v: string): number[] => (SEMVER.exec(v) ?? []).slice(1).map(Number);
const cmp = (a: string, b: string): number => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

describe("guide version and changelog", () => {
  const html = read("how-dev-loop-works.html");
  const changes = loadChanges();

  it("has at least one entry, newest first", () => {
    expect(Array.isArray(changes)).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
  });

  it("every entry has a semver version, an ISO date, a title and items", () => {
    for (const c of changes) {
      expect(c.version).toMatch(SEMVER);
      expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.items.length).toBeGreaterThan(0);
      for (const it of c.items) expect(it.text.length).toBeGreaterThan(0);
    }
  });

  it("versions strictly decrease down the list, and dates never go up", () => {
    for (let i = 1; i < changes.length; i++) {
      expect(cmp(changes[i - 1].version, changes[i].version), `${changes[i - 1].version} after ${changes[i].version}`).toBeGreaterThan(0);
      expect(changes[i - 1].date >= changes[i].date).toBe(true);
    }
  });

  it("DATA.guideVersion equals the newest entry", () => {
    const m = /guideVersion:\s*"([^"]+)"/.exec(html);
    expect(m, "DATA.guideVersion missing").not.toBeNull();
    expect(m![1]).toBe(changes[0].version);
  });

  it("DATA.updated is the newest entry's date", () => {
    const m = /\bupdated:\s*"([^"]+)"/.exec(html);
    expect(m![1]).toBe(changes[0].date);
  });

  it("DATA.loopVersion is a real dev-loop version, never newer than package.json", () => {
    // "Checked against" may lag a release honestly; it never claims a version that doesn't exist yet.
    const pkg = JSON.parse(readFileSync(resolve(GUIDE, "../../package.json"), "utf8")) as { version: string };
    const m = /loopVersion:\s*"([^"]+)"/.exec(html);
    expect(m, "DATA.loopVersion missing").not.toBeNull();
    expect(m![1]).toMatch(SEMVER);
    expect(cmp(m![1], pkg.version)).toBeLessThanOrEqual(0);
  });

  it("no entry links CHANGELOG#unreleased (that anchor moves at the next release)", () => {
    for (const c of changes) for (const it of c.items) for (const l of it.links ?? []) expect(l.href, l.label).not.toMatch(/#unreleased$/i);
  });

  it("both pages load guide-changes.js and link to each other", () => {
    const log = read("changelog.html");
    for (const page of [html, log]) expect(page).toContain('<script src="guide-changes.js"></script>');
    expect(html).toContain('href="changelog.html"');
    expect(log).toContain('href="how-dev-loop-works.html"');
  });

  it("every link in an entry is absolute https or a page in docs/guide", () => {
    for (const c of changes) for (const it of c.items) for (const l of it.links ?? []) {
      expect(l.href, l.label).toMatch(/^(https:\/\/|changelog\.html#|how-dev-loop-works\.html)/);
    }
  });
});

// The drift that matters most: the page changed but the version didn't. Compared
// against main, so it runs on every branch; skipped on main itself or when main
// isn't there (a shallow clone).
const REPO = resolve(GUIDE, "../..");
const git = (...args: string[]) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
/** The branch a change is compared against; GUIDE_BASE_REF overrides it (used to prove this check fails). */
const BASE_REF = process.env.GUIDE_BASE_REF ?? "main";
const base = git("merge-base", "HEAD", BASE_REF);
const onBranch = base.status === 0 && git("rev-parse", "HEAD").stdout.trim() !== git("rev-parse", BASE_REF).stdout.trim();

describe.skipIf(!onBranch)("guide version bump vs main", () => {
  const baseSha = base.stdout.trim();
  const changed = (path: string): boolean => {
    // Committed changes since main, plus anything staged or unstaged.
    const a = git("diff", "--quiet", baseSha, "--", path);
    return a.status === 1;
  };
  const atBase = (path: string): string | undefined => {
    const r = git("show", `${baseSha}:${path}`);
    return r.status === 0 ? r.stdout : undefined;
  };

  it("a branch that changes docs/guide bumps the version and adds an entry", () => {
    if (!changed("docs/guide")) return;
    const now = loadChanges();
    const oldHtml = atBase("docs/guide/how-dev-loop-works.html") ?? "";
    const oldVersion = /guideVersion:\s*"([^"]+)"/.exec(oldHtml)?.[1];
    const oldChanges = atBase("docs/guide/guide-changes.js");
    if (oldVersion) expect(cmp(now[0].version, oldVersion), `guide changed since main but is still v${oldVersion}: bump DATA.guideVersion`).toBeGreaterThan(0);
    if (oldChanges) {
      const prev = loadChanges(oldChanges);
      expect(cmp(now[0].version, prev[0].version), "add a new entry at the top of guide-changes.js").toBeGreaterThan(0);
    }
  });
});
