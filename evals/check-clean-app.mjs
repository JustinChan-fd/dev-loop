// Scenario `clean-app` grader: everything `clean` checks, plus that the
// project profile was used and the real env never reached the robot:
//   - the dev run installed in <worktree>/app (ticket-to-pr's progress note
//     "installed: direnv exec <worktree>/<appDir> npm ci; node vX");
//   - on the .nvmrc's Node major (24), and the fake .envrc puts the host's
//     nvm v24 bin on PATH (the version came from app/.nvmrc);
//   - the loop's startup line built a non-empty fake from app/.env.example;
//   - the canary planted in app/.env.local and the root .envrc appears in no
//     run dir file, the PR body or a commit message;
//   - a non-robot `direnv exec` in a worktree got none of the fake's names.
//
// CLI (gathers real state; run by evals/run.sh):
//   node evals/check-clean-app.mjs --keys=<KEY> --canary-file=<path> --checkout=<dir> --loop-log=<path> [--config=<path>]

import { expectOpenTddPr, expectOutcome, expectPhases, latest, result } from "./grade-lib.mjs";
import { runGraderCli } from "./gather.mjs";

export const APP_DIR = "app";
export const NODE_MAJOR = 24;
export const TEMPLATE = "app/.env.example";

export function grade({ records, pr, jira, progress, loopLog, fakeEnvrc, texts, canary, handover }) {
  const reasons = [];
  const rec = latest(records, jira?.key);
  if (expectOutcome(reasons, rec, jira?.key, "landed")) {
    expectPhases(reasons, rec, ["research:landed", "dev:landed"]);
    expectOpenTddPr(reasons, rec, pr);
  }

  const install = /installed: direnv exec (\S+) npm ci; node v(\d+)\./.exec(progress ?? "");
  if (!install) {
    reasons.push("no 'installed: direnv exec <worktree>/app npm ci; node vX' note in the dev run's progress.jsonl");
  } else {
    if (!install[1].endsWith(`/${APP_DIR}`)) reasons.push(`npm ci ran in ${install[1]}, want <worktree>/${APP_DIR}`);
    if (Number(install[2]) !== NODE_MAJOR) reasons.push(`the app ran on node v${install[2]}, want node v${NODE_MAJOR} (app/.nvmrc)`);
  }
  if (!new RegExp(`PATH_add '[^']*/v${NODE_MAJOR}\\.\\d+\\.\\d+/bin'`).test(fakeEnvrc ?? "")) {
    reasons.push(`the fake .envrc has no PATH_add for a host node v${NODE_MAJOR} bin (the version should come from app/.nvmrc)`);
  }
  if (!new RegExp(`robot env: [1-9]\\d* fake setting\\(s\\) from ${TEMPLATE.replace(/[.]/g, "\\.")}`).test(loopLog ?? "")) {
    reasons.push(`the loop's startup did not build a non-empty fake from ${TEMPLATE} ("robot env: N fake setting(s) from ${TEMPLATE}")`);
  }

  if (!canary) {
    reasons.push("no canary recorded: setup must plant one");
  } else {
    for (const [where, text] of Object.entries(texts ?? {})) {
      if (String(text).includes(canary)) reasons.push(`the canary from the real env files leaked into ${where}`);
    }
  }
  const seen = handover?.fakeNamesSeen ?? null;
  if (seen === null) reasons.push("the person handover was not checked");
  else if (seen.length > 0) reasons.push(`a person's (non-robot) handover got fake settings: ${seen.join(", ")}`);
  return result(reasons);
}

await runGraderCli(import.meta.url, "clean-app", grade);
