// Claude Code on dev-loop's own code, inside an sbx sandbox. See
// docs/sandbox-sbx.md "Dev-loop sessions" and README "Starting a session".
//
//   claude --dangerously-skip-permissions        # normal session, unchanged (not this script)
//   npm run claude:sbx                           # same, but inside the sandbox
//   npm run claude:sbx -- --overnight --prompt-file=.overnight/in/<file>.md
//                                                # unattended: caffeinate + screen; prints screen -r <name>
//   npm run claude:sbx:sync [-- --name=<sandbox>] [--allow-protected]
//                                                # bring the sandbox's branches back, re-signed; never pushes
//   npm run claude:sbx -- --check                # inside a sandbox: prove it is one (exit 0) or not (exit 1)
//
// The decisions are pure functions in src/sandbox/sbx/session.ts and
// session-sync.ts, with tests. This file only runs them. Access grants stay
// with the human: it never runs `sbx policy allow` or `sbx secret set`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { FlagError, parseFlags } from "../src/core/flags.ts";
import { fillModelEnvFromClaudeSettings } from "../src/core/claude-settings-env.ts";
import { rootEnvFiles } from "../src/core/env-files.ts";
import { realGit } from "../src/worker/host-sign.ts";
import {
  claudeArgs, overnightArgv, overnightPromptFile, parseSandboxCheck, renderSyncSummary, resolvePlugins,
  SANDBOX_CHECK_SCRIPT, SANDBOX_OVERNIGHT_DIR, SESSION_PREFIX, sessionCreateArgs, sessionName, validateSessionConfig,
} from "../src/sandbox/sbx/session.ts";
import { syncSandboxBranches } from "../src/sandbox/sbx/session-sync.ts";

const SCRIPT_REPO = resolve(import.meta.dirname, "..");
const [cmd, ...rest] = process.argv.slice(2);

const die = (m) => { console.error(m); process.exit(1); };
let flags;
try {
  flags = parseFlags(rest, { values: ["--prompt-file", "--name"], bools: ["--overnight", "--check", "--allow-protected", "--no-sync"] }, `claude:${cmd}`);
} catch (err) {
  if (!(err instanceof FlagError)) throw err;
  die(err.message);
}

const sh = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: "utf8", ...opts });
const sbxOut = (args) => sh("sbx", args);

/**
 * sbx --clone needs the main checkout, not a git worktree. Run from a
 * worktree (e.g. a branch not yet merged), it still clones the main checkout;
 * the sandbox can `git checkout` the branch, which is in the same repo.
 */
