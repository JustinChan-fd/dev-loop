# Eval fixtures: research evals without real tickets

Status: DRAFT, written overnight 2026-11-21 (no human in the loop). The user reviews it in the morning. Every decision made without the user is under "Calls made overnight" below.
Input: `eval-fixtures-research/README.md` (three read-only design agents, 2026-11-20). Plan: `docs/superpowers/plans/2026-11-20-eval-fixtures.md`.

## Calls made overnight

1. **The `3be2731f` pin is UNVERIFIED.** catalog-ui-management is not in the overnight sandbox. `evals/fixtures/mc-1435-xl/repo.json` has `"verified": false`, and the runner refuses an unverified pin. To confirm it on the host (read-only):
   `git -C ~/Desktop/Repos/catalog-ui-management log -1 --format='%H %P' 7521af60`
   The second field (the parent) should start with `3be2731f`. Then write the full 40-char sha into `repo.json` and set `"verified": true`.
2. **mc-1718's pin is also UNVERIFIED.** Its run never recorded the base commit (there was no `repo-head.json` then). The pin is the commit `origin/main` was on when the run started, 2026-11-21T04:10:45Z:
   `git -C ~/Desktop/Repos/catalog-ui-management rev-list -1 --before=2026-11-21T04:10:45Z origin/main`
   Until that is filled in, the fixture holds `"sha": null`.
3. **No `ticket.json` is committed for either fixture yet.** The raw description lives only in Jira, and the sandbox has no Jira. Both fixtures use the same text: MC-1718 is a clone of MC-1435's description as it was when it bounced at 16:08 PT (CHANGELOG, bounce criteria v2 live check). So `npm run fixture:save -- MC-1718 --name=mc-1718` gives mc-1718's ticket, and the same file, copied, gives mc-1435-xl's. Each fixture folder has a `PENDING.md` with the exact commands. The runner refuses a fixture with no `ticket.json`, or one with `reviewed: false`.
4. **The replay tests are built from the four real runs on the host**, not invented ones. They are MC-1435's three research runs (too_large with no grounding, spec_ambiguous, and ready without `attachment_coverage`) and MC-1718's ready run. Only `verdict.json`, `progress.jsonl` and `attachments.json` are copied. Absolute paths become `attachments/<file>`, so the home folder (an email address) is not committed.
5. **The leak guard is deny rules plus a stripped env, not a new `.claude/hooks` script.** The brief asks for "a fixture-only hook that denies any Bash command naming `gh` or `api.github.com`". `.claude/` is off limits overnight unless needed, and a hook is mostly redundant here. The fixture spawn already gets all of these:
   - no `mcp__*` tool in `--allowedTools`;
   - `permissions.deny` for `mcp__atlassian`, `Bash(gh:*)`, `Bash(curl:*)` and `WebFetch`;
   - `DEVLOOP_EVAL_KEYS=""`, which makes the existing `block-non-eval-jira-writes.sh` deny every Atlassian write;
   - `GH_TOKEN` and `GITHUB_TOKEN` unset, and `GH_CONFIG_DIR` set to an empty folder, so even a `gh` that got through has no auth.

   The deny list is a pure, tested function. A real hook (which also catches `cd x && gh ...` and `api.github.com` inside a script) stays a follow-up in `docs/future-enhancements.md`. **The live runner refuses to run until that hook exists:** see call 9.
