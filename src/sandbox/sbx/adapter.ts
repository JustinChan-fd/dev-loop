// The sbx (Docker Sandboxes) adapter. The only place sbx commands, flags and
// output formats are known. Every call goes through an injected SbxRunner, so
// tests never run the real binary. Verified against sbx v0.53.0 (spec
// "Verified before step 3").

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResetStep } from "../../core/reset/step.ts";
import type { SandboxAdapter, SandboxDenial, SandboxHandle } from "../types.ts";
import { isEnvFile, rootEnvFiles } from "../../core/env-files.ts";
import { fakeEnvPaths } from "../../core/fake-env.ts";
import { DEFAULT_ENV_ALLOW, validateSbxConfig, type SbxConfig } from "./config.ts";
import type { SbxResult, SbxRunner } from "./run.ts";
import { openSbxDashboard, realDashboardDeps, type DashboardDeps } from "./dashboard.ts";

/** `sbx create` pulls an image on a cold cache; ~5 s when cached. */
export const CREATE_TIMEOUT_MS = 180_000;

const APPROVE_HEADING = "Review, then run yourself if you approve:";
/** Ordered so a failure is attributed by which version lines appeared before it. */
const TOOLS_CHECK = "node --version && git --version && jq --version && echo dl-step:direnv && direnv version";
/** Single-quoted for sh; mounts are real absolute paths but may hold spaces or @. */
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
/** The skills run target-repo commands through `direnv exec <worktree>`, which loads the loop's fake. */
const envrcCheck = (repoDir: string): string => `echo dl-step:envrc && direnv exec ${shq(join(repoDir, ".claude", "worktrees"))} true`;
/**
 * Inside the sandbox: trust the repo for git (its top folder isn't mounted, so it is root-owned
 * there) and allow only the loop's own fake.
 */
const sandboxSetup = (repoDir: string): string =>
  `git config --global --add safe.directory ${shq(repoDir)} && direnv allow ${shq(fakeEnvPaths(repoDir).envrc)}`;
/**
 * No env file of any name or case at the repo's top, and the common case variants named
 * directly (the disk is case-insensitive, so a lookup can find a file ls does not list).
 */
const hiddenCheck = (repoDir: string): string =>
  `echo dl-step:hidden && ! ls -A ${shq(repoDir)} | grep -qiE '^\\.env' && ` +
  [".envrc", ".ENVRC", ".Envrc", ".env", ".ENV", ".Env"].map((n) => `test ! -e ${shq(join(repoDir, n))}`).join(" && ");

/** True when `repoDir` is a cloned checkout that is its own mount (not inside another one). */
const coverable = (mounts: string[], repoDir: string | undefined): repoDir is string =>
  repoDir !== undefined && mounts.includes(repoDir) && existsSync(join(repoDir, ".git"));

/**
 * The target repo's top folder holds the person's real .envrc/.env, so it is never mounted.
 * Its mount is swapped for the two folders the robot needs: `.git` (worktree metadata,
 * objects, branches) and `.claude/worktrees` (the worktrees and the loop's fake .envrc).
 * Verified with sbx v0.54.0 (2026-11-17): from inside, no env file is visible under any
 * case, `git worktree add` and commits work, and the commits land in the host repo. A
 * per-file read-only cover was not enough: `.ENVRC` reached the real file.
 */
export function coverMounts(mounts: string[], repoDir: string | undefined): string[] {
  if (!coverable(mounts, repoDir)) return mounts;
  return mounts.flatMap((m) => (m === repoDir ? [join(repoDir, ".git"), join(repoDir, ".claude", "worktrees")] : [m]));
}
/** A plain GitHub owner/repo; it is interpolated into a shell command. */
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/**
 * Real reachability, not `gh auth status` (which reports "not logged in"
 * when the proxy injects the token per request). git goes through the SSH
 * URL on purpose, so a template without the HTTPS rewrite fails here.
 * Each `dl-step:` marker names the step that runs after it.
 */