function mainCheckout() {
  const r = sh("git", ["-C", SCRIPT_REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.status !== 0) die(`not a git checkout: ${SCRIPT_REPO}`);
  return resolve(r.stdout.trim(), "..");
}

function sessionConfig(repo) {
  const file = join(SCRIPT_REPO, "sbx.session.config.json");
  try {
    return validateSessionConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    die(`${relative(process.cwd(), file)}: ${err.message}`);
  }
}

function sandboxCheck(name) {
  const r = sh("sbx", ["exec", "-i", name, "sh", "-s"], { input: SANDBOX_CHECK_SCRIPT });
  return parseSandboxCheck(r.status === 0 ? r.stdout : "");
}

/** Everything that must hold before a sandbox is made. Exits with the reason. */
function preflight(repo, cfg) {
  if (sh("sbx", ["version"]).error) die("sbx is not installed or not on PATH (see docs/sandbox-sbx.md)");
  if (!existsSync(cfg.sbx.kitDir)) die(`kit folder ${cfg.sbx.kitDir} not found (sbx.session.config.json sandbox.sbx.kitDir)`);
  const env = rootEnvFiles(repo);
  if (env.length > 0) die(`${env[0]} is in ${repo}, which the sandbox can read: move it out and point DEVLOOP_ENV_FILE at it (docs/sandbox-sbx.md)`);
  const dirty = sh("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (dirty) console.warn(`Note: ${repo} has uncommitted changes. The sandbox clones commits only; it won't see them.`);
  for (const d of ["in", "out"]) mkdirSync(join(repo, ".overnight", d), { recursive: true });
  let installed;
  try { installed = JSON.parse(readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8")); } catch { installed = null; }
  try { return resolvePlugins(installed, cfg.plugins); } catch (err) { die(err.message); }
}

/** The one-time setup inside a fresh sandbox: npm registry the policy allows. No secrets, no signing. */
function setupInside(name, cfg) {
  if (!cfg.npmRegistry) return;
  const npmrc = `registry=${cfg.npmRegistry}\nreplace-registry-host=always\n`;
  const r = sh("sbx", ["exec", "-i", name, "sh", "-c", 'cat > "$HOME/.npmrc"'], { input: npmrc });
  if (r.status !== 0) console.warn(`Could not write ~/.npmrc in the sandbox; npm ci may be blocked. If so, review and allow it yourself: sbx policy allow network npm.fandango.com`);
}

function modelEnvArgs(cfg) {
  fillModelEnvFromClaudeSettings(process.env);
  return cfg.envAllow.filter((n) => process.env[n]).flatMap((n) => ["-e", n]);
}

async function sync(repo, cfg, name) {
  const git = realGit();
  let rows;
  try {
    rows = await syncSandboxBranches({ repo, name, protectedPaths: cfg.protectedPaths, allowProtected: flags.bools.has("--allow-protected"), git, defaultBranch: "main" });
  } catch (err) {
    console.error(`Sync from ${name} failed: ${String(err.message ?? err).split("\n")[0]}`);
    console.error(`Is the sandbox running? Start it with: sbx exec ${name} true   then rerun npm run claude:sbx:sync -- --name=${name}`);
    return 1;
  }
  const outDir = join(repo, ".overnight", "out");
  const reports = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".md")).map((f) => `.overnight/out/${f}`) : [];
  console.log(`\n${renderSyncSummary(name, rows, reports)}`);
  return rows.some((r) => r.status === "failed") ? 1 : 0;
}

function sessionSandboxes() {
  const r = sbxOut(["ls", "--json"]);
  if (r.status !== 0) die(`sbx ls failed: ${(r.stderr || "").trim()}`);
  return JSON.parse(r.stdout || "[]").map((s) => s?.name).filter((n) => typeof n === "string" && n.startsWith(SESSION_PREFIX)).sort();
}

switch (cmd) {
  case "sbx": {
    if (flags.bools.has("--check")) {
      // Inside a sandbox: the same check the host runs through sbx exec.
      const r = parseSandboxCheck(sh("sh", ["-c", SANDBOX_CHECK_SCRIPT]).stdout);
      console.log(r.ok ? "In a dev-loop session sandbox." : `Not in a dev-loop session sandbox: ${r.reasons.join("; ")}`);
      process.exit(r.ok ? 0 : 1);
    }
    const overnight = flags.bools.has("--overnight");
    if (flags.values["--prompt-file"] && !overnight) die("--prompt-file needs --overnight (an attended session takes your prompts)");
    const repo = mainCheckout();
    const cfg = sessionConfig(repo);
    let prompt;
    if (overnight) {
      if (!flags.values["--prompt-file"]) die("--overnight needs --prompt-file=.overnight/in/<file>.md");
      try {
        prompt = overnightPromptFile(repo, flags.values["--prompt-file"], (p) => realpathSync(p));
      } catch (err) { die(err.code === "ENOENT" ? `--prompt-file not found: ${flags.values["--prompt-file"]}` : err.message); }
      if (process.platform !== "darwin") die("--overnight runs from the Mac (caffeinate + screen)");
      if (sh("screen", ["-v"]).error) die("screen is not installed");
    }
    const plugins = preflight(repo, cfg);
    const name = flags.values["--name"] ?? sessionName(new Date());
    if (!name.startsWith(SESSION_PREFIX) || !/^[a-z0-9-]{3,63}$/.test(name)) die(`--name must start with ${SESSION_PREFIX}`);

    console.log(`Creating ${name}: its own clone of ${repo}, GitHub blocked, no signing key. Watch: npm run sbx:dashboard`);
    const create = sh("sbx", sessionCreateArgs(name, cfg, repo, plugins), { stdio: "inherit", cwd: repo });
    if (create.status !== 0) die(`sbx create failed. Check: npm run sbx:status`);
    const check = sandboxCheck(name);
    if (!check.ok) {
      sh("sbx", ["rm", "-f", name], { stdio: "inherit" });
      die(`Refusing: ${name} did not pass the sandbox check (${check.reasons.join("; ")}). Removed it.`);
    }
    setupInside(name, cfg);
    const env = modelEnvArgs(cfg.sbx);
    const agent = claudeArgs(plugins);

    if (overnight) {
      const inSandbox = `${SANDBOX_OVERNIGHT_DIR}/in/${relative(join(repo, ".overnight", "in"), prompt)}`;
      const ask = `Read ${inSandbox} and do what it says. Your clone is ${repo}. Inputs: ${SANDBOX_OVERNIGHT_DIR}/in (read-only). Write your report to ${SANDBOX_OVERNIGHT_DIR}/out. You cannot push; commit on branches and the host syncs them.`;
      const [bin, ...argv] = overnightArgv({ name, repo, env, agent, ask, log: join(repo, ".overnight", "out", `${name}.log`) });
      const screen = sh(bin, argv, { stdio: "inherit" });
      if (screen.status !== 0) die("could not start screen");
      console.log(`\nRunning unattended in ${name} (caffeinate keeps the Mac awake).
  watch:   screen -r ${name}        (detach again: Ctrl-a d)
  log:     .overnight/out/${name}.log
  after:   npm run claude:sbx:sync -- --name=${name}
  remove:  sbx rm ${name}           (after sync)`);
      break;
    }

    // Attended: Claude in the sandbox, in this terminal. sbx's own defaults already bypass permissions.
    sh("sbx", ["run", "--name", name, ...env, "--", "--dangerously-skip-permissions", ...agent], { stdio: "inherit", cwd: repo });
    if (flags.bools.has("--no-sync")) {
      console.log(`\nNot synced (--no-sync). Later: npm run claude:sbx:sync -- --name=${name}`);
      break;
    }
    const code = await sync(repo, cfg, name);
    console.log(`\nThe sandbox ${name} is kept (its clone holds the work). Remove it when you're done: sbx rm ${name}`);
    process.exit(code);
  }

  case "sbx:sync": {
    const repo = mainCheckout();
    const cfg = sessionConfig(repo);
    let name = flags.values["--name"];
    if (!name) {
      const all = sessionSandboxes();
      if (all.length === 0) die(`No ${SESSION_PREFIX}* sandboxes. Start one with npm run claude:sbx`);
      if (all.length > 1) die(`More than one session sandbox; pick one with --name=:\n${all.map((n) => `  ${n}`).join("\n")}`);
      name = all[0];
    }
    if (!name.startsWith(SESSION_PREFIX)) die(`--name must start with ${SESSION_PREFIX}`);
    sh("sbx", ["exec", name, "true"]); // the remote needs the sandbox running
    process.exit(await sync(repo, cfg, name));
  }

  default:
    die("usage: node scripts/claude-sbx.mjs sbx [--overnight --prompt-file=.overnight/in/<f>.md] [--name=dl-session-...] [--no-sync] [--check] | sbx:sync [--name=...] [--allow-protected]");
}