6. **The SKILL.md change is in this branch** (one `## Fixture mode` section after `## Arguments`, and one line in `recon-agent.md`). The brief needs it, so `.claude/` is touched. Without it, a fixture run's skill would go to Jira for the ticket.
7. **`fixture:save` reads Jira through its own small read-only REST reader** (`src/eval/jira-read.ts`: issue fields, comments, attachments), not new `JiraClient` methods. That keeps the worker's interface unchanged.
8. **Fixture runs log to `runs/v2/fixtures/<fixture>.jsonl`** with their own line shape (`FixtureRunLine`), not `IterationRecord`. Nothing that reads `runs/v2/<project>.jsonl` (size context, reconcile, reset) ever sees a fixture run.
9. **The live runner is built, tested with an injected spawn, and wired into `npm run eval -- --fixture=<name>`, but it refuses live mode for now.** No live fixture run has happened, and live runs are banned overnight. The refusal names what's missing: the guard hook (call 5) and a person's first watched run. Dry mode prints the plan: the fixture, the pinned commit, the run folders, and the tools and env the spawn would get. The morning change that lifts the refusal is one line in `fixture-run.ts` (`LIVE_ENABLED`) plus the hook.
10. **The pinned worktree is made by the loop on the host** (option (b) in the research). It goes at `<REPO_DIR>/.claude/worktrees/FX-<n>-<RUN_ID>-ground`, a name `isPipelineWorktree` already recognizes, so reset and cleanup handle it. It is removed in a `finally`.

No question changes *what* gets built, so nothing stopped.

## Goal

Run ticket-refine against a ticket kept in local files, with nothing created or changed on Jira or GitHub, and grade the result. Two uses:

- **Replay tests (free, in `npm test`).** Saved real run folders go through the loop's own verdict checks (`checkResearchVerdict`) and the grader. A rule change that would have treated a real run differently fails a test.
- **Live fixture runs (paid, later).** `npm run eval -- --fixture=<name> --runs=3` runs research N times on the same input and reports a pass rate. This is how a SKILL.md or stance change gets measured before it reaches a real ticket.

## Fixture folder

`evals/fixtures/<name>/`:

| File | What | Who writes it |
|---|---|---|
| `ticket.json` | the ticket: `key` (fake, `FX-<n>`), `summary`, `issue_type`, `description` (plain text or markdown), `comments[]` (`id`, `author`, `is_pipeline`, `created`, `body`), `github` (mirror Issue: `title`, `comments[]`, `not_planned[]`), `linked{KEY: {summary, description, comments}}`, `prior_tickets[]`, `attachments[]` (metadata: `id`, `filename`, `size`, `mimeType`), `reviewed` | `fixture:save`, then a person (sets `reviewed: true`) |
| `attachments/` | the attachment files named in `ticket.json` | `fixture:save` |
| `repo.json` | `project` (a `pipeline.<project>.config.json` name), `sha` (7 to 40 hex, or null), `verified`, `verify_cmd` | a person |
| `expect.json` | the facts to grade (see Grader) | a person |

All data, all JSON. The types, validators, grader, runner and `fixture:save` are TypeScript under `src/eval/`, with tests.

An attachment named in `ticket.json` with no file in `attachments/` becomes a `failed` entry in `attachments.json`. That is a deliberate way to test the unreadable-attachment rule.

## Replay tests

`test/fixtures/replay/<name>/` holds `verdict.json`, `progress.jsonl` (optional), `attachments.json` (optional) and `expected.json`:

```json
{ "coverageWarnsSoFar": 0, "check": { "action": "refuse", "check": "too_large_ungrounded" }, "grade": { "expect": { ... }, "pass": false } }
```

`test/roles/research/verdict-replay.test.ts` reads every folder. Each one goes through `parseVerdict` → `readResearchFacts` → `checkResearchVerdict`, and the action and check must match `expected.json`. If `grade` is present, `gradeRun` is run against that inline expectation too. First four:

| Replay | Real run | Expected check |
|---|---|---|
| `mc-1435-xl-ungrounded` | MC-1435 research-20261121T002720Z: too_large after 86 s, no ground phase_end | refuse `too_large_ungrounded` |
| `mc-1435-unreadable-attachment` | research-20261121T004235Z: spec_ambiguous over an unreadable attachment | accept |
| `mc-1435-ready-no-coverage` | research-20261121T005530Z: ready, 3 fetched attachments, no `attachment_coverage` | accept with `coverage_warned` at 0 warns; refuse `coverage_missing` at 5 |
| `mc-1718-ready` | MC-1718 research-20261121T041045Z: ready, all 3 attachments covered | accept |

