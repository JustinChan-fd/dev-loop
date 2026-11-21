// The fixture spawn's leak guard (eval fixtures). A fixture run must never
// reach Jira or GitHub, so the spawn gets:
//   - the built-in tools only (no mcp__* tool in --allowedTools);
//   - permissions.deny for the Atlassian servers, gh, curl and the web;
//   - DEVLOOP_EVAL_KEYS="" (block-non-eval-jira-writes.sh then denies every
//     Atlassian write), GH_TOKEN/GITHUB_TOKEN unset and GH_CONFIG_DIR at an
//     empty folder, so even a gh call that got through has no auth.
// A Bash(gh:*) rule does not catch `cd x && gh ...` or a script calling
// api.github.com: the stripped auth covers those, and a real hook is a
// follow-up (spec, call 5). Pure.

import { isAbsolute } from "node:path";

export const FIXTURE_ALLOWED_TOOLS = "Bash,Read,Grep,Glob";

export const FIXTURE_DENY: readonly string[] = [
  "mcp__atlassian",
  "mcp__claude_ai_Atlassian",
  "Bash(gh:*)",
  "Bash(curl:*)",
  "WebFetch",
  "WebSearch",
];

export function fixtureSpawnGuard(base: { allowedTools: string; env: NodeJS.ProcessEnv }, ghConfigDir: string): { allowedTools: string; denyTools: string[]; env: NodeJS.ProcessEnv } {
  if (!isAbsolute(ghConfigDir)) throw new Error(`fixture guard: GH_CONFIG_DIR ${JSON.stringify(ghConfigDir)} must be absolute`);
  const env: NodeJS.ProcessEnv = { ...base.env, DEVLOOP_EVAL_KEYS: "", GH_CONFIG_DIR: ghConfigDir };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return { allowedTools: FIXTURE_ALLOWED_TOOLS, denyTools: [...FIXTURE_DENY], env };
}
