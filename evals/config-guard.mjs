// The eval config guard (Task 16, spec §9.2), used by evals/preflight.sh
// and by test/evals/harness.test.ts. Pure check over a loaded config:
// returns the list of problems, [] when the config is safe to run evals
// with. The CLI loads the file with the real loader (src/core/config.ts)
// and exits 1 on any problem.
//
//   node evals/config-guard.mjs <config-path>

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { loadConfig, repoSlugFromUrl } from "../src/core/config.ts";
import { preflight } from "../src/core/cli-args.ts";

export const SANDBOX_REPO = "JustinChan-fd/dev-loop-eval-sandbox";
export const EVAL_LABEL_CLAUSE = 'labels = "dev-loop-eval"';
const DEVLOOP_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SANDBOX_URLS = [`git@github.com:${SANDBOX_REPO}.git`, `https://github.com/${SANDBOX_REPO}.git`, `https://github.com/${SANDBOX_REPO}`];

export function checkEvalConfig(config, pkgVersion) {
  const problems = [];
  if (config.github?.repo !== SANDBOX_REPO) {
    problems.push(`github.repo must be ${SANDBOX_REPO} (got ${JSON.stringify(config.github?.repo)})`);
  }
  if (!SANDBOX_URLS.includes(config.targetRepo?.url)) {
    problems.push(`targetRepo.url must be the sandbox (got ${JSON.stringify(config.targetRepo?.url)})`);
  }
  // A checkout path (the app-layout eval): outside dev-loop's folder, and, once cloned, the sandbox.
  const path = config.targetRepo?.path;
  if (path !== undefined) {
    const down = relative(DEVLOOP_ROOT, path);
    if (!isAbsolute(path) || down === "" || (!down.startsWith("..") && !isAbsolute(down))) {
      problems.push(`targetRepo.path must be an absolute path outside dev-loop's folder (got ${JSON.stringify(path)})`);
    } else if (existsSync(resolve(path, ".git"))) {
      let origin = "";
      try {
        origin = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
      } catch {
        origin = "";
      }
      if (!SANDBOX_URLS.includes(origin)) problems.push(`targetRepo.path ${path}: its origin is not the sandbox (got ${JSON.stringify(origin)})`);
    }
  }
  for (const role of ["research", "dev"]) {
    const jql = config.roles?.[role]?.pollJql ?? "";
    if (!jql.includes(`AND ${EVAL_LABEL_CLAUSE}`) || /labels\s*!=\s*"dev-loop-eval"/.test(jql)) {
      problems.push(`roles.${role}.pollJql must contain 'AND ${EVAL_LABEL_CLAUSE}' and no dev-loop-eval exclusion`);
    }
  }
  try {
    preflight(config, "worker", pkgVersion);
  } catch (err) {
    problems.push(`worker preflight: ${err instanceof Error ? err.message : String(err)}`);
  }
  return problems;
}

/** The v2 log the eval loop writes to, relative to the repo root. */
export function evalRunsLog(config) {
  return `runs/v2/${repoSlugFromUrl(config.targetRepo.url)}.jsonl`;
}

function isRunAsScript() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node evals/config-guard.mjs <config-path>");
    process.exit(2);
  }
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  try {
    const config = await loadConfig(resolve(path));
    const problems = checkEvalConfig(config, pkg.version);
    for (const p of problems) console.error(`[eval] config: ${p}`);
    if (problems.length > 0) process.exit(1);
    console.error(`[eval] config OK: ${path} (log ${evalRunsLog(config)})`);
  } catch (err) {
    console.error(`[eval] config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