## Grader

`src/eval/grade-fixture.ts`. Pure, keeps the evals' `{pass, reasons}` shape.

`Expectation` (every field optional):

- `outcomes: ("ready"|"bounced"|"error")[]`: the verdict's outcome must be one of these.
- `failureCategory: {allow?: string[], forbid?: string[]}`.
- `loopAction: ("accept"|"refuse"|"bounce_blocked")[]`: what `checkResearchVerdict` did.
- `forbidVerdictCheck: VerdictCheck[]`.
- `groundedBeforeScope: boolean`: a `ground` `phase_end` comes before the first `scope` line (`phaseEndsBefore`).
- `coverageComplete: boolean`: every fetched attachment is in `attachment_coverage`.
- `sizeEstimate: TShirtSize[]`.
- `acCount: {min?, max?}`.
- `outbox: {publishedSpec?: boolean, forbid?: string[], require?: string[]}`: regexes (`/.../flags` or plain text, case-insensitive) checked against every outbox file. `forbid` always includes `/spec wins/i` unless `allowSpecWins: true`.
- `maxCostUsd: number`.
- `passRate: number` (0 to 1, default 1): used by `aggregate`.

Functions:

- `validateExpectation(raw) -> {ok, expectation} | {ok: false, errors}`.
- `gradeRun(exp, run) -> {pass, reasons}`, where `run` is `{verdict, check, progressRaw, manifest, outbox: {file, text}[], costUsd}`.
- `aggregate(exp, grades) -> {pass, passRate, runs, reasons}`.
- `phaseEndsBefore(progressRaw, a, b)`.

It reuses `checkResearchVerdict`, `groundCompleted` and `parseVerdict`. It never re-implements them.

## Fixture runs

### Entry point

`src/eval/fixture-run.ts`, a separate CLI, not a flag on `main.ts`. It skips the session lock, the claim, the iteration log, the label swap and the mirror Issue. Per run:

1. Load and validate the fixture (`loadFixture`): `ticket.json` must be present and `reviewed: true`, and `repo.json` must be `verified: true` with a sha. Any problem refuses the whole command before anything runs.
2. Create the run folder: `v2FixtureRunDir(fixture, key, runId)` = `.pipeline/v2/fixtures/<fixture>/<FX-n>/research-<runId>`. Then copy `ticket.json` into it, write `project.json` from the pinned profile, write `size-context.json` from `expect.json`'s optional `sizeContext` (default: the project's limits with no tickets), and write `attachments.json` by running `fetchAttachments` with local `AttachmentDeps` that read `attachments/`.
3. Pin the repo (`pinWorktree`, below) and write `repo-head.json`.
4. Spawn through `makeRunSkill` (no `beforeRun`, no Jira attachments), with the fixture spawn options from the leak guard.
5. Run `runResearchPhase` with an `OutboxJiraClient`. Its `addComment` and `transitionStatus` go to `outbox/loop-NNN-<action>.json`, and every other method throws.
6. Grade, then append a `FixtureRunLine` to `runs/v2/fixtures/<fixture>.jsonl`.
7. `finally`: remove the pinned worktree.

Runs are sequential. Budget: `--max-budget-usd` $5 per run, `--runs` capped at 5, and `--max-total` (default $25) stops the series once spent cost reaches it.

### The skill in fixture mode

When `RUN_DIR/ticket.json` exists, the skill:

- reads the ticket, comments, mirror Issue, links and prior tickets from it;
- never calls `mcp__atlassian__*` or `gh`;
- skips JQL and Confluence prior-art search (with a progress note);
- writes each post it would make as `outbox/NNN-<jira|github>-<comment|title>.md` and appends `{seq, surface, action, target, file, edit_of}` to `outbox/index.jsonl`;
- for checklist item 0, re-reads the published spec from `outbox/`;
- grounds in the `ground-dir=` the loop made. It does no fetch and no worktree add or remove.

