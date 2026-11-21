import { describe, expect, it } from "vitest";
import { FIXTURE_ALLOWED_TOOLS, FIXTURE_DENY, fixtureSpawnGuard } from "../../src/eval/guard.ts";
import { settingsJson } from "../../src/core/spawn-claude.ts";

describe("fixture leak guard", () => {
  const base = {
    allowedTools: "mcp__atlassian__getJiraIssue,mcp__atlassian__addCommentToJiraIssue,Bash,Read,Grep,Glob",
    env: { PATH: "/bin", GH_TOKEN: "x", GITHUB_TOKEN: "y", DEVLOOP_EVAL_KEYS: "TARS-1", KEEP: "1" } as NodeJS.ProcessEnv,
  };

  it("allows the built-in tools only: no mcp__ tool at all", () => {
    const g = fixtureSpawnGuard(base, "/abs/run/.gh-empty");
    expect(g.allowedTools).toBe(FIXTURE_ALLOWED_TOOLS);
    expect(g.allowedTools).not.toMatch(/mcp__/);
    expect(g.allowedTools.split(",")).toEqual(["Bash", "Read", "Grep", "Glob"]);
  });

  it("denies Atlassian, gh, curl and the web, and every rule passes settingsJson's check", () => {
    const g = fixtureSpawnGuard(base, "/abs/run/.gh-empty");
    expect(g.denyTools).toEqual(FIXTURE_DENY);
    for (const t of ["mcp__atlassian", "mcp__claude_ai_Atlassian", "Bash(gh:*)", "Bash(curl:*)", "WebFetch", "WebSearch"]) expect(g.denyTools).toContain(t);
    expect(() => settingsJson({ denyTools: g.denyTools })).not.toThrow();
  });

  it("strips GitHub auth, empties DEVLOOP_EVAL_KEYS (every Atlassian write denied by the hook), and points gh at an empty config", () => {
    const g = fixtureSpawnGuard(base, "/abs/run/.gh-empty");
    expect(g.env.GH_TOKEN).toBeUndefined();
    expect(g.env.GITHUB_TOKEN).toBeUndefined();
    expect("GH_TOKEN" in g.env).toBe(false);
    expect(g.env.DEVLOOP_EVAL_KEYS).toBe("");
    expect(g.env.GH_CONFIG_DIR).toBe("/abs/run/.gh-empty");
    expect(g.env.KEEP).toBe("1");
    // The caller's env is not mutated.
    expect(base.env.GH_TOKEN).toBe("x");
  });

  it("refuses a relative gh config dir", () => {
    expect(() => fixtureSpawnGuard(base, "rel/.gh")).toThrow(/absolute/);
  });
});
