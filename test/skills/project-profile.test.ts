// Text guard: the skills take the app folder, Node major and dev server from
// <RUN_DIR>/project.json (written by the loop, src/core/project-profile.ts),
// never from reading the repo; and they follow the target repo's own rules.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const T2P = read(".claude/skills/ticket-to-pr/SKILL.md");
const QA = read(".claude/agents/qa-agent.md");
const RECON = read(".claude/agents/recon-agent.md");
const REFINE = read(".claude/skills/ticket-refine/SKILL.md");

describe("ticket-to-pr reads the project profile", () => {
  it("names project.json and installs in the app folder", () => {
    expect(T2P).toContain("<RUN_DIR>/project.json");
    expect(T2P).toContain("direnv exec <worktree>/<appDir> npm ci");
    expect(T2P).not.toContain("direnv exec <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID> npm ci");
  });

  it("checks the Node major after install (env_setup bounce)", () => {
    const i = T2P.indexOf("### The project profile");
    expect(i).toBeGreaterThan(0);
    const sec = T2P.slice(i, i + 2500);
    expect(sec).toContain("nodeMajor");
    expect(sec).toMatch(/node --version/);
    expect(sec).toContain('failure_category: "env_setup"');
  });

  it("never creates .env.local; follows the target repo's own CLAUDE.md/AGENTS.md", () => {
    expect(T2P).toMatch(/never (create|write)[^.]*\.env\.local/i);
    expect(T2P).toMatch(/(CLAUDE|AGENTS)\.md[^.]*(read|follow)/i);
  });

  it("a hook failure is a bounce, never --no-verify", () => {
    expect(T2P).toMatch(/hook[^.]*fail[^.]*bounce/i);
    expect(T2P).toContain("Never use `--no-verify`");
  });

  it("names no project in its description; the default branch comes from config", () => {
    const desc = /^description: (.*)$/m.exec(T2P)?.[1] ?? "";
    expect(desc).not.toMatch(/webtarsthree|catalog-ui/);
    expect(T2P).not.toContain("message on `master`");
  });
});

describe("qa-agent and recon-agent take the dev server from the profile", () => {
  it.each([
    ["qa-agent", QA],
    ["recon-agent", RECON],
    ["ticket-refine", REFINE],
  ])("%s names project.json, devCommand and devUrl", (_n, text) => {
    expect(text).toContain("project.json");
    expect(text).toContain("devCommand");
    expect(text).toContain("devUrl");
  });

  it("qa-agent no longer starts a bare `npm run dev` in the worktree root", () => {
    expect(QA).not.toContain("`npm run dev` in the worktree");
  });

  it("qa-agent still marks login-gated checks as needing a human", () => {
    expect(QA).toContain("unverified (needs human)");
  });

  it("no project name outside an e.g. example", () => {
    for (const text of [T2P, QA, RECON, REFINE]) {
      const lines = text.split("\n").filter((l) => /catalog-ui|webtarsthree/.test(l));
      for (const l of lines) expect(l).toMatch(/e\.g\.|for example|https:\/\/github\.com\/fandango\/webtarsthree\/pull\/123/);
    }
  });
});
