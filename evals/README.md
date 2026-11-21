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

## Fixture evals

A fixture eval runs research (ticket-refine) on a ticket kept in local files,
so no real ticket is needed and **nothing is written to Jira or GitHub**.
Design: `docs/superpowers/specs/2026-11-20-eval-fixtures-design.md`.

**What a fixture is.** Each fixture is a folder, `evals/fixtures/<name>/`:

| File | What |
|---|---|
| `ticket.json` | the ticket, with a fake `FX-<n>` key: summary, type, description, `comments[]` (each with `is_pipeline`), the mirror Issue (`github`), `linked`, `prior_tickets`, attachment metadata, and `reviewed` |
| `attachments/` | the attachment files `ticket.json` names (a missing one becomes a `failed` entry, to test the unreadable-attachment rule) |
| `repo.json` | the target project and the commit to pin (`sha`, `verified`, `verify_cmd`) |
| `expect.json` | what to grade: outcomes, failure categories, the loop's check, grounding before sizing, attachment coverage, size, AC count, outbox text (it always forbids "spec wins"), cost, pass rate |

The runner refuses a fixture that has no `ticket.json`, has `reviewed: false`, or
has an unverified pin. It prints every problem at once.

**Replay tests (free, in `npm test`).** `test/fixtures/replay/<name>/` holds
saved real run folders (`verdict.json`, `progress.jsonl`, `attachments.json`)
and an `expected.json`. `test/roles/research/verdict-replay.test.ts` feeds
each one through the loop's own verdict check (`checkResearchVerdict`) and the
grader. A rule change that would treat a real run differently fails there.
The first four are MC-1435's three research runs and MC-1718's.

**The live fixture runner.**

```sh
npm run eval -- --fixture=mc-1718             # dry (default): print the plan, or every problem, run nothing
npm run eval -- --fixture=mc-1718 --runs=3    # the same, for 3 runs
DRY_RUN=0 npm run eval -- --fixture=mc-1718 --runs=3   # LIVE (refused for now, see below)
```

Each run is one ticket-refine spawn on a detached worktree at the pinned
commit, made and removed by the loop. Runs go one after another. Each has a
$5 budget; `--runs` is capped at 5 and `--max-total` at $25 (the default).
The result is a pass rate against `expect.json`'s `passRate`. Run folders
are `.pipeline/v2/fixtures/<fixture>/<FX-n>/research-<RUN_ID>`, and the log is
`runs/v2/fixtures/<fixture>.jsonl`, never a project's log.

**Live is refused for now** (`LIVE_ENABLED` in `src/eval/fixture-run.ts`).
Two things come first: a Bash hook that denies `gh` and `api.github.com`
however they are spelled, and a first run a person watches. Like `run.sh`,
live is also refused inside a Claude Code session.

**`fixture:save`.**

```sh
npm run fixture:save -- MC-1718 --name=mc-1718 [--fx=1] [--replace]
```

This reads the ticket, its comments, links and attachments from Jira using
GET requests only. It scrubs them:

- emails and secret-shaped values are redacted;
- authors become `user-N`;
- the real key becomes `FX-<n>`;
- home paths are made relative.

It then writes `ticket.json` with `reviewed: false` (images can't be scrubbed)
and `attachments/`. It refuses the save if a text attachment looks like it
holds a secret, and never runs `git add`. Read what it wrote, set
`reviewed: true`, and commit by hand.

**How fixture runs differ from the scenarios above.**

| | Scenarios (`clean`, `--all`, ...) | Fixtures (`--fixture=<name>`) |
|---|---|---|
| Ticket | a real TARS ticket, created per run | `ticket.json`, no real ticket |
| Jira and GitHub writes | real (eval tickets and sandbox PRs only) | none: the skill's posts and the loop's comment and transition go to `RUN_DIR/outbox/` |
| Phases | research and dev, through `npm run loop` | research only, through `src/eval/fixture-run.ts` (no session lock, claim, label swap or mirror Issue) |
| Repo | the sandbox repo at `master` | any project, pinned at a commit (`repo.json`) |
| Spawn | the normal tools | built-in tools only; Atlassian, `gh`, `curl`, `git push`, `git credential` and the web denied; no GitHub token, git credential helper or SSH agent; `DEVLOOP_EVAL_KEYS=""` |
| Free part | `npm test` checks the dry run | `npm test` also replays saved runs |

The first two fixtures are `mc-1435-xl` (the description that bounced XL)
and `mc-1718` (the run that passed with full coverage). Each has a
`PENDING.md` listing what's missing: `ticket.json` from `fixture:save`, and
the pinned sha confirmed on the host.

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
- `fixtures/<name>/`: fixture evals (see "Fixture evals"). The code is
  `src/eval/` (TypeScript, tested in `test/eval/`).

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
