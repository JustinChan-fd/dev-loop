// The fixture spawn's leak guard (eval fixtures). A fixture run must never
// reach Jira or GitHub, so the spawn gets:
//   - the built-in tools only (no mcp__* tool in --allowedTools);
//   - permissions.deny for the Atlassian servers, gh, curl and the web;
//   - DEVLOOP_EVAL_KEYS="" (block-non-eval-jira-writes.sh then denies every
//     Atlassian write), GH_TOKEN/GITHUB_TOKEN unset and GH_CONFIG_DIR at an
//     empty folder, so even a gh call that got through has no auth;
//   - git with no way to authenticate: every credential helper cleared
//     (GIT_CONFIG_COUNT: credential.helper=""), no system config, no
//     prompt or askpass, no SSH agent, and GIT_SSH_COMMAND=/bin/false. The
//     pinned worktree's origin is the real repo, so a `git push` or a
//     `git credential fill` must find nothing to use.
// A Bash(gh:*) rule only matches a command that starts with gh, not
// `cd x && gh ...` or a script calling api.github.com: the stripped auth
// covers those, and a real hook is a follow-up (spec, call 5). Pure.

import { isAbsolute } from "node:path";

export const FIXTURE_ALLOWED_TOOLS = "Bash,Read,Grep,Glob";

export const FIXTURE_DENY: readonly string[] = [
  "mcp__atlassian",
  "mcp__claude_ai_Atlassian",
  "Bash(gh:*)",
  "Bash(curl:*)",
  "Bash(git push:*)",
  "Bash(git credential:*)",
  "WebFetch",
  "WebSearch",
];

export function fixtureSpawnGuard(base: { allowedTools: string; env: NodeJS.ProcessEnv }, ghConfigDir: string): { allowedTools: string; denyTools: string[]; env: NodeJS.ProcessEnv } {
  if (!isAbsolute(ghConfigDir)) throw new Error(`fixture guard: GH_CONFIG_DIR ${JSON.stringify(ghConfigDir)} must be absolute`);
  const env: NodeJS.ProcessEnv = {
    ...base.env,
    DEVLOOP_EVAL_KEYS: "",
    GH_CONFIG_DIR: ghConfigDir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_SSH_COMMAND: "/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"]) delete env[k];
  return { allowedTools: FIXTURE_ALLOWED_TOOLS, denyTools: [...FIXTURE_DENY], env };
}