const githubCheck = (repo: string): string =>
  `echo dl-step:git && git ls-remote git@github.com:${repo}.git HEAD >/dev/null && echo dl-step:gh && gh api repos/${repo} --jq .full_name`;
/**
 * The sandbox's proxy to GitHub is intermittently flaky (2026-11-17: ~3 in 11
 * checks failed after ~12 s, the host never did): a garbled reply, a git exit
 * 128, a cut-off exec. Only an undiagnosed GitHub-step failure is retried.
 */
export const GITHUB_TRIES = 3;
export const GITHUB_RETRY_MS = 2000;
/**
 * Where a host skill (sandbox.sbx.hostSkills) appears inside the sandbox.
 * sbx reserves /home/agent/.claude/skills, so the folder is mounted read-only
 * here and the skill is told the path (hostSkillPaths). Verified live
 * 2026-11-17 with sbx v0.54.0: a `<dir>:<path>:ro` workspace is readable, not
 * writable.
 */
export const SANDBOX_SKILLS_DIR = "/home/agent/.dev-loop/skills";
const sandboxSkillDir = (name: string): string => `${SANDBOX_SKILLS_DIR}/${name}`;
/** sbx exec's own failure (e.g. a missing sandbox); the inner command's code passes through otherwise. */
const EXEC_INFRA_EXIT = 125;

export interface SbxAdapterDeps {
  run: SbxRunner;
  realpath?: (p: string) => string;
  hostNodeMajor?: number;
  /** The host env preflight checks the model-alias names against (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Non-fatal preflight warnings (default console.error). */
  warn?: (m: string) => void;
  /** The dashboard opener's dependencies (default: the real Terminal/osascript ones). */
  dashboardDeps?: (log: (m: string) => void) => DashboardDeps;
  /** Waits between preflight GitHub retries (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** The operator's skills folder hostSkills are read from (default ~/.claude/skills). */
  hostSkillsDir?: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
/** direnv's own status lines (loading/export/unloading), which the .envrc step prints on success. */
const DIRENV_NOISE = /^direnv: (loading|export|unloading|using)\b/;
const firstLine = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.replace(ANSI, "").trim())
    .find((l) => l !== "" && !DIRENV_NOISE.test(l)) ?? "";
const why = (r: SbxResult): string => (r.timedOut ? "timeout" : String(r.code));

/** The validated sub-block select.ts passed through. Defensive: a missing kitDir is a wiring bug. */
function sbxConfig(raw: unknown): SbxConfig {
  const o = raw as Partial<SbxConfig> | null | undefined;
  if (typeof o !== "object" || o === null || typeof o.kitDir !== "string") {
    throw new Error("sandbox.sbx: no kitDir in the adapter config (was it validated?)");
  }
  return {
    kitDir: o.kitDir,
    envAllow: Array.isArray(o.envAllow) ? o.envAllow : [],
    ...(o.memory !== undefined ? { memory: o.memory } : {}),
    ...(o.template !== undefined ? { template: o.template } : {}),
    ...(Array.isArray(o.mcp) ? { mcp: o.mcp } : {}),
    hostSkills: Array.isArray(o.hostSkills) ? o.hostSkills : [],
  };
}

export function createArgs(name: string, cfg: SbxConfig, mounts: string[], extraMounts: string[] = []): string[] {
  return [
    "create", "--name", name, "--no-progress", "--no-input",
    ...(cfg.memory ? ["--memory", cfg.memory] : []),
    // Registered with `sbx mcp add` (yours to do); the sandbox can't see the host's MCP config.
    ...(cfg.mcp && cfg.mcp.length > 0 ? ["--static-mcp", cfg.mcp.join(",")] : []),
    // A saved local template must not be pulled; the kit still supplies network policy and credentials.
    ...(cfg.template ? ["-t", cfg.template, "--pull", "never"] : []),
    "claude", "--kit", cfg.kitDir, ...mounts, ...extraMounts,
  ];
}

