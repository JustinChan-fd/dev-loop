// The project profile, resolved once at startup: targetRepo.local's
// defaults filled (localProfile), plus the facts only the host can answer --
// the project's Node major (from its version file on origin/<default>) and
// the matching host nvm install's bin. Everything that used to assume
// "repo root + host Node" reads this: the fake env, the skill runner's Read
// deny and RUN_DIR/project.json, the sandbox preflight, and host push.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localProfile } from "./config.ts";
import type { Config, LocalProfile } from "./types.ts";

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export interface ResolvedProfile extends LocalProfile {
  /** The project's Node major; the host's when there is no version file. */
  nodeMajor: number;
  /** Absolute host nvm bin dir for nodeMajor; null when there is no version file (host Node as-is). */
  nodeBin: string | null;
}

export interface ProfileDeps {
  git(args: string[], cwd: string): Promise<string>;
  nvmDir: string;
  readdir(p: string): string[];
  hostNodeMajor: number;
}

/** "26", "v26", "26.7.0" -> 26. Anything else (lts/iron, node, empty) is an error naming the file. */
export function parseNodeMajor(text: string, file: string): number {
  const m = /^v?(\d+)(\.\d+){0,2}$/.exec(text.trim());
  if (!m) throw new ProfileError(`${file} must name a Node version as a number (e.g. 26 or v26.7.0), got ${JSON.stringify(text.trim())}`);
  return Number(m[1]);
}

/** The newest host nvm install of `major` (numeric sort), as its bin dir. */
export function resolveHostNodeBin(major: number, d: Pick<ProfileDeps, "nvmDir" | "readdir">, file: string): string {
  const root = join(d.nvmDir, "versions", "node");
  let names: string[] = [];
  try {
    names = d.readdir(root);
  } catch {
    names = [];
  }
  const found = names
    .map((n) => ({ n, m: /^v(\d+)\.(\d+)\.(\d+)$/.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null && Number(x.m[1]) === major)
    .sort((a, b) => Number(b.m[2]) - Number(a.m[2]) || Number(b.m[3]) - Number(a.m[3]));
  if (found.length === 0) {
    throw new ProfileError(`node ${major} (from ${file}) is not installed: run \`nvm install ${major}\``);
  }
  return join(root, found[0].n, "bin");
}

export async function resolveProjectProfile(config: Config, repoDir: string, d: ProfileDeps): Promise<ResolvedProfile> {
  const base = localProfile(config);
  const host: ResolvedProfile = { ...base, nodeMajor: d.hostNodeMajor, nodeBin: null };
  if (base.versionFile === null) return host;
  const branch = config.targetRepo.defaultBranch;
  // Not cloned yet: the project's Node can't be read, and host Node would be a silent guess.
  if (!existsSync(join(repoDir, ".git"))) {
    throw new ProfileError(
      `${repoDir} has no clone yet: clone ${config.targetRepo.url} there first (the project's Node comes from ${base.versionFile} on origin/${branch})`,
    );
  }
  let text: string;
  try {
    text = await d.git(["show", `origin/${branch}:${base.versionFile}`], repoDir);
  } catch {
    throw new ProfileError(`${base.versionFile} is not on origin/${branch} (targetRepo.local.node.versionFile): fetch, or fix the config`);
  }
  const nodeMajor = parseNodeMajor(text, base.versionFile);
  return { ...base, nodeMajor, nodeBin: resolveHostNodeBin(nodeMajor, d, base.versionFile) };
}

/** RUN_DIR/project.json: what the skills read instead of guessing. */
export function projectJson(p: ResolvedProfile): { appDir: string; nodeMajor: number; devCommand: string; devUrl: string } {
  return { appDir: p.appDir, nodeMajor: p.nodeMajor, devCommand: p.devCommand, devUrl: p.devUrl };
}

export const realProfileDeps: ProfileDeps = {
  git: (args, cwd) =>
    new Promise((res, rej) =>
      execFile("git", ["-C", cwd, ...args], { timeout: 30_000 }, (err, stdout) => (err ? rej(err) : res(String(stdout)))),
    ),
  nvmDir: process.env.NVM_DIR ?? join(homedir(), ".nvm"),
  readdir: (p) => readdirSync(p),
  hostNodeMajor: Number(process.versions.node.split(".")[0]),
};
