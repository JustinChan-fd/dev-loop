// Structural checks (spec §9.3): cheap, every change. What a skill, agent or
// hook names must exist; no skill hardcodes `.pipeline/`; nothing in the
// pipeline's own code or prose reaches for a banned git/gh flag.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) return [];
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "worktrees" ? [] : walk(p);
    return [p];
  });
}

const rel = (p: string): string => relative(ROOT, p);
const CLAUDE_FILES = walk(join(ROOT, ".claude"));

describe("structure: .claude/** names only paths that exist", () => {
  // A repo-relative path, not part of a longer path (`~/.claude/...`,
  // `research-loop/src/...`, `$DEVLOOP_DIR/src/...` are not repo-relative).
  const PATH_RE = /(?<![\w~/.<>$-])(\.claude|src|scripts|docs)\/[\w./-]+\.(md|ts|mjs|sh|json)/g;

  it("scans a non-empty .claude tree", () => {
    expect(CLAUDE_FILES.length).toBeGreaterThan(5);
  });

  it("every named path exists", () => {
    const missing: string[] = [];
    for (const f of CLAUDE_FILES) {
      for (const m of readFileSync(f, "utf8").matchAll(PATH_RE)) {
        if (!existsSync(join(ROOT, m[0]))) missing.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("structure: settings.json hooks", () => {
  it("every hook command points to an executable file", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
    expect(commands.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const command of commands) {
      const path = command.replace(/^"\$CLAUDE_PROJECT_DIR"/, ROOT);
      if (path === command) {
        bad.push(`${command}: not under "$CLAUDE_PROJECT_DIR"`);
        continue;
      }
      if (!existsSync(path) || (statSync(path).mode & 0o111) === 0) bad.push(`${command}: missing or not executable`);
    }
    expect(bad).toEqual([]);
  });
});

describe("structure: no skill hardcodes .pipeline/", () => {
  // The one allowed mention is the run-dir validation marker the skills check
  // their given run-dir= against (Ruling 23); any other `.pipeline/` is a
  // hardcoded or derived path.
  const MARKER = "`/.pipeline/v2/`";
  const skills = CLAUDE_FILES.filter((f) => /\.claude\/skills\/.+\/SKILL\.md$/.test(f));

  it("finds the three skills", () => {
    expect(skills.map(rel).sort()).toEqual([
      ".claude/skills/reset-project/SKILL.md",
      ".claude/skills/ticket-refine/SKILL.md",
      ".claude/skills/ticket-to-pr/SKILL.md",
    ]);
  });

  for (const f of skills) {
    it(`${rel(f)} has no .pipeline/ beyond the run-dir marker`, () => {
      const lines = readFileSync(f, "utf8")
        .split("\n")
        .map((l, i) => [i + 1, l.split(MARKER).join("")] as const)
        .filter(([, l]) => l.includes(".pipeline/"));
      expect(lines).toEqual([]);
    });
  }

  for (const name of ["ticket-refine", "ticket-to-pr"]) {
    it(`${name} takes run-dir= and repo-dir= and checks the marker`, () => {
      const text = readFileSync(join(ROOT, `.claude/skills/${name}/SKILL.md`), "utf8");
      expect(text).toContain("run-dir=");
      expect(text).toContain("repo-dir=");
      expect(text).toContain(MARKER);
      expect(text).toContain("Never guess a path.");
      expect(text).not.toMatch(/\bSLUG\b/);
    });
  }
});

describe("structure: agents never derive a run path", () => {
  const agents = CLAUDE_FILES.filter((f) => /\.claude\/agents\/.+\.md$/.test(f));
  it("finds the four agents", () => expect(agents.length).toBe(4));
  for (const f of agents) {
    it(`${rel(f)} has no .pipeline/ and no <SLUG>`, () => {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain(".pipeline/");
      expect(text).not.toMatch(/<SLUG>/);
    });
  }
});

describe("structure: skill prose (Ruling 24)", () => {
  const read = (name: string) => readFileSync(join(ROOT, `.claude/skills/${name}/SKILL.md`), "utf8");

  it("ticket-to-pr Phase 5 says to push with the literal branch name", () => {
    const text = read("ticket-to-pr");
    const phase5 = text.slice(text.indexOf("### Phase 5"), text.indexOf("## Cleanup"));
    expect(phase5).toContain("push with the literal branch name");
  });

  it("ticket-refine's passing-verdict Jira template does not mention Needs-decision bullets", () => {
    const text = read("ticket-refine");
    const start = text.indexOf("2. **On a passing verdict**");
    const passing = text.slice(start, text.indexOf("3. **On a bounce**", start));
    expect(start).toBeGreaterThan(-1);
    expect(passing).not.toMatch(/Needs-decision bullets/);
  });

  describe("ticket-to-pr Phase 4: failures that already exist on master (Ruling 29)", () => {
    const phase4 = () => {
      const text = read("ticket-to-pr");
      return text.slice(text.indexOf("### Phase 4"), text.indexOf("### Phase 5"));
    };

    it("re-runs the failing tests against unmodified origin/<defaultBranch> before bouncing", () => {
      expect(phase4()).toContain("Pre-existing failure check");
      expect(phase4()).toMatch(/git -C <REPO_DIR> worktree add --detach[\s\\]+\S*-baseline/);
      expect(phase4()).toContain("origin/<targetRepo.defaultBranch>");
    });

    it("proceeds only when the branch's failing set is a subset of the baseline's", () => {
      expect(phase4()).toMatch(/every test that fails on the branch also fails[^.]*on the baseline/i);
      expect(phase4()).toMatch(/fails only on the branch[^.]*Green-phase\s+defect/i);
    });

    it("names the pre-existing failures in the PR body, qa_notes and the result line", () => {
      expect(phase4()).toContain("## Pre-existing failures");
      expect(phase4()).toMatch(/pre-existing on `?origin\/<defaultBranch>`? <sha>/i);
      expect(phase4()).toContain("preexisting_failures");
    });

    it("still forbids bypassing a push hook that runs the suite", () => {
      expect(phase4()).toMatch(/never bypass[^.]*hook/i);
    });

    it("removes the baseline worktree", () => {
      expect(phase4()).toMatch(/worktree remove[^\n]*baseline/);
    });
  });

  describe("ticket-to-pr: commit hooks that run the suite (Ruling 30)", () => {
    const text = () => read("ticket-to-pr");
    const section = (start: string, end: string) => {
      const t = text();
      const i = t.indexOf(start);
      expect(i).toBeGreaterThan(-1);
      return t.slice(i, t.indexOf(end, i + start.length));
    };

    it("Phase 0 records a baseline suite run on unmodified origin/<defaultBranch>", () => {
      const p0 = section("### Phase 0", "### Phase 1");
      expect(p0).toContain("Baseline suite");
      expect(p0).toContain("baseline_failures");
    });

    it("Red commits the new tests marked expected-to-fail, and Green flips them back", () => {
      const red = section("### Phase 2", "### Phase 3");
      expect(red).toContain("it.fails");
      expect(red).toContain("test.failing");
      const green = section("### Phase 3", "### Phase 4");
      expect(green).toMatch(/remove the expected-to-fail marker/i);
    });

    it("has a follow-up section that fixes pre-existing failures on their own branch and PR first", () => {
      const fu = section("## Pre-existing failures blocking a hook", "## Cleanup");
      expect(fu).toContain("mcp__atlassian__createJiraIssue");
      expect(fu).toContain("mcp__atlassian__createIssueLink");
      expect(fu).toMatch(/never add the pipeline trigger label/i);
      expect(fu).toMatch(/-fix-preexisting-tests/);
      expect(fu).toMatch(/off `?origin\/<targetRepo\.defaultBranch>`?/);
    });

    it("carries the committed fix into the ticket worktree unstaged, and proves it never enters the ticket's commits", () => {
      const fu = section("## Pre-existing failures blocking a hook", "## Cleanup");
      expect(fu).toMatch(/git apply/);
      expect(fu).toMatch(/git apply -R/);
      expect(fu).toMatch(/git diff --cached --name-only/);
      expect(fu).toMatch(/never `git add -A`|never `git add \.`/);
    });

    it("limits the follow-up fix to test files and files it can name, else files the ticket only and links it as a blocker", () => {
      const fu = section("## Pre-existing failures blocking a hook", "## Cleanup");
      expect(fu).toMatch(/only test files/i);
      expect(fu).toMatch(/is blocked by/);
      expect(fu).toContain("follow_up");
    });

    it("still never bypasses a hook", () => {
      const fu = section("## Pre-existing failures blocking a hook", "## Cleanup");
      expect(fu).toMatch(/never bypass/i);
    });
  });

  describe("target-repo env: every target command runs through direnv exec (Ruling 31)", () => {
    it("ticket-to-pr's Target repo section names `direnv exec <worktree>` for tests, hooks and builds", () => {
      const t = read("ticket-to-pr");
      const target = t.slice(t.indexOf("## Target repo"), t.indexOf("### Resume"));
      expect(target).toContain("Run every target-repo command through `direnv exec`");
      expect(target).toMatch(/direnv exec <REPO_DIR>\/\.claude\/worktrees\/<TICKET>-<RUN_ID>/);
      expect(target).toMatch(/git commit[^\n]*and `git push`/);
      expect(target).toMatch(/not\s+a\s+bug\s+on\s+<defaultBranch>/i);
    });

    it("the baseline suite run uses it too", () => {
      const t = read("ticket-to-pr");
      const p0 = t.slice(t.indexOf("### Phase 0"), t.indexOf("### Phase 1"));
      expect(p0).toMatch(/Baseline suite[\s\S]*direnv exec/);
    });

    it("qa-agent runs the app and tests through direnv exec", () => {
      const qa = readFileSync(join(ROOT, ".claude/agents/qa-agent.md"), "utf8");
      expect(qa).toContain("direnv exec");
    });
  });

  it("no skill mentions the removed auto-promote label", () => {
    for (const name of ["ticket-refine", "ticket-to-pr"]) expect(read(name)).not.toMatch(/auto-promote|autoPromote/);
  });
});

describe("structure: no banned git/gh flags", () => {
  const BANNED = /--force|--no-verify|gh stack (push|sync|submit)/;
  // The unsafe-git checker IS the deny list: its pattern table and reason
  // strings must spell every banned flag. Exempted by exact path, nothing
  // else. Its hook tests live under test/hooks/, which is not scanned.
  const DENY_LIST = "scripts/check-unsafe-git-in-tool-input.ts";
  const files = ["src", "scripts", "evals"].flatMap((d) => walk(join(ROOT, d))).concat(CLAUDE_FILES);

  it("scans .claude, src and scripts, and exempts only the deny list", () => {
    expect(files.some((f) => rel(f).startsWith("src/"))).toBe(true);
    expect(files.some((f) => rel(f).startsWith("scripts/"))).toBe(true);
    expect(readFileSync(join(ROOT, DENY_LIST), "utf8")).toContain("Unverifiable");
  });

  it("the matcher is not a no-op", () => {
    expect(BANNED.test("git push --force-with-lease")).toBe(true);
    expect(BANNED.test("git commit --no-verify")).toBe(true);
    expect(BANNED.test("gh stack submit")).toBe(true);
    expect(BANNED.test("git push -u origin TARS-1-x")).toBe(false);
  });

  it("a line naming one also says never or banned", () => {
    const hits: string[] = [];
    for (const f of files) {
      if (rel(f) === DENY_LIST) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (BANNED.test(line) && !/never|banned/i.test(line)) hits.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("structure: research-loop/ is gone", () => {
  // Only its tracked checkout files. research-loop/runs/ may still hold
  // pre-cutover v1 logs that v1PreCutoverRunsLog reads (Ruling 28).
  it("no research-loop/.claude and no research-loop/CLAUDE.md", () => {
    expect(existsSync(join(ROOT, "research-loop/.claude"))).toBe(false);
    expect(existsSync(join(ROOT, "research-loop/CLAUDE.md"))).toBe(false);
  });

  it("the research stance file the spawn loads exists", () => {
    expect(existsSync(join(ROOT, "src/roles/research/stance.md"))).toBe(true);
  });
});

describe("structure: final-review fixes stay wired", () => {
  it("settings.json denies Read as well as Edit of /.env* (I4)", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8")) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toContain("Edit(/.env*)");
    expect(settings.permissions.deny).toContain("Read(/.env*)");
  });

  it("main.ts checks REPO_DIR placement right after checkAbsPath (parked #1)", () => {
    const main = readFileSync(join(ROOT, "src/main.ts"), "utf8");
    expect(main).toMatch(/checkAbsPath\("repo-dir", [^\n]*\n[^\n]*checkRepoDirPlacement\(/);
  });

  it("main.ts's signal handler stops the running claude -p child (I5)", () => {
    const main = readFileSync(join(ROOT, "src/main.ts"), "utf8");
    expect(main).toMatch(/stopOnSignal\(sig, \{[^}]*killChild: \(\) => killActiveChild\(\)/s);
  });

  it("every --env-file script reads DEVLOOP_ENV_FILE, defaulting to .env (I4)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const withEnvFile = Object.entries(pkg.scripts).filter(([, cmd]) => cmd.includes("--env-file"));
    expect(withEnvFile.map(([name]) => name).sort()).toEqual(["check-auth", "cutover:relabel", "fixture:save", "loop", "reset-project", "reset-project:remote", "sbx:preflight"]);
    // Reset runs without credentials too (its Jira/GitHub rows then say so), so its file is optional.
    const optional = new Set(["reset-project", "reset-project:remote"]);
    for (const [name, cmd] of withEnvFile) {
      expect(cmd).toContain(optional.has(name) ? '--env-file-if-exists="${DEVLOOP_ENV_FILE:-.env}"' : '--env-file="${DEVLOOP_ENV_FILE:-.env}"');
      expect(cmd).not.toContain("--env-file=.env");
    }
  });

  it("main.ts warns about a leftover root .env, after config load and before the session (I4)", () => {
    const main = readFileSync(join(ROOT, "src/main.ts"), "utf8");
    const load = main.indexOf("await loadConfig(");
    const warn = main.indexOf("envFileWarning({ envFileVar: process.env.DEVLOOP_ENV_FILE");
    const acquire = main.indexOf("await acquireSession(");
    expect(load).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(load);
    expect(acquire).toBeGreaterThan(warn);
    // M4: compared as resolved paths (cwd for the variable, the repo root's .env).
    expect(main).toContain('const rootEnvPath = resolve(REPO_ROOT, ".env");');
    expect(main.slice(warn, main.indexOf("\n", warn))).toMatch(/cwd: process\.cwd\(\), rootEnvPath, rootEnvExists: existsSync\(rootEnvPath\)/);
  });

  it("check-jira-auth's missing-var hint names DEVLOOP_ENV_FILE (I4)", () => {
    const result = spawnSync(process.execPath, [join(ROOT, "scripts/check-jira-auth.mjs")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEVLOOP_ENV_FILE");
  });

  it("the throwaway v1 size-checkpoint script is gone (M3)", () => {
    expect(existsSync(join(ROOT, "scripts/size-checkpoint.mjs"))).toBe(false);
  });
});

describe("structure: sandbox names stay inside their adapter folder", () => {
  const src = walk(join(ROOT, "src")).filter((f) => /\.(ts|md|json|mjs)$/.test(f));
  const sbxDir = join(ROOT, "src/sandbox/sbx") + "/";
  // The registry is the one sanctioned mention outside the adapter folder:
  // its import line and its `sbx: sbxAdapter` line. Exempted by exact path.
  const REGISTRY = "src/sandbox/index.ts";

  it("scans a non-empty src tree", () => expect(src.length).toBeGreaterThan(10));

  it("no sandbox-specific names outside src/sandbox/<adapter>/", () => {
    const hits = src.filter((f) => !f.startsWith(sbxDir) && rel(f) !== REGISTRY && /\bsbx\b/i.test(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual([]);
  });

  it("the registry mentions sbx only on its import line and its registry line", () => {
    const lines = readFileSync(join(ROOT, REGISTRY), "utf8")
      .split("\n")
      .filter((l) => /\bsbx\b/i.test(l))
      .map((l) => l.trim());
    expect(lines).toEqual(['import { sbxAdapter } from "./sbx/index.ts";', "sbx: sbxAdapter,"]);
  });

  it("main.ts --preflight-only exits after the sandbox preflight, before any session or Jira client", () => {
    const main = readFileSync(join(ROOT, "src/main.ts"), "utf8");
    const stop = main.indexOf("if (preflightOnly)");
    expect(stop).toBeGreaterThan(main.indexOf("adapter.preflight({"));
    expect(stop).toBeLessThan(main.indexOf("credentialsFromEnv()"));
  });

  it("main.ts fills the model alias names from Claude settings before the sandbox preflight", () => {
    const main = readFileSync(join(ROOT, "src/main.ts"), "utf8");
    const fill = main.indexOf("fillModelEnvFromClaudeSettings(process.env)");
    expect(fill).toBeGreaterThan(-1);
    expect(fill).toBeLessThan(main.indexOf("adapter.preflight({"));
  });

  it("main.ts gives preflight a project-scoped throwaway instance name and the repo root as cwd", () => {
    const main = readFileSync(join(ROOT, "src/main.ts"), "utf8");
    // Built only for a real sandbox, so a long slug never fails the default (none) path.
    expect(main).toMatch(/sandboxSelection\.adapter\.name !== DEFAULT_ADAPTER \? sandboxPreflightInstanceName\(slug, randomBytes\(3\)\.toString\("hex"\)\) : ""/);
    const call = main.slice(main.indexOf("adapter.preflight({"), main.indexOf("});", main.indexOf("adapter.preflight({")));
    expect(call).toMatch(/instanceName: preflightInstanceName/);
    expect(call).toMatch(/githubRepo: config\.github\.repo/);
    expect(call).toMatch(/cwd: REPO_ROOT/);
  });

  it("types.ts documents that teardown may throw and that wrap needs prepare's handle", () => {
    const types = readFileSync(join(ROOT, "src/sandbox/types.ts"), "utf8");
    expect(types).toContain("Idempotent. May throw on a real failure; spawn-claude logs it and carries on.");
    expect(types).not.toContain("Idempotent; never throws.");
    expect(types).toContain("h must be the handle prepare returned");
  });

  it("no adapter-name branching outside src/sandbox/", () => {
    const hits = src
      .filter((f) => !f.startsWith(join(ROOT, "src/sandbox") + "/"))
      .filter((f) => /adapter === "|adapter\.name === "/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(hits).toEqual([]);
  });
});

describe("structure: node floor", () => {
  it('package.json engines.node is ">=24.0.0"', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(">=24.0.0");
  });
});

describe("structure: docs/projects registry", () => {
  it("every pipeline.*.config.json project has a docs/projects/<slug>.md and a README row", () => {
    const readme = readFileSync(join(ROOT, "docs/projects/README.md"), "utf8");
    const configs = readdirSync(ROOT).filter((n) => /^pipeline\.(.+)\.config\.json$/.test(n) && n !== "pipeline.loop.config.json");
    expect(configs.length).toBeGreaterThan(0);
    for (const name of configs) {
      const url = (JSON.parse(readFileSync(join(ROOT, name), "utf8")) as { targetRepo: { url: string } }).targetRepo.url;
      const slug = url.replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
      // catalog-ui-public has a config but is not onboarded: its row names it, with no doc link.
      const row = readme.split("\n").find((l) => l.startsWith(`| ${slug} |`));
      if (row?.includes("not supported")) continue;
      expect(existsSync(join(ROOT, "docs/projects", `${slug}.md`)), `${name}: docs/projects/${slug}.md`).toBe(true);
      expect(readme, `${name}: README row`).toContain(`| [${slug}](${slug}.md)`);
    }
  });
});
