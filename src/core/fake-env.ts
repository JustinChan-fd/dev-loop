// The robot's fake env. Worktrees sit under <REPO_DIR>/.claude/worktrees/,
// and `direnv exec <worktree>` (or <worktree>/<appDir>) loads the first
// .envrc found walking up. The loop writes one there, built from the
// project's committed env template (targetRepo.local.envTemplate; default
// .envrc.example), so direnv stops at it and never reaches the person's real
// <REPO_DIR>/.envrc.
//
// The template is parsed as text, never executed: only NAME=VALUE lines
// (with `export ` for the export format) are kept, and every value is
// written back single-quoted, so `$(...)` stays literal.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NEVER_OVERRIDE } from "./env-files.ts";
import type { ResolvedProfile } from "./project-profile.ts";
import type { EnvTemplateFormat } from "./types.ts";

export const FAKE_ENV_MARKER = "# dev-loop fake env: generated from the project's env template, never real values";

/**
 * Set to "1" in every robot spawn's env (skill-runner). Without it, the fake
 * hands over to the person's real <REPO_DIR>/.envrc, so a person's own
 * worktree in .claude/worktrees/ (e.g. okta-wave-1) keeps its real env. A
 * sandbox never mounts the real file, so the handover can't fire there. With
 * no sandbox this is the same soft line as the Read deny: a robot
 * that unsets the variable gets the real env.
 */
export const ROBOT_ENV_VAR = "DEVLOOP_ROBOT_ENV";

export function fakeEnvPaths(repoDir: string): { envrc: string } {
  return { envrc: join(repoDir, ".claude", "worktrees", ".envrc") };
}

const EXPORT_LINE = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** A value as written: matching quotes unwrapped (a `# note` after them dropped), else a trailing ` # note` dropped. */
function cleanValue(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) return v.slice(1, v.indexOf(q, 1));
  return v.replace(/\s+#.*$/, "");
}

/**
 * The NAME=value entries of an env template. `export`: only `export NAME=…`
 * lines (direnv's .envrc.example). `dotenv`: plain `NAME=…` lines, an
 * optional `export ` prefix allowed. Comment lines and names that change how
 * commands run (NEVER_OVERRIDE) are dropped either way.
 */
export function parseEnvTemplate(text: string, format: EnvTemplateFormat): Array<[string, string]> {
  const re = format === "dotenv" ? DOTENV_LINE : EXPORT_LINE;
  const out: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m || NEVER_OVERRIDE.test(m[1])) continue;
    out.push([m[1], cleanValue(m[2])]);
  }
  return out;
}

/** The export-format parser (.envrc.example). */
export const parseEnvExample = (text: string): Array<[string, string]> => parseEnvTemplate(text, "export");

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * The fake .envrc. A shell without DEVLOOP_ROBOT_ENV (a person's own
 * worktree under .claude/worktrees/) gets the real root .envrc if there is
 * one, and never the fake: in a repo with no root .envrc (an app/.env.local
 * project) the fake would otherwise override the person's real settings.
 * `nodeBin` (the project's Node on the host) goes on PATH for the robot only;
 * the `[ -d ]` guard makes it a no-op inside a sandbox.
 */
export function renderFakeEnvrc(entries: Array<[string, string]>, repoDir: string, nodeBin?: string | null): string {
  const real = sq(join(repoDir, ".envrc"));
  return [
    FAKE_ENV_MARKER,
    "# Not the robot (a person's own worktree here): never the fake. Their real root .envrc if any; else nothing.",
    `if [ -z "\${${ROBOT_ENV_VAR}:-}" ]; then`,
    `  [ -f ${real} ] && source_env ${real}`,
    "  return 0",
    "fi",
    ...(nodeBin ? [`[ -d ${sq(nodeBin)} ] && PATH_add ${sq(nodeBin)}`] : []),
    ...entries.map(([n, v]) => `export ${n}=${sq(v)}`),
  ].join("\n") + "\n";
}

export interface FakeEnvDeps {
  git(args: string[], cwd: string): Promise<string>;
  direnvAllow(path: string): Promise<void>;
}

const exec = (cmd: string, args: string[]): Promise<string> =>
  new Promise((res, rej) => execFile(cmd, args, { timeout: 30_000 }, (err, stdout) => (err ? rej(err) : res(String(stdout)))));

export const realFakeEnvDeps: FakeEnvDeps = {
  git: (args, cwd) => exec("git", ["-C", cwd, ...args]),
  direnvAllow: async (p) => void (await exec("direnv", ["allow", p])),
};

/** Writes `path` only when its content changed, via a temp file and rename. */
async function writeIfChanged(path: string, content: string): Promise<void> {
  const old = await readFile(path, "utf8").catch(() => null);
  if (old === content) return;
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, { mode: 0o644 });
  await rename(tmp, path);
}

export type FakeEnvProfile = Pick<ResolvedProfile, "envTemplate" | "robotEnv" | "nodeBin">;

export interface FakeEnvResult {
  names: string[];
  allowed: boolean;
  skipped: boolean;
  /** The template path the names came from. */
  template: string;
  nodeBin?: string | null;
}

/**
 * Writes the fake .envrc from the profile's template on origin, plus its
 * robotEnv (which wins), then allows it with direnv. No template on origin
 * (or git failing) gives a fake with robotEnv only; direnv missing gives
 * `allowed: false`. Never throws for either. A repo dir with no .git yet is
 * skipped: creating .claude/worktrees there would make the skill's `git
 * clone` into it fail. The next run after the clone writes it.
 */
export async function writeFakeEnv(
  repoDir: string,
  defaultBranch: string,
  profile: FakeEnvProfile,
  d: FakeEnvDeps,
): Promise<FakeEnvResult> {
  const template = profile.envTemplate.path;
  if (!existsSync(join(repoDir, ".git"))) return { names: [], allowed: false, skipped: true, template };
  let text = "";
  try {
    text = await d.git(["show", `origin/${defaultBranch}:${template}`], repoDir);
  } catch {
    text = "";
  }
  const merged = new Map(parseEnvTemplate(text, profile.envTemplate.format));
  for (const [n, v] of Object.entries(profile.robotEnv)) merged.set(n, v);
  const entries = [...merged];
  const p = fakeEnvPaths(repoDir);
  await mkdir(join(repoDir, ".claude", "worktrees"), { recursive: true });
  await writeIfChanged(p.envrc, renderFakeEnvrc(entries, repoDir, profile.nodeBin));
  let allowed = true;
  try {
    await d.direnvAllow(p.envrc);
  } catch {
    allowed = false;
  }
  return { names: entries.map(([n]) => n), allowed, skipped: false, template, ...(profile.nodeBin ? { nodeBin: profile.nodeBin } : {}) };
}

/** The startup log line for writeFakeEnv's result. Names a count, never values. */
export function fakeEnvSummary(r: FakeEnvResult): string {
  if (r.skipped) return "robot env: repo not cloned yet; the fake is written on the first run after the clone";
  return (
    `robot env: ${r.names.length} fake setting(s) from ${r.template}` +
    (r.nodeBin ? `, node from ${r.nodeBin}` : "") +
    (r.allowed ? "" : " (direnv allow failed; is direnv installed?)")
  );
}