/** Each blocked[].host, or undefined when the log isn't the expected shape. */
function blockedHosts(stdout: string): string[] | undefined {
  try {
    const log = JSON.parse(stdout) as { blocked?: unknown } | null;
    if (typeof log !== "object" || log === null || !Array.isArray(log.blocked)) return undefined;
    return log.blocked.flatMap((b) => (typeof b === "object" && b !== null && typeof (b as { host?: unknown }).host === "string" ? [(b as { host: string }).host] : []));
  } catch {
    return undefined;
  }
}

/** `example.org:443` -> `example.org`; leaves a bare host (or a bracketed IPv6 without a port) alone. */
const stripPort = (host: string): string => host.replace(/:\d+$/, "");

/**
 * A blocked host is whatever the sandboxed agent tried to reach, so it is
 * untrusted: only a plain DNS name or a bracketed IPv6 literal may go into a
 * command a human is asked to run.
 */
const HINTABLE_HOST = [/^[A-Za-z0-9.-]+$/, /^\[[0-9a-fA-F:]+\]$/];
const isHintable = (host: string): boolean => HINTABLE_HOST.some((re) => re.test(host));

export { rootEnvFiles };

/**
 * `sbx policy log --json` stdout -> the allow lines a human may run, with the same host
 * checks as inspect(). Undefined when the log isn't the expected shape.
 */
export function allowHintLines(stdout: string): string[] | undefined {
  const hosts = blockedHosts(stdout);
  if (hosts === undefined) return undefined;
  const bare = [...new Set(hosts.map(stripPort))];
  const lines = bare.filter(isHintable).map((x) => `sbx policy allow network ${x}`);
  if (bare.some((x) => !isHintable(x))) lines.push("(not shown: a blocked host with unexpected characters)");
  return lines;
}

