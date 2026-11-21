// Text guard (eval fixtures): ticket-refine's "Fixture mode" section, the
// contract the fixture runner (src/eval/fixture-run.ts) relies on. When
// RUN_DIR/ticket.json exists the skill reads the ticket from it, writes its
// posts to RUN_DIR/outbox/, never calls Jira or gh, and grounds in the
// ground-dir= the loop pinned.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("ticket-refine: fixture mode", () => {
  const skill = read(".claude/skills/ticket-refine/SKILL.md");
  const start = skill.indexOf("## Fixture mode");
  const section = skill.slice(start, skill.indexOf("\n## ", start + 1));

  it("is its own section, right after ## Arguments", () => {
    expect(start).toBeGreaterThan(-1);
    const args = skill.indexOf("## Arguments");
    expect(args).toBeGreaterThan(-1);
    expect(skill.slice(args + 1).indexOf("\n## ") + args + 2).toBe(start);
  });

  it("is triggered by RUN_DIR/ticket.json and overrides every Jira and gh step", () => {
    expect(section).toContain("`RUN_DIR/ticket.json` exists");
    expect(section).toMatch(/never call any `mcp__atlassian/i);
    expect(section).toMatch(/never run `gh`/i);
  });

  it("maps every read to ticket.json", () => {
    for (const f of ["comments", "github", "linked", "prior_tickets", "is_pipeline"]) expect(section).toContain(f);
    expect(section).toMatch(/JQL and Confluence/);
  });

  it("writes every post to the outbox with an index line", () => {
    expect(section).toContain("RUN_DIR/outbox/NNN-<jira|github>-<comment|title>.md");
    expect(section).toContain("RUN_DIR/outbox/index.jsonl");
    expect(section).toContain('{"seq"');
    expect(section).toMatch(/checklist item 0/i);
  });

  it("grounds in ground-dir= with no fetch and no worktree add or remove", () => {
    expect(section).toContain("ground-dir=");
    expect(section).toMatch(/no `git fetch`/);
    expect(section).toMatch(/never `worktree add` or `worktree remove`/i);
  });

  it("is a no-op outside fixture mode: real runs are unchanged", () => {
    expect(section).toMatch(/no `RUN_DIR\/ticket\.json`.*every step below applies unchanged/is);
  });

  it("recon-agent is told about the fixture ticket and to make no Jira call", () => {
    const recon = read(".claude/agents/recon-agent.md");
    expect(recon).toContain("RUN_DIR/ticket.json");
    expect(recon).toMatch(/fixture mode/i);
  });
});