Re-pickups work the same way: a prior `❌ research-loop -` comment with `is_pipeline: true`, then a human "accept as scoped" comment, tests the "scope ruling is final" rule.

The prompt gains `ground-dir=<abs>` only in fixture mode (`buildSkillPrompt`'s reserved keys), so real runs are byte-identical.

### Repo pinning

`src/eval/pin-repo.ts`, with an injected `git`:

1. `cat-file -e <sha>^{commit}`. If it fails, one `fetch origin`, then check again. Still missing is a hard error naming the sha. It never falls back to HEAD.
2. `rev-parse <sha>^{commit}` gives the full sha (a short pin must be unambiguous).
3. `worktree add --detach <dir> <full>`.
4. `rev-parse HEAD` in `<dir>` must equal the full sha; if not, remove the worktree and error.
5. `remove()`: `worktree remove --force <dir>`, which never throws.

The profile is pinned too. The Node major comes from `git show <sha>:<versionFile>`, and the fake env from `git show <sha>:<envTemplate>`. Env and secrets are unchanged: the deny-reads and fake `.envrc` cover the pinned worktree as well.

### Leak guard

`fixtureSpawnGuard(base)` takes the role's spawn options and returns:

- `allowedTools`: the built-ins only (`Bash,Read,Grep,Glob`), with no `mcp__*`;
- `denyTools`: `mcp__atlassian`, `mcp__claude_ai_Atlassian`, `Bash(gh:*)`, `Bash(curl:*)`, `WebFetch`, `WebSearch` (a new `settingsJson` input, validated);
- `env`: `DEVLOOP_EVAL_KEYS=""`, `GH_TOKEN` and `GITHUB_TOKEN` deleted, `GH_CONFIG_DIR=<RUN_DIR>/.gh-empty`.

Live is refused when `CLAUDECODE` is set (same rule as `run.sh`).

### `fixture:save -- <KEY> --name=<fixture>`

`src/eval/fixture-save.ts`. Read-only: it never writes to Jira and never runs `git add`.

- It reads the issue (summary, type, description as text, attachments metadata), all comments, and its links. It then downloads the attachments through `fetchAttachments` with the same limits and copies the run's files when `--from-run=<dir>` is given.
- Scrubbing:
  - `redactSensitive` on all text;
  - each distinct author becomes `user-N`, and pipeline comments (`✅/❌ research-loop -`) are marked `is_pipeline: true`;
  - the real key becomes `FX-<n>` everywhere in the text;
  - absolute paths become relative.
- It refuses to save if a text attachment contains a secret (`containsSecret`).
- It writes `reviewed: false`, because images can't be scrubbed. The runner refuses an unreviewed fixture.
- It refuses to overwrite an existing fixture folder unless `--force` is given.

## Files

- `src/eval/fixture.ts`: types, `validateTicket`, `validateRepoPin`, `loadFixture`.
- `src/eval/grade-fixture.ts`: the grader.
- `src/eval/outbox.ts`: `OutboxJiraClient`.
- `src/eval/pin-repo.ts`: `pinWorktree`.
- `src/eval/guard.ts`: `fixtureSpawnGuard`, `FIXTURE_DENY`.
- `src/eval/fixture-run.ts`: `runFixture` (injected deps) and its CLI.
- `src/eval/jira-read.ts`, `src/eval/fixture-save.ts`: the save path.
- `src/core/paths.ts`: `v2FixtureRunDir`, `v2FixtureRunsLog`, `FIXTURE_NAME`.
- `src/core/spawn-claude.ts`: `denyTools` in `settingsJson`.
- `src/core/build-prompt.ts`: optional `groundDir`.
- `evals/fixtures/mc-1435-xl/`, `evals/fixtures/mc-1718/`.
- `test/fixtures/replay/*`, `test/roles/research/verdict-replay.test.ts`, `test/eval/*.test.ts`.

## Not in this change

- The guard hook script and lifting the live refusal (call 9).
- Dev-phase fixtures.
- A dashboard view of fixture runs.
