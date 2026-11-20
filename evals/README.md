# Evals (spec §9.2)

End-to-end scenarios that run the real loop (`npm run loop -- --config
pipeline.eval.config.json --once`) against a private sandbox repo,
`JustinChan-fd/dev-loop-eval-sandbox`, with real Jira tickets in TARS that
carry the `dev-loop-eval` label and a `[dev-loop-eval]` summary prefix.

## Before the first real run: needs the user's go

- **The sandbox repo does not exist yet.** Creating it (`gh repo create`,
  seeded from `poc-stacked-prs/app`) is outward-facing: ask first.
- **A real run costs money.** Each ticket a scenario works is one research
  run (ceiling $15) and one dev run (ceiling $10). `--all` works six
  tickets, so the worst case is about $150. Say what it will cost and get a go
  before running any scenario for real.
- `bash evals/preflight.sh` (live) is also the user's call: it checks gh
  auth, the sandbox repo, and Jira auth.

## Running

**Dry is the default. A real run needs exactly `DRY_RUN=0`.**

| `DRY_RUN` | mode |
|---|---|
| unset, empty, or `1` | dry: every outward command is printed as `DRY: …`, none runs |
| exactly `0` | LIVE: real Jira tickets, real sandbox PRs, paid `claude -p` runs |
| anything else (`true`, `yes`, `false`, …) | refused, exit 1, nothing runs |

`run.sh` refuses live mode when `CLAUDECODE` is set (inside a Claude Code
session, including a `claude -p` agent): a human runs live evals from their
own shell. Dry mode still works there.

```sh
npm run eval -- clean                       # dry (default): print every outward command, run none
DRY_RUN=0 npm run eval -- clean             # LIVE: one scenario, for real
DRY_RUN=0 npm run eval -- --all             # LIVE: all six, in order; stops at the first failure
DRY_RUN=0 EVAL_SANDBOX=sbx npm run eval -- clean   # LIVE, with --sandbox=sbx (unset or none: no sandbox)
bash evals/seed-app.sh                      # dry: show the one-time push of app/ to the sandbox (clean-app needs it)
node evals/report.mjs                       # outcome / phases / cost / minutes per scenario
bash evals/reset.sh                         # dry: list what would be closed
DRY_RUN=0 bash evals/reset.sh               # LIVE: list (checks eligibility on Jira)
DRY_RUN=0 bash evals/reset.sh --write       # LIVE: close it
```

One scenario per call. `--all` is required for all six. `EVAL_SANDBOX` is
unset, `none` or `sbx`; anything else is refused before anything runs. A failed scenario
is never auto-retried: read its grader's JSON line, then decide.

| scenario | setup | passes when |
|---|---|---|
| `clean` | one well-specified ticket | record `landed`, 2 phases, sandbox PR open, RED commit before GREEN |
| `ambiguous` | one vague ticket | research `bounced`, 1 phase, ticket in Blocked, no PR |
| `dev-bounce` | a ticket that points at a doc the repo doesn't have | research landed, dev bounced `spec_ambiguous` |
| `blocked` | ticket B "is blocked by" A, and A has an open sandbox PR | B's record is `skipped-blocked` naming A, no claim, B still To Do |
| `queue` | an ambiguous ticket, then a clean one | two records, the first bounced and the second `landed` |
| `clean-app` | one well-specified ticket against the sandbox's `app/` (catalog-shaped: `app/.nvmrc` 24, dotenv `app/.env.example`, husky pre-push), on the rendered `pipeline.eval-app.config.json`; a canary planted in the checkout's `app/.env.local` and root `.envrc` | everything `clean` checks, plus `npm ci` ran in `<worktree>/app` on node 24, the fake `.envrc` puts the host's v24 bin on PATH, the startup line built a non-empty fake from `app/.env.example`, the canary is in no run dir file, PR body or commit, and a non-robot `direnv exec` in a worktree gets none of the fake's names |

