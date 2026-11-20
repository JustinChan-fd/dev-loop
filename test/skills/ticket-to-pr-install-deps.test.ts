// Text guard: ticket-to-pr installs the target repo's packages inside each
// worktree it creates, and never treats "tests can't run here" as a reason to
// carry on. TARS-1634 (2026-11-17): a sandboxed run found no node_modules in
// its fresh worktree, reached for macOS-built ones, called vitest "not
// runnable" and went on to ready_to_push without running the suite.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const text = readFileSync(join(ROOT, ".claude/skills/ticket-to-pr/SKILL.md"), "utf8");

describe("ticket-to-pr installs dependencies in its worktree", () => {
  it("has an install step after the worktree is created", () => {
    const i = text.indexOf("### Install the target repo's packages");
    expect(i).toBeGreaterThan(text.indexOf("git -C <REPO_DIR> worktree add \\"));
    const step = text.slice(i, i + 1600);
    expect(step).toContain("direnv exec <worktree>/<appDir> npm ci");
    expect(step).toMatch(/never (copy|link|reuse)[^.]*node_modules/i);
  });

  it("a suite that cannot run is a bounce, never a skip", () => {
    const i = text.indexOf("### Install the target repo's packages");
    const step = text.slice(i, i + 1600);
    expect(step).toContain('failure_category: "env_setup"');
    expect(step).toMatch(/never (continue|carry on)[^.]*without running/i);
  });
});
