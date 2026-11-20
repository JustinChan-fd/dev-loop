// Root-level env files a person keeps in a checkout (.env, .envrc, .env.*),
// never the committed `*.example` templates. Both the no-sandbox Read deny
// (skill-runner) and a sandbox adapter that covers them use this one rule.

import { readdirSync } from "node:fs";

const ENV_FILE = /^\.env(rc)?(\..+)?$/;

/** Names safe in a permission rule (no space, colon or glob). */
const SAFE_NAME = /^[A-Za-z0-9@._+-]+$/;

/**
 * Names a fake/robot env must never set: they change how commands run, not
 * what the app reads. Shared by the fake env parser and config validation.
 */
export const NEVER_OVERRIDE = /^(PATH|HOME|SHELL|USER|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LD_.*|DYLD_.*|DIRENV_.*|GIT_.*)$/;

export const isEnvFile = (n: string): boolean => ENV_FILE.test(n) && !n.endsWith(".example");


/** The env files at the top of `dir` (sorted); a missing or unreadable dir has none. */
export function rootEnvFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => isEnvFile(n) && SAFE_NAME.test(n)).sort();
  } catch {
    return [];
  }
}