export function makeSbxAdapter(deps: SbxAdapterDeps): SandboxAdapter {
  const { run } = deps;
  const realpath = deps.realpath ?? realpathSync.native;
  const hostNodeMajor = deps.hostNodeMajor ?? Number(process.versions.node.split(".")[0]);
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  // The handle type is adapter-neutral, so prepare remembers each handle's envAllow here for wrap.
  const handleEnvAllow = new WeakMap<SandboxHandle, string[]>();
  const skillsDir = deps.hostSkillsDir ?? join(homedir(), ".claude", "skills");
  /** Each host skill's real folder (the skills dir may be a symlink), mounted read-only. */
  const skillMounts = (cfg: SbxConfig): string[] => cfg.hostSkills.map((n) => `${realpath(join(skillsDir, n))}:${sandboxSkillDir(n)}:ro`);

  async function create(name: string, cfg: SbxConfig, mounts: string[], repoDir?: string): Promise<void> {
    const r = await run(createArgs(name, cfg, coverMounts(mounts, repoDir), skillMounts(cfg)), { timeoutMs: CREATE_TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) throw new Error(`sbx create failed (${why(r)}): ${firstLine(r.stderr)}`);
  }

  async function remove(name: string): Promise<void> {
    const r = await run(["rm", "-f", name]);
    if (r.code === 0 && !r.timedOut) return;
    if (r.stderr.includes("not found")) return;
    throw new Error(`sbx rm failed (${why(r)}): ${firstLine(r.stderr)}`);
  }

  /** Every sandbox name `sbx ls --json` reports. Throws "sbx ls failed: ..." on a failed or unparseable ls. */
  async function listNames(): Promise<string[]> {
    const r = await run(["ls", "--json"]);
    if (r.code !== 0 || r.timedOut) throw new Error(`sbx ls failed: (${why(r)}) ${firstLine(r.stderr)}`);
    try {
      const list = JSON.parse(r.stdout) as unknown;
      if (!Array.isArray(list)) throw new Error("not an array");
      return list.flatMap((s) => (typeof s === "object" && s !== null && typeof (s as { name?: unknown }).name === "string" ? [(s as { name: string }).name] : []));
    } catch (err) {
      throw new Error(`sbx ls failed: unparseable --json output (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /** Every configured MCP server is registered with sbx and ready (signed in). Fails closed. */
  async function checkMcp(names: string[]): Promise<void> {
    const r = await run(["mcp", "ls", "--json"]);
    let list: { name?: unknown; status?: unknown }[];
    try {
      if (r.timedOut || r.code !== 0) throw new Error(firstLine(r.stderr) || why(r));
      const parsed = JSON.parse(r.stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not a list");
      list = parsed as { name?: unknown; status?: unknown }[];
    } catch (err) {
      throw new Error(`sbx preflight failed (sbx mcp ls): ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const n of names) {
      const s = list.find((e) => e?.name === n);
      if (!s) throw new Error(`MCP server "${n}" is not registered with sbx: run sbx mcp add ${n} --url <url>, then sbx mcp auth ${n} (see docs/sandbox-sbx.md)`);
      if (s.status !== "ready") throw new Error(`MCP server "${n}" is ${JSON.stringify(String(s.status))}, not ready: run sbx mcp auth ${n}`);
    }
  }

  return {
    name: "sbx",

    validateConfig: (raw) => validateSbxConfig(raw),

    // sbx's MCP gateway serves every static MCP server as one `mcp-gateway`
    // server, and Atlassian's remote server there uses its v2 tool names
    // (probed live 2026-11-16: mcp__mcp-gateway__addOrEditJiraIssueComment, ...).
    atlassianMcp(config) {
      return sbxConfig(config).mcp?.includes("atlassian") ? { server: "mcp-gateway", naming: "v2" } : undefined;
    },

    hostSkillPaths(config) {
      return Object.fromEntries(sbxConfig(config).hostSkills.map((n) => [n, `${sandboxSkillDir(n)}/SKILL.md`]));
    },

    hostPush: () => true,

    onRunStart(ctx) {
      if (!ctx.dashboard) return;
      openSbxDashboard(ctx.repoRoot, (deps.dashboardDeps ?? realDashboardDeps)(ctx.log));
    },

    async preflight(ctx) {
      // sbx canonicalizes a mount's case but the container is case-sensitive.
      for (const p of [...ctx.mounts, ctx.cwd]) {
        const real = realpath(p);
        if (real !== p) {
          const fromConfig = p !== ctx.cwd ? "; if it comes from targetRepo.path, fix the case in the config" : "";
          throw new Error(`sandbox paths must match the disk's real case: "${p}" is "${real}" on disk; cd into the real path and restart${fromConfig}`);
        }
      }
      if (ctx.githubRepo !== undefined && !OWNER_REPO.test(ctx.githubRepo)) {
        throw new Error(`github.repo ${JSON.stringify(ctx.githubRepo)} is not a plain owner/repo`);
      }
      // Every mount is readable inside the sandbox. dev-loop's own folder never needs an env
      // file (DEVLOOP_ENV_FILE points outside it), so one there is refused. The target repo's
      // top folder is never mounted (coverMounts) and that is checked below; any other
      // mount's env files are only warned about.
      // A never-cloned repo has no real env file and no fake yet: nothing to check.
      const repoDir = ctx.repoDir !== undefined && existsSync(join(ctx.repoDir, ".git")) ? ctx.repoDir : undefined;
      if (repoDir !== undefined && !coverable(ctx.mounts, repoDir)) {
        // Inside another mount (the v2 clone under dev-loop's root): its top, and its app folder, can't be left out.
        const dirs = ctx.appDir && ctx.appDir !== "." ? [repoDir, join(repoDir, ctx.appDir)] : [repoDir];
        for (const dir of dirs) {
          const found = listDir(dir).filter((n) => /^\.env/i.test(n) && !n.endsWith(".example")).sort();
          if (found.length > 0) {
            throw new Error(`${found[0]} is in ${dir}, which the sandbox can read (it is inside dev-loop's folder): remove it; the robot uses the fake env`);
          }
        }
      }
      if (repoDir !== undefined && !existsSync(fakeEnvPaths(repoDir).envrc)) {
        throw new Error(`the robot's fake env is missing at ${fakeEnvPaths(repoDir).envrc}: the loop writes it at startup`);
      }
      const envrcDirs: string[] = [];
      for (const dir of new Set(ctx.mounts)) {
        const entries = listDir(dir);
        const found = entries.filter(isEnvFile).sort();
        if (found.length === 0) continue;
        if (dir === ctx.repoRoot) {
          throw new Error(`${found[0]} is in ${dir}, which the sandbox can read: move it out of the repo and point DEVLOOP_ENV_FILE at it (see docs/sandbox-sbx.md)`);
        }
        if (dir === repoDir) continue;
        if (entries.includes(".envrc")) envrcDirs.push(dir);
        warn(`note: the sandbox agent can read ${found.join(", ")} in ${dir} (expected for local dev/INT settings; keep real secrets out of it).`);
      }
      const cfg = sbxConfig(ctx.config);
      // Names only, never values.
      const unsetModels = DEFAULT_ENV_ALLOW.filter((n) => /_MODEL$/.test(n) && !env[n]);
      if (unsetModels.length > 0) {
        warn(
          `WARNING: ${unsetModels.join(", ")} not set; inside the sandbox the sonnet/opus/haiku aliases fall back to stock model ids. Set them in your DEVLOOP_ENV_FILE.`,
        );
      }
      // Missing or unreadable: same refusal as an empty dir.
      if (!listDir(cfg.kitDir).some((e) => e.endsWith(".yaml"))) throw new Error(`sandbox.sbx.kitDir "${cfg.kitDir}" has no kit yaml`);

      if (cfg.mcp && cfg.mcp.length > 0) await checkMcp(cfg.mcp);
      for (const n of cfg.hostSkills) {
        const file = join(skillsDir, n, "SKILL.md");
        if (!existsSync(file)) throw new Error(`sandbox.sbx.hostSkills: "${n}" has no SKILL.md at ${file}`);
      }

      const name = ctx.instanceName;
      try {
        try {
          await create(name, cfg, ctx.mounts, repoDir);
        } catch (err) {
          throw new Error(`sbx preflight failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const repo = ctx.githubRepo;
        const skillChecks = cfg.hostSkills.map((n) => `echo dl-step:skill && test -r ${shq(`${sandboxSkillDir(n)}/SKILL.md`)}`);
        const fakeChecks = repoDir === undefined ? [] : [`echo dl-step:allow && ${sandboxSetup(repoDir)}`, hiddenCheck(repoDir), envrcCheck(repoDir)];
        const otherEnvrc = envrcDirs.map((d) => `echo dl-step:envrc && direnv exec ${shq(d)} true`);
        const check = [TOOLS_CHECK, ...fakeChecks, ...otherEnvrc, ...skillChecks, ...(repo === undefined ? [] : [githubCheck(repo)])].join(" && ");
        let r = await run(["exec", name, "sh", "-c", check]);
        for (let tryNo = 1; tryNo < GITHUB_TRIES && repo !== undefined && flakyGithubStep(r) !== undefined; tryNo++) {
          warn(`note: sandbox GitHub check (${flakyGithubStep(r)}) failed on try ${tryNo} of ${GITHUB_TRIES}: ${firstLine(r.stderr) || "no error output"}; retrying`);
          await sleep(GITHUB_RETRY_MS);
          r = await run(["exec", name, "sh", "-c", check]);
        }
        const tries = repo !== undefined && flakyGithubStep(r) !== undefined ? GITHUB_TRIES : 1;
        // The project's Node (its version file), else the host's.
        const want = ctx.nodeMajor ?? hostNodeMajor;
        if (r.code === 0 && !r.timedOut && nodeMajor(r.stdout) === want) return;
        if (r.timedOut || r.code === EXEC_INFRA_EXIT) throw new Error(`sbx preflight failed: ${firstLine(r.stderr)}`);
        if (nodeMajor(r.stdout) !== want) {
          throw new Error(
            `sandbox image has no node ${want}: build one with npm run sbx:template:build -- --tag=v2-node${want} --node=${want} and set sandbox.sbx.template (see docs/adapters/sbx/templates.md)`,
          );
        }
        // The && chain stops at the first failure; the last line printed names the step after it.
        const last = [...r.stdout.matchAll(/^dl-step:(\w+)$/gm)].at(-1)?.[1];
        if (last === "direnv") throw new Error("sandbox image has no direnv: add it to the template (npm run sbx:template:build; see docs/sandbox-sbx.md)");
        if (last === "skill") {
          throw new Error(`a host skill (sandbox.sbx.hostSkills) is not readable inside the sandbox at ${SANDBOX_SKILLS_DIR}: check the folder exists and sbx can mount it (see docs/sandbox-sbx.md)`);
        }
        if (last === "allow") throw new Error(`could not set up the robot's fake .envrc inside the sandbox: ${firstLine(r.stderr) || why(r)}`);
        if (last === "hidden") {
          throw new Error("the target repo's real env files are visible inside the sandbox (its top folder should not be mounted); refusing to run the robot next to them");
        }
        if (last === "envrc") {
          throw new Error(
            repoDir !== undefined
              ? "the robot's fake .envrc does not load inside the sandbox: restart the loop (it rewrites the fake); see docs/sandbox-sbx.md"
              : "the target repo's .envrc is not allowed inside the sandbox (it changed, or the template predates it): rebuild the template with npm run sbx:template:build (see docs/sandbox-sbx.md)",
          );
        }
        const step = last === "gh" ? "gh api" : last === "git" ? "git" : undefined;
        if (step !== undefined && repo !== undefined) throw new Error(githubFailure(step, repo, r.stderr, r.code, tries));
        if (/^git version /m.test(r.stdout)) {
          throw new Error("sandbox image has no jq: add jq to the template (see docs/sandbox-sbx.md)");
        }
        throw new Error(`sbx preflight failed: ${firstLine(r.stderr)}`);
      } finally {
        await remove(name).catch(() => {});
      }
    },

    async cleanupOrphans({ prefix }) {
      const names = await listNames();
      for (const n of names) if (n.startsWith(prefix)) await remove(n);
    },

    resetSteps({ prefix, ticket }) {
      const mine = `${prefix}${ticket}-`;
      return [
        {
          area: "sandbox",
          name: "leftover sandboxes",
          async survey() {
            let names: string[];
            try {
              names = (await listNames()).filter((n) => n.startsWith(mine));
            } catch (err) {
              // The message already starts "sbx ls failed:"; a missing binary arrives bare.
              const m = (err instanceof Error ? err.message : String(err)).split("\n")[0];
              return { found: "unknown", action: null, needsYou: m.startsWith("sbx ls failed") ? m : `sbx ls failed: ${m}` };
            }
            if (names.length === 0) return { found: "none", action: null };
            return {
              found: names.join(", "),
              action: `remove ${names.length}`,
              async run() {
                const failures: string[] = [];
                for (const n of names) {
                  try {
                    await remove(n);
                  } catch (err) {
                    failures.push(`${n}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                if (failures.length > 0) throw new Error(`could not remove ${failures.length} sandbox(es): ${failures.join("; ")}`);
              },
            };
          },
        } satisfies ResetStep,
      ];
    },

    async prepare(spec) {
      const cfg = sbxConfig(spec.config);
      await create(spec.instanceName, cfg, spec.mounts, spec.repoDir);
      if (coverable(spec.mounts, spec.repoDir) && existsSync(fakeEnvPaths(spec.repoDir).envrc)) {
        // direnv's allow list and git's safe.directory live in the sandbox: set them in each new one.
        const r = await run(["exec", spec.instanceName, "sh", "-c", sandboxSetup(spec.repoDir)]);
        if (r.code !== 0 || r.timedOut) {
          // A rejected prepare has no handle to tear down, so remove the instance here.
          await remove(spec.instanceName).catch(() => {});
          throw new Error(`could not set up the robot's fake .envrc inside the sandbox: ${firstLine(r.stderr) || why(r)}`);
        }
      }
      const h: SandboxHandle = { adapter: "sbx", instanceName: spec.instanceName };
      handleEnvAllow.set(h, cfg.envAllow);
      return h;
    },

    wrap(h, cmd, args, opts) {
      // Env passes by NAME only; sbx exec reads each value from its own env (opts.env).
      const envAllow = handleEnvAllow.get(h) ?? [];
      const envArgs = envAllow.filter((n) => n in opts.env).flatMap((n) => ["-e", n]);
      const cwdArgs = opts.cwd !== undefined ? ["-w", String(opts.cwd)] : [];
      return { cmd: "sbx", args: ["exec", ...cwdArgs, ...envArgs, h.instanceName, cmd, ...args], opts };
    },

    async inspect(h, exitCode) {
      const denied: SandboxDenial[] = [];
      if (exitCode === EXEC_INFRA_EXIT) denied.push({ kind: "infra", target: "sbx exec" });
      // policy log still answers for a removed sandbox, so this works after teardown.
      const r = await run(["policy", "log", h.instanceName, "--json"]);
      const hosts = r.code === 0 && !r.timedOut ? blockedHosts(r.stdout) : undefined;
      if (hosts === undefined) {
        denied.push({ kind: "infra", target: "policy log" });
        return { denied };
      }
      for (const host of new Set(hosts)) denied.push({ kind: "network", target: host });
      if (hosts.length === 0) return { denied };
      const bare = [...new Set(hosts.map(stripPort))];
      const lines = bare.filter(isHintable).map((x) => `sbx policy allow network ${x}`);
      if (bare.some((x) => !isHintable(x))) {
        lines.push(`(not shown: a blocked host with unexpected characters; see sbx policy log ${h.instanceName})`);
      }
      return { denied, approveHint: [APPROVE_HEADING, ...lines].join("\n") };
    },

    teardown: (h) => remove(h.instanceName),
  };
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Turns a failed GitHub step into the fix: firewall, token access, or the SSH rewrite. */
/** The GitHub step a failed check stopped at, when the failure is not one githubFailure diagnoses. */
function flakyGithubStep(r: SbxResult): "git" | "gh api" | undefined {
  if (r.code === 0 && !r.timedOut) return undefined;
  if (r.code === EXEC_INFRA_EXIT) return undefined;
  const last = [...r.stdout.matchAll(/^dl-step:(\w+)$/gm)].at(-1)?.[1];
  const step = last === "gh" ? "gh api" : last === "git" ? "git" : undefined;
  if (step === undefined) return undefined;
  return DIAGNOSED.some((re) => re.test(r.stderr)) ? undefined : step;
}

/** Failures githubFailure names a specific fix for: retrying never helps them. */
const DIAGNOSED = [/Approval required for/, /Not Found|HTTP 404|repository not found/i, /Permission denied \(publickey\)|Host key verification failed|ssh:/i];

function githubFailure(step: "git" | "gh api", repo: string, stderr: string, code?: number | null, tries = 1): string {
  const blocked = /Approval required for ([A-Za-z0-9.-]+)/.exec(stderr);
  if (blocked) {
    const host = blocked[1];
    return `sandbox network blocked ${host} (${step}): approve it yourself with sbx policy approval ls, or sbx policy allow network ${host} (see docs/sandbox-sbx.md)`;
  }
  if (/Not Found|HTTP 404|repository not found/i.test(stderr)) {
    return `the sandbox's GitHub token cannot see ${repo} (${step}): check its repo access and any pending org approval, then sbx secret set github (see docs/sandbox-sbx.md)`;
  }
  if (/Permission denied \(publickey\)|Host key verification failed|ssh:/i.test(stderr)) {
    return 'git uses SSH inside the sandbox: add git config --global url."https://github.com/".insteadOf git@github.com: to the template (see docs/sandbox-sbx.md)';
  }
  const after = tries > 1 ? ` after ${tries} tries` : "";
  return `sbx preflight failed (${step})${after}: ${firstLine(stderr) || `exit ${code ?? "?"}, no error output`}`;
}

function nodeMajor(stdout: string): number | undefined {
  const m = /^v(\d+)\./m.exec(stdout);
  return m ? Number(m[1]) : undefined;
}
