// The thin CLI wrapper around a pure grader: gathers the real state (the
// eval runs log, the sandbox PR via gh, the Jira ticket via jira.mjs),
// calls grade(), prints the result and exits 0 on pass, 1 on fail. Only
// runs when a check-*.mjs is executed directly, which evals/run.sh does
// through `outward` (so never in DRY_RUN=1, and never in the tests, which
// import the graders).
//
//   node --env-file=<env> evals/check-<name>.mjs --keys=<K1[,K2]> [--blocker=<K>] [--config=<path>]
//   clean-app adds: --canary-file=<path> --checkout=<dir> --loop-log=<path>

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const SANDBOX = "JustinChan-fd/dev-loop-eval-sandbox";

function isMain(metaUrl) {
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}

async function cliFlags(name) {
  const { FlagError, parseFlags } = await import("../src/core/flags.ts");
  try {
    return parseFlags(process.argv.slice(2), { values: ["--keys", "--blocker", "--config", "--canary-file", "--checkout", "--loop-log"], bools: [] }, `check-${name}`).values;
  } catch (err) {
    if (!(err instanceof FlagError)) throw err;
    console.error(err.message);
    process.exit(2);
  }
}

/** The sandbox PR whose head branch starts with the key (newest), or null. */
function sandboxPr(key) {
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
  const list = JSON.parse(gh(["pr", "list", "--repo", SANDBOX, "--state", "all", "--search", key, "--json", "number,headRefName"]));
  const hit = list.find((p) => p.headRefName === key || p.headRefName.startsWith(`${key}-`));
  if (!hit) return null;
  const pr = JSON.parse(gh(["pr", "view", String(hit.number), "--repo", SANDBOX, "--json", "url,state,commits"]));
  return { url: pr.url, state: pr.state, commits: (pr.commits ?? []).map((c) => ({ headline: c.messageHeadline })) };
}

/** Every file's text under dir (recursive), keyed by its path relative to `label`. */
function filesText(dir, label) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).size < 20 * 1024 * 1024) out[`run dir ${label}${p.slice(dir.length)}`] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** The sandbox PR's body and commit messages (full text), for the canary check. */
function prTexts(url) {
  if (!url) return {};
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
  const pr = JSON.parse(gh(["pr", "view", url, "--repo", SANDBOX, "--json", "body,commits"]));
  const commits = (pr.commits ?? []).map((c) => `${c.messageHeadline ?? ""}\n${c.messageBody ?? ""}`).join("\n");
  return { "PR body": pr.body ?? "", "commit messages": commits };
}

/**
 * A person's shell in a worktree folder (DEVLOOP_ROBOT_ENV unset): which of
 * the fake's names does direnv export? The fake's own file lists them.
 */
function handoverCheck(checkout) {
  const fake = join(checkout, ".claude", "worktrees", ".envrc");
  if (!existsSync(fake)) return null;
  const names = [...readFileSync(fake, "utf8").matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]);
  const env = { ...process.env };
  delete env.DEVLOOP_ROBOT_ENV;
  for (const n of names) delete env[n];
  const out = execFileSync("direnv", ["exec", join(checkout, ".claude", "worktrees"), "env"], { encoding: "utf8", env });
  const set = new Set(out.split("\n").map((l) => l.split("=")[0]));
  return { fakeNamesSeen: names.filter((n) => set.has(n)) };
}

/** clean-app's extra state: the dev run's progress, the loop's startup log, the fake, every text the canary must not reach. */
async function gatherApp(flags, root, records, key, pr) {
  const { latest } = await import("./grade-lib.mjs");
  const rec = latest(records, key);
  const runDirs = (rec?.phases ?? []).map((p) => p.run_dir).filter(Boolean);
  const devDir = (rec?.phases ?? []).find((p) => p.role === "dev")?.run_dir;
  const read = (p) => (p && existsSync(p) ? readFileSync(p, "utf8") : "");
  const checkout = flags["--checkout"] ?? "";
  let texts = {};
  for (const d of runDirs) texts = { ...texts, ...filesText(resolve(root, d), `${key}/${d.split("/").pop()}`) };
  texts = { ...texts, ...prTexts(pr?.url) };
  return {
    progress: read(devDir ? join(resolve(root, devDir), "progress.jsonl") : ""),
    loopLog: read(flags["--loop-log"]),
    fakeEnvrc: read(checkout ? join(checkout, ".claude", "worktrees", ".envrc") : ""),
    texts,
    canary: read(flags["--canary-file"]).trim(),
    handover: checkout ? handoverCheck(checkout) : null,
  };
}

export async function runGraderCli(metaUrl, name, grade) {
  if (!isMain(metaUrl)) return;
  const root = resolve(fileURLToPath(metaUrl), "../..");
  const { loadConfig } = await import("../src/core/config.ts");
  const { readIterations } = await import("../src/core/iteration-log.ts");
  const { getTicket } = await import("./jira.mjs");
  const { evalRunsLog } = await import("./config-guard.mjs");

  const flags = await cliFlags(name);
  const keys = (flags["--keys"] ?? "").split(",").filter(Boolean);
  if (keys.length === 0) {
    console.error(`usage: node evals/check-${name}.mjs --keys=<K1[,K2]> [--blocker=<K>]`);
    process.exit(2);
  }
  const config = await loadConfig(resolve(root, flags["--config"] ?? "pipeline.eval.config.json"));
  const records = await readIterations(resolve(root, evalRunsLog(config)));

  let pr;
  let jira;
  if (name === "queue") {
    pr = sandboxPr(keys[1]);
    jira = { keys };
  } else if (name === "blocked") {
    const blocker = flags["--blocker"];
    pr = blocker ? sandboxPr(blocker) : null;
    jira = { ...(await getTicket(keys[0])), blocker };
  } else {
    pr = sandboxPr(keys[0]);
    jira = await getTicket(keys[0]);
  }

  const extra = name === "clean-app" ? await gatherApp(flags, root, records, keys[0], pr) : {};
  const r = grade({ records, pr, jira, ...extra });
  console.log(JSON.stringify({ scenario: name, keys, ...r }));
  process.exit(r.pass ? 0 : 1);
}