`clean-app` uses its own checkout, `${EVAL_APP_CHECKOUT:-$HOME/.cache/dev-loop-eval/sandbox}`,
outside dev-loop's folder (the sbx preflight refuses a planted `.envrc` in a
repo inside it). The committed `pipeline.eval-app.config.template.json` has
`{{CHECKOUT}}`, which `run.sh` and `preflight.sh` fill into
`$STATE_DIR/pipeline.eval-app.config.json`. The sandbox needs `app/` once:
`DRY_RUN=0 bash evals/seed-app.sh` (a push to the sandbox; ask first).
`reset.sh --write` also removes the canary files.

`dev-bounce` is the least deterministic scenario: research can bounce the
ticket itself.

## Files

- `lib.sh`: `outward` (the one gate for outward commands), `run_to`
  (wall-clock limit; runs the command in its own process group and on
  timeout sends the group SIGTERM, then SIGKILL after `RUN_TO_GRACE_S`,
  default 40 s, so `npm run loop`'s node and `claude -p` children stop
  too), `api` (`gh api` pinned to the sandbox), `jira`, `assert_repo`,
  `assert_clone`.
- `preflight.sh`: the config guard (`config-guard.mjs`, local), then gh,
  sandbox and Jira checks (outward).
- `run.sh`: preflight, then scenario setup, then the loop under `run_to`,
  then the grader.
- `scenarios/*.sh`: the ticket text and setup for each scenario.
- `check-*.mjs`: pure graders, `grade({ records, pr, jira }) -> { pass,
  reasons }` (shared pieces in `grade-lib.mjs`). Run directly, they
  gather real state through `gather.mjs`.
- `jira.mjs`: the only Jira client in `evals/`. Every write refuses a
  non-eval ticket. Creates set Story Points (`STORY_POINTS_FIELD`), which
  the claim transition requires.
- `report.mjs`: the summary table.
- `reset.sh`: closes eval tickets and their sandbox PRs, and removes the
  `clean-app` canary files.
- `seed-app.sh`: pushes `sandbox-app/` to the sandbox as `app/` (once).
- `sandbox-app/`: the app-layout sub-project's content.
- `pipeline.eval-app.config.template.json`: the app-layout config
  (`targetRepo.local`), with `{{CHECKOUT}}` for the machine's checkout.

## Boundaries (enforced, not convention)

- **Dry run.** Unless `DRY_RUN` is exactly `0`, `outward` prints `DRY: <cmd>` and runs
  nothing. It re-parses `DRY_RUN` on every call, so an invalid value refuses there too. Every gh, Jira, loop and grader call in `evals/*.sh` goes
  through it. `test/evals/harness.test.ts` checks this two ways. First,
  it scans the scripts for any gh/curl/npm/claude call outside `outward`.
  Second, it runs the scripts with stub `gh`/`claude`/`curl`/`npm` first
  on PATH and asserts that no stub was called. Dry keys go to
  `.state/keys.dry`, never `.state/keys`.
- **Config.** `preflight.sh`, which `run.sh` calls first, aborts in either
  of two cases: `pipeline.eval.config.json`'s `github.repo` or
  `targetRepo.url` is not the sandbox, or either pollJql lacks
  `AND labels = "dev-loop-eval"`. The production configs exclude that
  label.
- **Jira writes.** `run.sh` exports `DEVLOOP_EVAL_KEYS`, which the
  spawned `claude -p` inherits. While it is set,
  `.claude/hooks/block-non-eval-jira-writes.sh` denies any
  `mcp__atlassian__` write to a key outside the list. It allows a
  `createJiraIssue` only when all of these hold:
  - the project is TARS;
  - the summary has the `[dev-loop-eval]` prefix;
  - the labels include `dev-loop-eval`;
  - there is no parent, or the parent is a listed key (the eval
    tickets themselves go under Epic TARS-1384, which TARS now requires);
  - there is no transition.
- **GitHub.** `run.sh` exports `GH_REPO=<sandbox>`. `api` asserts the repo it calls (`$EVAL_REPO`)
  is the sandbox before every call. `assert_clone` checks both the origin fetch and push URLs.
- **Reset.** A ticket is closed only when all three hold: its key is in
  `.state/keys`, it carries the label, and its summary has the prefix.
  Nothing is closed without `--write`.

`.state/` is gitignored. It holds `keys`, `scenarios` (used by
`report.mjs`) and the ticket-text temp files.
