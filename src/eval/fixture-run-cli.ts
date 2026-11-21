/**
 * CLI for fixture evals (the real-IO wiring; the logic is fixture-run.ts):
 *   `node src/eval/fixture-run-cli.ts --fixture=<name> [--runs=1..5] [--max-total=<usd>]`
 * Normally reached through `npm run eval -- --fixture=<name>` (evals/run.sh).
 * Dry by default: prints the plan, or every problem with the fixture, and
 * runs nothing. Live needs DRY_RUN=0, no CLAUDECODE, and LIVE_ENABLED.
 * Like main.ts this file is the untested composition root.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig, repoSlugFromUrl, resolveProjectConfigPath } from "../core/config.ts";
import { repoDirFor } from "../core/build-prompt.ts";
import { resolveRepoPath, v2FixtureRunsLog } from "../core/paths.ts";
import { redactSensitive } from "../core/redact.ts";
import { FlagError } from "../core/flags.ts";
import { realFakeEnvDeps, writeFakeEnv } from "../core/fake-env.ts";
import { realProfileDeps, resolveProjectProfile } from "../core/project-profile.ts";
import { buildSizeContext, type SizeContext } from "../core/size-context.ts";
import { spawnClaudeRun } from "../core/spawn-claude.ts";
import { loadResearchStance, REFINE_SKILL_MD_PATH } from "../roles/research/startup.ts";
import { makeRunSkill } from "../worker/skill-runner.ts";
import { loadFixture } from "./fixture.ts";
import { fixtureAttachments, fixtureMode, fixtureSpawn, LIVE_ENABLED, parseFixtureArgs, PER_RUN_BUDGET_USD, pinnedGit, planLines, runFixture } from "./fixture-run.ts";
import { pinWorktree } from "./pin-repo.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
/** Overridable only so the harness test can dry-run a throwaway fixture. */
const FIXTURES_DIR = process.env.EVAL_FIXTURES_DIR ?? join(REPO_ROOT, "evals", "fixtures");

const log = (m: string) => console.log(redactSensitive(m));
const logError = (m: string) => console.error(redactSensitive(m));

const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((res, rej) =>
    execFile("git", ["-C", cwd, ...args], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) =>
      err ? rej(new Error(String(errOut).trim() || err.message)) : res(String(out)),
    ),
  );

async function main(): Promise<number> {
  const args = parseFixtureArgs(process.argv.slice(2));
  const mode = fixtureMode(process.env);
  const loaded = await loadFixture(FIXTURES_DIR, args.fixture);
  logError(`[fixture] mode: ${mode}`);
  if (!loaded.ok) {
    logError(`[fixture] ${args.fixture}: refusing, the fixture is not runnable:`);
    for (const p of loaded.problems) logError(`  - ${p}`);
    return 1;
  }
  const f = loaded.fixture;
  const config = await loadConfig(await resolveProjectConfigPath(f.repo.project, REPO_ROOT));
  const slug = repoSlugFromUrl(config.targetRepo.url);
  const repoDir = repoDirFor(config, slug);
  if (mode === "dry") {
    for (const l of planLines(f, args, repoDir)) log(`[fixture] ${l}`);
    return 0;
  }
  if (!LIVE_ENABLED) {
    logError(
      "[fixture] live fixture runs are not enabled yet: the gh/api.github.com guard hook and a first watched run come first " +
        "(docs/superpowers/specs/2026-11-20-eval-fixtures-design.md, calls 5 and 9). Nothing ran.",
    );
    return 1;
  }

  const sha = f.repo.sha;
  const profile = await resolveProjectProfile(config, repoDir, { ...realProfileDeps, git: pinnedGit(realProfileDeps.git, sha) });
  const researchStance = await loadResearchStance(REPO_ROOT);
  const skillVersion = execFileSync("git", ["log", "-1", "--format=%H", "--", REFINE_SKILL_MD_PATH], { encoding: "utf8", cwd: REPO_ROOT }).trim();
  const fakeEnvDeps = { ...realFakeEnvDeps, git: pinnedGit(realFakeEnvDeps.git, sha) };
  const sizeContext = async (): Promise<SizeContext> =>
    (f.expect.sizeContext as SizeContext | undefined) ?? buildSizeContext({ devRuns: [], research: [], sidecar: {}, config, now: new Date() });

  const result = await runFixture({
    fixture: f,
    config,
    runs: args.runs,
    maxTotalUsd: args.maxTotalUsd,
    maxBudgetUsd: PER_RUN_BUDGET_USD,
    now: () => new Date(),
    resolve: resolveRepoPath,
    logPath: resolveRepoPath(v2FixtureRunsLog(f.name)),
    pin: (runId) =>
      pinWorktree({ repoDir, dir: join(repoDir, ".claude", "worktrees", `${f.ticket.key}-${runId}-ground`), sha, git: (a) => git(a, repoDir) }),
    makeRunSkill: ({ pinned, absRunDir }) => {
      const ghConfigDir = join(absRunDir, ".gh-empty");
      const spawn = fixtureSpawn((o) => spawnClaudeRun(o, { log, logError }), { groundDir: pinned.dir, ghConfigDir });
      return makeRunSkill({
        config,
        slug,
        repoRoot: REPO_ROOT,
        stream: false,
        researchStance,
        skillVersion: { research: skillVersion, dev: "" },
        spawn: async (o) => {
          await mkdir(ghConfigDir, { recursive: true });
          return spawn(o);
        },
        log,
        logError,
        profile,
        refreshFakeEnv: async (p) => void (await writeFakeEnv(repoDir, config.targetRepo.defaultBranch, p, fakeEnvDeps)),
        sizeContext,
        attachments: fixtureAttachments(f.dir, f.ticket.attachments),
      });
    },
    log,
  });
  log(
    `[fixture] ${f.name}: ${result.pass ? "PASS" : "FAIL"}, pass rate ${(result.passRate * 100).toFixed(0)}% over ${result.runs} run(s), ` +
      `$${result.costUsd.toFixed(2)}${result.stoppedAt ? ` (${result.stoppedAt})` : ""}`,
  );
  for (const r of result.reasons) log(`  - ${r}`);
  return result.pass ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof FlagError) logError(err.message);
    else logError(`[fixture] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  },
);
