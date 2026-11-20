// The robot's fake env. Worktrees sit under <REPO_DIR>/.claude/worktrees/,
// and `direnv exec <worktree>` loads the first .envrc found walking up. The
// loop writes one there, built from the committed .envrc.example, so direnv
// stops at it and never reaches the person's real <REPO_DIR>/.envrc.
//
// The example is parsed as text, never executed: only `export NAME=VALUE`
// lines are kept, and every value is written back single-quoted, so `$(...)`
// stays literal.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NEVER_OVERRIDE } from "./env-files.ts";

export const FAKE_ENV_MARKER = "# dev-loop fake env: generated from .envrc.example, never real values";

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

/** Names that change how every command runs; an example never overrides them for the robot. */

export function parseEnvExample(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = EXPORT_LINE.exec(line);
    if (!m || NEVER_OVERRIDE.test(m[1])) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) {
      // A quoted value ends at its closing quote; anything after (a `# note`) is dropped.
      v = v.slice(1, v.indexOf(q, 1));
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out.push([m[1], v]);
  }
  return out;
}

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

export function renderFakeEnvrc(entries: Array<[string, string]>, repoDir: string): string {
  const real = sq(join(repoDir, ".envrc"));
  return [
    FAKE_ENV_MARKER,
    "# Not the robot (a person's own worktree here): use the real .envrc. A sandbox never has it.",
    `if [ -z "\${${ROBOT_ENV_VAR}:-}" ] && [ -f ${real} ]; then`,
    `  source_env ${real}`,
    "  return 0",
    "fi",
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

/**
 * Writes the fake .envrc, then allows it with
 * direnv. No example on origin (or git failing) gives a marker-only fake;
 * direnv missing gives `allowed: false`. Never throws for either. A repo dir
 * with no .git yet is skipped: creating .claude/worktrees there would make
 * the skill's `git clone` into it fail. The next run after the clone writes it.
 */
export async function writeFakeEnv(
  repoDir: string,
  defaultBranch: string,
  d: FakeEnvDeps,
): Promise<{ names: string[]; allowed: boolean; skipped: boolean }> {
  if (!existsSync(join(repoDir, ".git"))) return { names: [], allowed: false, skipped: true };
  let example = "";
  try {
    example = await d.git(["show", `origin/${defaultBranch}:.envrc.example`], repoDir);
  } catch {
    example = "";
  }
  const entries = parseEnvExample(example);
  const p = fakeEnvPaths(repoDir);
  await mkdir(join(repoDir, ".claude", "worktrees"), { recursive: true });
  await writeIfChanged(p.envrc, renderFakeEnvrc(entries, repoDir));
  let allowed = true;
  try {
    await d.direnvAllow(p.envrc);
  } catch {
    allowed = false;
  }
  return { names: entries.map(([n]) => n), allowed, skipped: false };
}

/** The startup log line for writeFakeEnv's result. Names a count, never values. */
export function fakeEnvSummary(r: { names: string[]; allowed: boolean; skipped: boolean }): string {
  if (r.skipped) return "robot env: repo not cloned yet; the fake is written on the first run after the clone";
  return `robot env: ${r.names.length} fake setting(s) from .envrc.example${r.allowed ? "" : " (direnv allow failed; is direnv installed?)"}`;
}
