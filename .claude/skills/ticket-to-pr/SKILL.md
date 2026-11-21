---
name: ticket-to-pr
description: Turn a single ready Jira ticket into a PR against the target repo (the project config's targetRepo) using strict TDD phases. The executor role (spec section 5.0/5.2) - trusts the refined ticket completely, never relitigates the spec, bounces with evidence instead of guessing.
---

# ticket-to-pr

## Arguments

`$ARGUMENTS` — `<TICKET> run-dir=<RUN_DIR> repo-dir=<REPO_DIR>`, optionally
followed by `push-branch=<abs SKILL.md path>`,
e.g. `TARS-1301 run-dir=<abs path ending in /TARS-1301/dev-20261111T010203Z> repo-dir=<abs checkout path>`.
The first three are required. The loop runner builds this line (see
"Invocation" below); never derive any of them yourself.

- `<TICKET>` — the Jira ticket key.
- `run-dir=` — this run's directory (`RUN_DIR` below).
- `repo-dir=` — the target repo checkout this run works against
  (`REPO_DIR` below).
- `push-branch=` (optional) — where the operator's `push-branch` skill is
  in this run. A sandboxed run gets it, because the sandbox can't see
  `~/.claude`; a run on the host never does. `PUSH_BRANCH_SKILL` = this
  value when given, else `~/.claude/skills/push-branch/SKILL.md`.
- `push=host` (optional) — the sandbox can't sign commits, so the host
  pushes for you. `PUSH_MODE` = `host` when given, else `self`. Under
  `PUSH_MODE=host` Phase 5 does not push; it stops at `ready_to_push`.

## Role: the executor

Per spec section 5.0, this skill runs **downstream of the human review gate**
and operates under full trust of the refined ticket:

- The **research-loop comment** (title starts with `✅ research-loop -`, per
  research-loop's own comment convention) is the work order. research-loop
  now always posts a brand-new comment on every re-verify/re-pickup cycle
  rather than editing an existing one in place (fixed 2026-09-19 — editing
  in place made Jira/GitHub threads look out of sync with each other even
  when the underlying state was consistent, since both surfaces render
  threads in creation-time order, not edit order), so a ticket can carry
  several matching comments over its life — always treat the
  **most-recently-created** matching comment as the work order, never the
  first one found. Treat it as
  near-perfect — do not renegotiate acceptance criteria, scope, or the
  stated fault domain. `research-loop` never rewrites a stakeholder's
  original description, so the description itself is raw context only —
  useful for background, never authoritative for AC/Scope.
- The ticket's **other comments** hold extra context (research-loop's recon
  findings, human steering notes at the review gate). Consult them when the
  research-loop comment alone leaves a judgment call, but that comment
  remains authoritative.
- **No guessing.** If an implementation decision can't be *reasoned to* from
  the research-loop comment + other comments, or the described work turns out to be larger
  than stated, stop and bounce with exactly what was missing. A ticket is
  never edited by this skill — if the spec is wrong, ambiguous, or
  unimplementable as written, that is `ticket-refine`'s problem to fix
  upstream, not this skill's to patch over.

A stated "I stopped because X" is a success mode of this pipeline. A guessed
implementation is its worst failure mode.

## Setup: run directories and progress logging

Before phase 0, establish:

1. **Use the `run-dir=` and `repo-dir=` you were given.** `run-dir` must be
   absolute and contain `/.pipeline/v2/`. If either is missing or
   malformed, write no files and stop with an `agent_error` verdict.
   Never guess a path. (With no usable `RUN_DIR` there is nowhere to write
   `verdict.json`; the loop runner records the missing verdict as
   `agent_error` itself. Print the always-emitted result line,
   `RESULT: error — missing or malformed run-dir=/repo-dir=`, and stop.)
   `RUN_DIR` = the `run-dir=` value; `REPO_DIR` = the `repo-dir=` value.
   Both are absolute; use them exactly as given.
2. `RUN_ID` = the part of `RUN_DIR`'s last path segment after its first
   `-`. The last segment is `dev-<RUN_ID>`, so for
   `.../TARS-1301/dev-20261111T010203Z`, `RUN_ID` is `20261111T010203Z`.
   It names this run's worktree (see "Target repo" below).
3. `DEVLOOP_DIR` = `RUN_DIR` up to, not including, its `/.pipeline/v2/`
   (the dev-loop checkout this run was started from). `RUN_DIR` already
   exists (the loop runner creates it). Write only inside it — never
   anywhere else in the dev-loop checkout.
4. Every phase transition appends one JSON line to `RUN_DIR/progress.jsonl`
   (create the file with the first append). Never rewrite or delete existing
   lines — append-only. Each line:
   ```json
   {"ts": "<ISO-8601 UTC>", "phase": "intake|plan|red|green|verify|pr", "event": "phase_start|phase_end|note", "detail": "one line"}
   ```
   - Emit `phase_start` when beginning a phase, `phase_end` when leaving it
     (whether it succeeded or the run is about to bounce from within it).
   - Emit a `note` event for anything worth surfacing mid-phase (e.g. "wrote
     3 failing tests", "existing suite has 412 tests, 0 failing before
     changes", "QA subagent flagged a null-check gap").
5. At the very end of the run — success or bounce, no exceptions — emit one
   final `progress.jsonl` line with `"event": "result"` whose `detail` is the
   same human-readable summary described in "Always-emitted result line"
   below, then print that same line to stdout as the last thing this skill
   does.

This progress log is deliberately separate from `verdict.json`: it exists so
a dashboard (built separately, not by this skill) can show what happened
inside a run while or after it happened, without needing to parse model
output. Only append to it — never read it back to make decisions; all
decision-relevant state lives in the ticket, the target repo, and this
skill's own working context.

## Always-emitted result line

Whatever phase the run ends at, the last thing this skill does is emit one
line, to stdout and as the final `progress.jsonl` event and as
`verdict.json`'s `detail` field, in one of these forms:

- `RESULT: landed — PR opened at <url>`
- `RESULT: bounced (<failure_category>) — <one-line reason with concrete evidence>`
- `RESULT: error — <what went wrong>` (only for genuine tooling/environment
  failures, not spec problems — spec problems are always `bounced`)

This is the single line a human skimming a terminal or a future dashboard
should be able to read to know what happened, without opening any other
file.

## Target repo

The project config (`pipeline.<project>.config.json` at the dev-loop
checkout's root, `DEVLOOP_DIR`) names the codebase this skill operates on
in `targetRepo`
(e.g. `pipeline.webtarsthree.config.json` names `git@github.com:fandango/webtarsthree.git`).
This is **not** the `dev-loop` repo itself; `dev-loop` only
orchestrates. `REPO_DIR` (from `repo-dir=`) is that codebase's checkout on
this machine: `targetRepo.path` when the config sets it (its `origin`
remote is the real GitHub remote, so `git push`/`gh pr create` in Phase 5
need no extra setup), otherwise a shared fetch-only clone the loop runner
points you at. Read `targetRepo.url` and `targetRepo.defaultBranch` from
the config; take the checkout's location only from `REPO_DIR`.

**Per-run worktree, nested inside `REPO_DIR` itself — never work directly
in a shared checkout.** At the start of Phase 0, create an isolated
worktree for this run, on its own branch, **inside** `REPO_DIR`'s own
directory tree (`<REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>`, not a
sibling path elsewhere). The loop keeps a **fake env** at
`<REPO_DIR>/.claude/worktrees/.envrc`, built from the target repo's committed
env template (`.envrc.example` by default; the project config's
`targetRepo.local.envTemplate`, e.g. `app/.env.example`) with placeholder
values, so `direnv` walking up from a worktree (or its app folder) stops
there and loads the fake, never the person's real `<REPO_DIR>/.envrc`.
Never read `<REPO_DIR>/.envrc`, `<REPO_DIR>/.env` or any real env file in the
app folder (e.g. `app/.env.local`) with any tool, never copy `.envrc.example` to a `.envrc`
(or any template to a real env file), and never point `direnv exec` at `<REPO_DIR>` itself.
**Never create or write `.env.local`** (or any other real env file) in the
worktree: in an app-folder project it overrides the fake env, so a setting
the robot needs goes through the fake env, never a file. Never work directly in `REPO_DIR` itself, since a human may `cd`
into it or be mid-inspection of a prior run's worktree at any moment
while this loop runs unattended in the background.

### Ticket attachments

The loop downloads the ticket's Jira attachments on the host before every run
into `<RUN_DIR>/attachments/` and lists each one in `<RUN_DIR>/attachments.json`
as `fetched` (with its `path`), `skipped` (with the `reason`) or `failed` (with
the `error`). Read the manifest at the start of Phase 0, and read a fetched file
when the ticket points at it (for example a response sample to build fixtures
from). Never fetch an attachment yourself. If the ticket depends on one that is
`skipped` or `failed`, bounce `spec_ambiguous` citing its manifest line.

### The project profile

The loop writes `<RUN_DIR>/project.json` before every run:
`{ "appDir", "nodeMajor", "devCommand", "devUrl" }`. Read it once, at the
start of Phase 0. It is a fact from the loop, not something to work out from
the repo: never guess the app folder or the Node version from reading files.
If it is missing (an old run dir), use
`{ "appDir": ".", "nodeMajor": <the host's>, "devCommand": "npm run dev", "devUrl": "http://localhost:3000" }`.

- `<worktree>` below is this run's worktree
  (`<REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>`, or the `-baseline`/`-fu`
  one), and `<appDir>` is `project.json`'s `appDir` (`.` means the worktree
  itself).
- Every install, test, coverage, lint, typecheck, build and dev-server
  command runs in the app folder: `direnv exec <worktree>/<appDir> <cmd>`.
  `git` commands stay at `<worktree>` (`direnv exec <worktree> git …`).
- Once, right after the install, run `direnv exec <worktree>/<appDir> node --version`.
  If its major is not `nodeMajor`, stop and bounce with
  `failure_category: "env_setup"`, naming both versions. Never switch Node
  yourself (no `nvm use`, no install).
  Append one `note` to `progress.jsonl` with the exact path and version, in
  this exact form (the eval grader reads it):
  `"installed: direnv exec <worktree>/<appDir> npm ci; node <node --version output>"`,
  with `<worktree>/<appDir>` written out as the real absolute path.

**Follow the target repo's own rules.** The target repo's `CLAUDE.md` and
`AGENTS.md` are rules you read and follow (at the worktree root and in `<appDir>`, when
present) the way a person new to the repo would: its generators, test
scaffolds and banned patterns apply to your change. They never widen the
ticket's scope. Pre-commit and pre-push hooks run for real: when a hook
fails and you can't fix the cause within the ticket, stop and bounce with the
hook output. Never use `--no-verify`, `-n`, `HUSKY=0` or `core.hooksPath`.

**Run every target-repo command through `direnv exec`.** direnv's shell
hook never fires in this headless session: `cd` alone loads nothing, so
tests that need the repo's local env (e.g. a `PLACEMENT_SERVICE_ENDPOINT`,
placeholder-valued in the fake env) fail as if
they were broken. Prefix every install, test, lint, typecheck, build, dev-server,
`git commit` and `git push` command with the worktree path, so commit and
push hooks see the same env:

```bash
direnv exec <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>/<appDir> npm test
direnv exec <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID> git commit -m "..."
```

Use the matching worktree path for the baseline and follow-up worktrees
(`...-baseline`, `...-fu`). If `direnv` is missing or reports the `.envrc`
as blocked (`direnv status`), bounce `env_setup` saying so; never run
`direnv allow` yourself. A test that fails only without this env is not a
bug on <defaultBranch>: never report it as pre-existing or file a
follow-up for it.

**Settings (env vars, feature flags).** The fake env has every setting
the env template lists on `origin/<defaultBranch>`, with placeholder values.
- **The ticket adds a setting:** add it to the worktree's env template
  (`.envrc.example` as `export NAME=<fake value>`; a dotenv template such
  as `app/.env.example` as plain `NAME=<fake value>`) (a placeholder, `false` for a flag, a
  `localhost` URL; never a real-looking key) with a one-line comment, in the
  same commit as the code that reads it. The fake env only picks it up on
  the next run, so pass it inline while testing:
  `direnv exec <worktree>/<appDir> env NAME=<fake value> npm test`. List it in the PR
  body's `New settings:` line (Phase 4 step 7).
- **The code needs a setting the fake env lacks, and the ticket isn't
  adding it** (it is missing from the env template, `.envrc.example` by default): stop and bounce with
  `failure_category: "env_setup"`, naming the setting and the file that
  reads it. Never invent a real-looking value, and never read the real
  `.envrc` to find one.

If `REPO_DIR` has no `.git` yet (the shared clone was never made on this
machine), clone it first; otherwise skip straight to the fetch:

```bash
if [ ! -d <REPO_DIR>/.git ]; then
  git clone <targetRepo.url> <REPO_DIR>
fi
git -C <REPO_DIR> fetch origin
git -C <REPO_DIR> worktree add \
  <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID> \
  -b <TICKET>-<slug> origin/<targetRepo.defaultBranch>
cd <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>
```

`<REPO_DIR>/.claude/worktrees/` is expected to be listed in that repo's
own `.git/info/exclude` (a machine-local, never-committed ignore rule) —
not this skill's job to add, but don't be alarmed that it's untracked and
outside this repo.

(Two distinct identifiers here: `<RUN_ID>` is this run's id from `RUN_DIR`,
keeping this run's worktree separate from any other run's, past or
concurrent; `<slug>` in the branch name is the per-ticket kebab-case
summary described next — the branch name itself has no `<RUN_ID>` in it,
since it's what gets pushed and PR'd.)

`<slug>` is a short kebab-case summary derived from the ticket's summary
(lowercase, non-alphanumeric → `-`, truncate to a reasonable length — e.g.
`TARS-1301-delete-tv-objects`). All subsequent phases operate with this
worktree as the working directory unless stated otherwise. See "Cleanup"
below for removing it once the run concludes.

### Install the target repo's packages

A new worktree has no `node_modules`. Right after creating it (fresh or
resumed), install the packages inside it, in its app folder (see "The
project profile"), from that folder's own lockfile:

```bash
direnv exec <worktree>/<appDir> npm ci
```

Then check the Node major (see "The project profile").

Do the same in every other worktree you create (`-baseline`, `-fu`), in
that worktree. Never copy, link or reuse a `node_modules` from `REPO_DIR` or
another worktree: it may have been built for a different machine (a
sandboxed run is Linux; the checkout's packages are macOS builds, and
vitest's native parts then fail to load).

If `npm ci` fails, or the test suite still can't start after it, stop and
bounce with `failure_category: "env_setup"`, naming the command and its
first error line. TDD needs the suite: never continue to Red, Green, Verify
or the PR without running it.

### Resume: continue prior work instead of starting over

A ticket can be picked up again after a bounce (e.g. `verify_rejected`) with
its earlier commits still sitting in a `<TICKET>-*` branch. **Do not start
that work from scratch, and do not let `git worktree add -b` fail on the
existing name.** Before the `worktree add` above, after the `fetch`:

1. **Look for prior work.** List `<TICKET>-*` branches, local
   (`git branch --list '<TICKET>-*'`) and remote
   (`git branch -r --list 'origin/<TICKET>-*'`) in `REPO_DIR`. A branch only counts as prior work if it has commits not
   on `origin/<defaultBranch>` (`git rev-list --count
   origin/<defaultBranch>..<branch>` > 0); a branch with zero commits ahead
   is stale and is ignored (never reused, never deleted). Don't change the
   existing branch's name: when prior work exists, `<slug>` is that
   branch's, not a freshly derived one.
2. **None found → fresh run**, exactly the `-b <TICKET>-<slug>
   origin/<defaultBranch>` command above.
3. **Exactly one found → resume.** Create the worktree on the existing
   branch with no `-b` and no new base (`git worktree add <path>
   <branch>`). If both a local and an `origin/` copy exist, the local one
   must contain the remote one (`git merge-base --is-ancestor
   origin/<branch> <branch>`); if the two have diverged, or `worktree add`
   fails (e.g. branch checked out elsewhere), bounce `env_setup` with the
   branch names and both tips — never pick one by guessing.
   **More than one prior-work branch → bounce `env_setup`** naming them.
4. **Bring it up to date.** If `origin/<defaultBranch>` has moved, `git merge
   origin/<defaultBranch>` into the branch (merge, not rebase — the branch's
   history may already be pushed). A conflict bounces `merge_conflict`.
5. **Record it.** Write a `progress.jsonl` note: `resume: true`, the branch,
   its tip SHA, and `git log --oneline origin/<defaultBranch>..HEAD`.

What resuming changes in the phases (everything not listed is unchanged):

- **The newest research-loop spec (Phase 0 step 2) is the only work
  order.** Earlier commits are prior work against an older spec, not
  authority: where the new spec differs, the new spec wins, and existing
  code may need changing, not just extending. Still never relitigate it.
- **Phase 1 (Plan)**: first run the target repo's tests on the branch as it
  is and diff each AC against what the commits already cover. Plan only the
  remaining work: ACs with no test yet, tests the new spec adds or changes,
  and implementation still missing. Do not rewrite passing tests or
  reimplement working code.
- **Phase 2 (Red)**: only for ACs/tests that are new or changed. The
  baseline is the branch tip, not `origin/<defaultBranch>`, so an AC whose
  test already passes there because earlier commits implemented it is
  *expected*: note it as already satisfied in `progress.jsonl`; do **not**
  bounce `spec_ambiguous`. The "passes on unmodified code" bounce still
  applies to a test you just wrote for a new/changed requirement. Set
  `red_confirmed: true` if the branch already carries the original Red
  commit (`test(<TICKET>): add failing tests …`) and any new tests also
  failed for the right reason.
- **Phase 4 (Verify)**: `verify_loops` counts **this run's** `qa-agent`
  invocations, starting at 0. The 3-loop budget is per run, so a resumed
  run gets a fresh 3. Prior runs' loop counts don't carry over. Give
  `qa-agent` the research-loop spec's current text, and tell it which
  defects earlier runs already reported (from the ticket's bounce comments)
  so it checks those specifically.
- **Phase 5 (PR)**: one PR for the whole branch, not just this run's
  commits.

**Say truthfully where the work lives.** Whenever a run bounces with
commits on the branch, the bounce `detail` names the branch and states
whether it is on `origin` — check with `git ls-remote --heads origin
<branch>`, don't assume. Never write "pushed" unless that command returned
the branch. A bounce does not push (nothing unreviewed goes to the remote),
so the usual wording is "committed locally on `<branch>`, not pushed" with
the tip SHA.

## Phases

Each phase's `progress.jsonl` events use the phase name shown.

**Atlassian tool names.** Your Jira tools may come from either version of
Atlassian's MCP server, and some tools have a different name on each. Use
whichever of each pair you have (both are allowed):

| Job | Older server | Newer server (`/v2/mcp`) |
|---|---|---|
| Read a ticket's comments | `getJiraIssue` (fields incl. `comment`) | `listJiraIssueComments` (pages every comment; the newer `getJiraIssue` shows at most 20 and may show none) |

Where the newer server has `listJiraIssueComments`, use it to read
comments: never conclude a ticket has no comments from `getJiraIssue`
alone.

**Linking tickets.** The newer server has no `createIssueLink`. When a step
says to link a ticket and that tool is missing, record the link in the new
ticket's description (`Relates to <TICKET>` / `Blocks <TICKET>`) and say so
in `verdict.json`'s `detail`; never stop the run for it.

### Phase 0 — Intake

1. Fetch the ticket (`getJiraIssue`, fields: summary, description, comments,
   status, issuetype) for `$ARGUMENTS`, and read every comment with
   `listJiraIssueComments` where you have it (see "Atlassian tool names").
2. Find the ticket's research-loop-authored comment (title starts with
   `✅ research-loop -`, per research-loop's own comment convention — see
   its `docs/future-enhancements.md`'s "Simplify Jira/GitHub comment
   templates" entry). **A ticket can have more than one matching comment**
   (research-loop always posts a new comment per cycle rather than editing
   one in place — see "Role: the executor" above) — when more than one
   Jira comment matches, use the **most-recently-created** one (by comment
   creation timestamp, not its position read top-to-bottom) as the work
   order; ignore older matching comments except as background on how the
   ticket evolved.
   - **If that comment has the `### Overview` / `### Acceptance Criteria`
     / `### Scope` structure inline**: read it directly, continue to
     step 3.
   - **If it instead has a `[GitHub Issue](url)` link** (research-loop's
     own convention: the full Overview/AC/Scope content lives on the
     linked Issue, not inline — see that repo's SKILL.md, "The GitHub
     Issue itself carries the full refined-ticket content"): fetch that
     Issue's **comments**, not its description/body —
     `gh issue view <number> --repo <owner/repo> --json comments`. The
     Issue's body/description is only ever the creation-time placeholder
     ("Mirror of [TICKET](url). ticket-refine is running...") and is
     never updated after creation — the real content is a comment whose
     first line is the markdown heading `## ✅ research-loop -
     <short context>`. The same most-recently-created rule applies here
     too: if more than one GitHub Issue comment matches that heading
     pattern, use the most-recently-created one. Read the Overview/AC/Scope
     structure from *that* comment.
   - **Stale-spec guard**: after choosing the spec comment, check whether
     any Issue comment created *after* it has a first line containing
     `research-loop` (e.g. `## Self-heal cycle 1 (research-loop verify)`,
     or a later `## ❌ research-loop -`). Such a comment means research-loop
     amended or withdrew the spec outside the `## ✅` comment this skill
     reads, so the chosen spec may be stale — bounce with
     `failure_category: "spec_ambiguous"`, detail naming the newer
     comment's id and first line. Human comments that do not mention
     `research-loop` in their first line never trigger this.
   - **If neither of the above yields the `### Overview` / `###
     Acceptance Criteria` / `### Scope` structure** (no research-loop
     comment at all, an inline comment missing the structure, or a
     `[GitHub Issue](url)` link whose Issue has no matching
     `## ✅ research-loop -` comment, or whose body is still the
     unfilled placeholder with no comment at all) — this ticket should
     never have carried the dev trigger label (`roles.dev.triggerLabel`) — bounce immediately
     with `failure_category: "spec_ambiguous"` and detail naming exactly
     which of the three cases applied. Do not attempt to proceed on an
     unreadied ticket.
3. Read every Acceptance Criterion and the Scope section's enumerated
   files/modules, from whichever source (Jira comment or GitHub Issue
   comment) step 2 resolved.
4. **Early fail-exit check**: if the enumerated scope is clearly larger than
   a single ticket's worth of work (spans many unrelated modules, requires
   architectural changes not described, etc.), bounce now with
   `failure_category: "too_large"` before doing any further work. Better to
   stop here than after writing code.
5. Set up the target repo working directory as described above.
5a. **Baseline suite.** Before writing anything, run the target repo's full
   test suite once on the fresh worktree (still identical to
   `origin/<targetRepo.defaultBranch>`), via `direnv exec` (see "Target
   repo"), the same way its commit hook does
   (read `.husky/pre-commit` or the repo's hook config; usually `npm
   test`). Record the failing tests as `baseline_failures` (`"<file> >
   <test name>"`, empty when green) in one `progress.jsonl` note with the
   baseline SHA. These failures are pre-existing by definition. Phase 4
   step 1 and "Pre-existing failures blocking a hook" below use this list;
   do not re-derive it later. When the list is non-empty and the repo has
   a commit or push hook that runs the suite, go straight to "Pre-existing
   failures blocking a hook" now, before Phase 1: every commit in this run
   would otherwise be rejected.
6. **Derive `COMMIT_TYPE` from the ticket's `issuetype`** — this drives both
   the Green commit (Phase 3) and the PR title (Phase 5), and, via the
   target repo's squash-merge-as-commit-message CI convention, the semver
   bump on merge: `Bug` → `fix`; anything else (`Story`, `Task`,
   `New Feature Request`, etc.) → `feat`. A direct field mapping, not an
   inference — no judgment call to bounce over. Only add a breaking-change
   marker (`!` after the scope, or a `BREAKING CHANGE:` footer) if the
   research-loop comment itself states the change is breaking; never infer
   one from scope size.

### Phase 1 — Plan

Break the Acceptance Criteria into an ordered list of concrete steps. For
each AC, from the research-loop comment's TDD-ready Acceptance Criteria, note: the test name,
what it asserts, and why it currently fails. Write this plan as a single
note in `progress.jsonl` (not a separate file) — it exists to keep this run
honest about scope, not as a deliverable.

If, while planning, any AC cannot be translated into a concrete step without
inferring something the ticket didn't state — bounce now with
`spec_ambiguous`, naming exactly which AC and what's missing. Do this before
touching any code.

### Phase 2 — Red

For each Acceptance Criterion, in order:

1. Write the failing test named in that AC (per the research-loop comment's
   TDD-ready statement of test name / assertion / why it fails).
2. Run it. Confirm it actually fails, **and fails for the expected reason**
   (not e.g. a typo or missing import producing an unrelated error).
3. If a test passes against unmodified code, the AC doesn't describe a real
   change — bounce with `spec_ambiguous`, stating which AC and that its test
   passed on baseline code.

Once every AC's test is written and confirmed failing for the right reason,
record `red_confirmed: true` (this goes into `verdict.json` later).

Then **mark each new test expected-to-fail** before committing, so a
commit hook that runs the suite accepts the Red commit without any bypass:
`it(...)`/`test(...)` becomes `it.fails(...)`/`test.fails(...)` in vitest,
and `test.failing(...)` in jest (pick the one the target repo's runner
supports; check its `package.json`). Run the new tests once more: each must
now *pass* as expected-to-fail. A marked test that still reports a failure
means the marker is wrong, not the code — fix the marker. Commit the tests
alone, before any implementation code
(`git commit -m "test(<TICKET>): add failing tests for ACs"`). The marker
keeps the TDD evidence in git: the Red commit's tests are recorded as
failing on that commit.

### Phase 3 — Green

First **remove the expected-to-fail marker** from every test Phase 2 marked
(`it.fails` → `it`, `test.failing` → `test`), then implement the minimum
change to make those tests pass. Touch **only**
the files enumerated in the ticket's Scope section. If implementing
correctly requires touching a file not enumerated, or reveals the described
bug isn't reproducible, or an AC turns out unimplementable as written — stop
and bounce with `spec_contradicted` (codebase evidence contradicts the
ticket's claim) or `spec_ambiguous`, citing the specific contradiction.

Commit once all Phase 2 tests pass, using `COMMIT_TYPE` from Phase 0
(`git commit -m "<COMMIT_TYPE>(<TICKET>): implement <summary>"`).

### Phase 4 — Verify

1. Run the full existing test suite. If it is 100% green, continue to
   step 2. If anything fails, run the **Pre-existing failure check**
   before deciding anything:
   1. Note the exact set of failing tests (file + test name) on the branch.
   2. Make a throwaway baseline worktree of the unmodified base branch and
      install its dependencies the same way you did for the run's worktree:

      ```bash
      git -C <REPO_DIR> worktree add --detach \
        <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>-baseline \
        origin/<targetRepo.defaultBranch>
      ```

   3. In the baseline, run **only the failing test files**, with the same
      command and environment as the branch run. Record the baseline SHA
      (`git -C <baseline> rev-parse --short HEAD`).
   4. Remove it before going on, whatever the result:
      `git -C <REPO_DIR> worktree remove <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>-baseline`.
      Ignored files (`node_modules`) do not block the removal.
   5. Decide:
      - Phase 0 step 5a's `baseline_failures` already lists the suite's
        failures on this same base; when a branch failure is on that list
        you may skip re-running it in a baseline worktree.
      - If **every test that fails on the branch also fails, with the same
        assertion, on the baseline**, the failures are pre-existing and not
        caused by this change. Continue to step 2. Record each one as
        `"<file> > <test name>"` in `verdict.json`'s `preexisting_failures`,
        and carry them into the PR (step 7) and the result line.
      - If any test **fails only on the branch**, that's a Green-phase
        defect. Go back and fix it; do not proceed to PR with a broken
        suite.
      - If the baseline can't be set up or run (install fails, the command
        errors before running tests), bounce `env_setup` with the output.
      - If a failure passes on a re-run of the branch itself, it's
        flaky, not pre-existing: bounce `tests_flaky` naming it.
   Never bypass a push hook to get past these failures: if `push-branch`'s
   push is blocked by a hook that runs the suite, bounce `tests_flaky` with
   the hook output and the pre-existing list. Never use `--no-verify`.
2. Run whatever the target repo's own CI would run beyond tests — lint,
   typecheck, and build, at minimum (check the target repo's own CI config
   or `package.json` scripts for the actual commands; don't assume names).
   A PR that passes tests but fails lint/typecheck/build on push is not a
   `landed` success, it's a deferred bounce — catch it here, not after
   opening the PR. Treat a failure here the same as a test failure: fix it
   if it's caused by this change, or bounce `tests_flaky`/`env_setup` (pick
   whichever fits) with the concrete output if it's pre-existing and
   unrelated.
3. Confirm the new tests from Phase 2 are present and passing, and that
   TDD order is real in git history (test commit before implementation
   commit — already true if Phase 2/3 were followed in order).
4. Spawn `qa-agent` (see `.claude/agents/qa-agent.md`) as a genuine
   fresh-context subagent — it must not be told how the fix was
   implemented, only given the ticket and the diff. Pass it the ticket key,
   the branch name, the worktree path
   (`<REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>`), and `DEVLOOP_DIR`
   (from Setup; not `pwd`, which is the worktree by now) so it can run
   `src/roles/dev/qa-browser.ts`.
   That path is for the subagent's tool calls only — never write it into
   the PR, Jira, `qa_notes`, or `verdict.json`. Each `qa-agent` invocation is one verify loop —
   increment `verify_loops` when it runs, not when a fix is committed. If
   it reports issues, address them and invoke `qa-agent` again for another
   loop; do not paper over a real finding. **The 3rd `qa-agent` invocation
   is the last one this run gets**: if it reports `pass`, continue to step
   5; if it reports `fail`, bounce immediately with `verify_rejected` and
   its findings — do not fix-and-re-check a 4th time. (Confirmed live on
   TARS-1399: a run that fixed the 3rd loop's finding and re-checked with a
   4th `qa-agent` invocation before bouncing ran to 87 minutes and tripped
   `runTimeoutMin` — the budget is 3 checks total, not 3 fix cycles plus a
   confirmation check.)
5. Record `verify_loops` (final count) for `verdict.json`.
6. **Write `qa_notes`** — sequential manual-testing steps for a human QA
   reviewer, one action per AC (or more if an AC has multiple observable
   steps): a concrete action ("Navigate to `<url>`", "Click X", "Type Y
   into Z") followed by an `Expected: <result>` entry describing what
   should happen. Build these from the research-loop comment's Acceptance
   Criteria text directly — that comment already names concrete
   routes/URLs and expected outcomes for every ticket seen so far, and this
   skill already trusts it literally per its "no inference" rule, so no
   new heuristic (diff-scanning, route-guessing) is needed here. If
   `qa-agent` reported any AC as **unverified (needs human)** (typically
   UI behind the login, which automation cannot reach), start that AC's
   action entry with `[Not verified by automation] ` so the reviewer knows
   this step is theirs alone; do not drop or soften it. Use real
   paths (e.g. `` `/rotten-tomatoes/critics?query=tina+kakad` ``), never a
   page name in prose. This becomes `verdict.json`'s `qa_notes` array (see
   schema below) and is rendered into Jira's QA Notes field as a "Manual
   testing steps:" list. The PR body's `## QA Notes` section (step 7)
   carries this **same** list, matching `push-branch`'s format — the
   earlier pass/fail summary (test counts, lint/build status, QA agent
   verdict) is no longer written into the PR; that data lives in
   `verdict.json` and `progress.jsonl`.
7. **Compose the PR content** — this is the last reasoning step; Phase 5
   below is purely mechanical and must not re-derive any of it. Produce,
   and hold for Phase 5:
   - **Title**: `<COMMIT_TYPE>(<TICKET>): <ticket summary>` (`COMMIT_TYPE`
     from Phase 0). The title matters beyond readability: the target
     repo's CI computes its semver bump from the squash-merge commit
     message on `<targetRepo.defaultBranch>`, and GitHub uses the PR title as that message, so
     a correctly-typed title is what makes `feat` tickets bump minor and
     `fix` tickets bump patch on merge.
   - **Body**, in exactly this shape (same as `push-branch`'s template):

     ```markdown
     ## Jira Ticket
     JIRA_BASE_URL/browse/TICKET

     ## Changes
     - <concise bullet — what changed, not how>
     - <one bullet per AC or logical change; 3-8 bullets, single flat list>

     ## QA Notes
     Manual testing steps:

     1. <action from qa_notes entry 1>
     2. Expected: <result from qa_notes entry 2>
     ...
     ```

     Replace `TICKET` with the actual ticket key and `JIRA_BASE_URL` with
     the site URL from `getAccessibleAtlassianResources` (already called in
     Phase 0). The `## QA Notes` list is the `qa_notes` array from step 6,
     numbered, in order. No other sections — no "Core Architecture,"
     "Files Changed," "Migration Notes," or similar — with one exception:
     when this change adds settings to `.envrc.example`, add this line
     right after the `## Changes` bullets:

     ```markdown
     New settings: `NAME_ONE`, `NAME_TWO` (in `.envrc.example` with fake values) — add the real INT value to your .envrc
     ```

     And when step 1 recorded `preexisting_failures`, append this section last:

     ```markdown
     ## Pre-existing failures
     These tests also fail on unmodified `origin/<defaultBranch>` <sha>; not caused by this change:
     - `<file> > <test name>`
     ```

     Also add one `qa_notes` entry at the end: "Note: <n> test(s) fail
     pre-existing on `origin/<defaultBranch>` <sha>, not caused by this
     change — see the PR's Pre-existing failures section." The result line
     says the same in a few words.
   - **Never write an absolute filesystem path into the title or body** —
     this machine's home directory is an email address, so an absolute
     path leaks PII into a PR anyone with repo access can see. Refer to
     files by repo-relative path only (e.g. `src/client/App.jsx`, not
     `/Users/<email>/Desktop/repo/src/client/App.jsx`). The same rule
     extends to any raw env var value, `.envrc`/`.env` content, or
     credential/token/key/password value — the worktree's env is the
     loop's fake env, but a person's real values may still turn up in
     logs, fixtures or a misconfigured machine, so treat any value as
     secret (defense in depth). Report
     presence/shape only, mirroring whatever `hasClientSecret`/length-only
     pattern the target repo's own app logging already uses (e.g. "reads
     `API_KEY` from env" or "token present, 42 chars"), never the literal
     value.

### Phase 5 — PR

Mechanical only. All reasoning finished in Phase 4 step 7; do not rewrite,
reorder, or "improve" the title or body here.

0. **If `PUSH_MODE=host` (`push=host`), do this instead of steps 1 onward:**
   - Do not read `PUSH_BRANCH_SKILL` and do not push.
   - Run `git status --porcelain`. It must be empty (every change
     committed). If it is not, commit nothing new: bounce `env_setup`
     naming the dirty files. Never guess-commit.
   - Do not rename the branch. The host's `push-branch` runs the version
     guard.
   - Write `verdict.json` with `outcome: "ready_to_push"`,
     `phase_reached: "pr"`, `pr: null`, `branch` (the literal current
     branch name), `pr_title` and `pr_body` (Phase 4 step 7, verbatim),
     plus all the usual metrics and `qa_notes`.
   - Run Cleanup. The work is all committed, so the worktree is removed
     (the loop makes its own worktree to sign and push).
   - Stop. The result line says the run is ready to push.
   - Then go straight to Cleanup; skip steps 1–4 of this phase.

1. Read `PUSH_BRANCH_SKILL` (the `push-branch=` path you were given, else
   `~/.claude/skills/push-branch/SKILL.md`) with `Read` and follow it
   exactly, in its **content supplied** mode (`--title` + `Body:`), passing:
   the title and body from Phase 4 step 7 verbatim, and `--no-jira`
   (the loop runner, `src/roles/dev/phase.ts`, owns the Jira transition and QA Notes field from
   `verdict.json`; `push-branch` must not also transition the ticket).
   When that skill pushes, push with the literal branch name (e.g.
   `git push -u origin TARS-1301-delete-tv-objects`) or `HEAD`, never a
   shell variable: the unsafe-git hook denies a push argument it can only
   know at run time.
   Read the file rather than invoking it as a skill: `Skill` is not in
   `ALLOWED_TOOLS` (`src/roles/dev/tools.ts`), so a nested skill call is unavailable
   in this headless run. That skill lives on the operator's machine, not in
   this repo. **If that file does not exist** (at the path above; never look
   for it anywhere else), do not
   improvise your own push/`gh` steps (that would be a second copy of the
   logic): bounce with `failure_category: "env_setup"` and evidence naming
   the missing path.
2. What `push-branch` does with that input, so nothing here duplicates it:
   pushes with hooks (a failed push stops the run), then creates the PR, or
   edits it in place when one already exists for the branch (a re-run after
   a partial failure updates the PR rather than failing on a duplicate).
   Pass the title and body inline on the `gh` command line, never via
   `--body-file`.

   **The secret-content backstop still applies** — a `PreToolUse` hook
   (`.claude/hooks/block-secret-comments.sh`) denies any `gh pr create`/
   `gh pr edit` command whose content matches a known secret name or
   format pattern (see `CHANGELOG.md`'s "Round 2" entry) — but that hook
   is a heuristic backstop, not a replacement for following the Phase 4
   step 7 rule; it won't catch every shape a secret could take. The hook
   requires `jq` on PATH (its only external binary dependency); if `jq` is
   missing it fails closed and denies every Bash call, not just PR writes,
   with a message naming `jq` specifically.
   Since the hook reads the command string, the body must appear inline in
   the command — which is why `--body-file` is forbidden.

3. Write `verdict.json` in `RUN_DIR` (see schema below) with
   `outcome: "landed"`, `phase_reached: "pr"`, the PR URL, and all recorded
   metrics.
4. Run Cleanup (see below), then emit the always-emitted result line and
   stop.

## Pre-existing failures blocking a hook

Reached from Phase 0 step 5a, or whenever a `git commit` or `git push` in
this run is rejected by a hook that runs the suite and every failing test
is on `baseline_failures`. A failure that is not on that list is this
change's own defect: fix it, never route it here. **Never bypass the hook**:
never `--no-verify`, `-n`, `HUSKY=0` or `core.hooksPath`. The goal is to
make the hook pass honestly, with the fix itself landing in its own PR.

1. **Decide the fix size.** A follow-up *fix* is allowed only when it
   changes only test files (test setup, stubs, env defaults inside the
   test, fixtures) and every file it touches can be named up front. A
   failure that needs an application-code change is a real bug: skip to
   step 6.
2. **File the follow-up ticket** with `mcp__atlassian__createJiraIssue` in
   the same Jira project and issue type `Bug`, summary
   `Fix pre-existing test failures on <defaultBranch> (found by <TICKET>)`,
   and a description listing each failing test, its assertion output (no
   secret values, same rules as the PR body), the baseline SHA and, for a
   fix, the files it will touch. Copy the ticket's `repo:` label only;
   **never add the pipeline trigger label** (`pipeline:*`), so the loop
   never picks the follow-up up on its own. Link it with
   `mcp__atlassian__createIssueLink`, type `Relates`, to `<TICKET>`.
   Record its key as `FOLLOW_UP`.
3. **Fix it on its own branch, off `origin/<targetRepo.defaultBranch>`**,
   never off this ticket's branch:

   ```bash
   git -C <REPO_DIR> worktree add \
     <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>-fu \
     -b <FOLLOW_UP>-fix-preexisting-tests origin/<targetRepo.defaultBranch>
   ```

   Install dependencies as for the run's worktree. Make the minimum
   test-only change, run the formerly failing tests (they must pass) and
   the full suite (it must be green apart from failures that a test-only
   change cannot reach; if any remain, stop and go to step 6). Commit
   `fix(<FOLLOW_UP>): fix pre-existing test failures on <defaultBranch>`,
   with the hooks running normally. Push it and open its PR exactly as
   Phase 5 does (push-branch, content supplied, `--no-jira`), with title
   `fix(<FOLLOW_UP>): fix pre-existing test failures on <defaultBranch>`
   and a body in the Phase 4 step 7 shape whose Jira link is the
   follow-up's. Record its PR URL. Then
   `git -C <REPO_DIR> worktree remove <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>-fu`.
4. **Carry the committed fix into this ticket's worktree, unstaged**, only
   while a commit or push needs the hook to pass:

   ```bash
   git -C <REPO_DIR> diff origin/<targetRepo.defaultBranch> <FOLLOW_UP>-fix-preexisting-tests > <RUN_DIR>/follow-up.patch
   git apply <RUN_DIR>/follow-up.patch        # in this ticket's worktree; working tree only
   ```

   Before **every** commit and push while it is applied: stage only this
   ticket's files by name (never `git add -A`, never `git add .`), and
   check `git diff --cached --name-only` lists none of the patch's files
   (`git apply --numstat <RUN_DIR>/follow-up.patch` names them). Before the
   push, also check `git diff --name-only origin/<targetRepo.defaultBranch>...HEAD`
   lists none of them. If a patch file overlaps this ticket's own scope,
   stop and bounce `env_setup` naming the file: the two changes cannot be
   separated.
5. **Remove it** as soon as the push is done, and in Cleanup whatever the
   outcome: `git apply -R <RUN_DIR>/follow-up.patch`, then check
   `git status --short` shows none of the patch's files. In the ticket's
   PR body (Phase 4 step 7), the `## Pre-existing failures` section adds:
   `Fixed separately in <follow-up PR URL> (<FOLLOW_UP>); merge it first or
   alongside.`
6. **Files-only follow-up** (no fix possible within step 1's limits, or
   step 3 could not get the suite green): file the ticket as in step 2 but
   with a description of what was found and why it is not test-only, link
   it with `mcp__atlassian__createIssueLink` so `<TICKET>` **is blocked by**
   `<FOLLOW_UP>`, record `follow_up: {"ticket": "<FOLLOW_UP>", "pr": null}`,
   and bounce `tests_flaky` naming the failures and the follow-up key. The
   blocker gate keeps `<TICKET>` out of the queue until the follow-up's PR
   merges.

Record `follow_up: {"ticket": "<FOLLOW_UP>", "pr": "<url or null>"}` in
`verdict.json` whenever a follow-up was filed. Never file a second follow-up
for the same failures: before step 2, search for an open ticket whose
summary starts `Fix pre-existing test failures on <defaultBranch>` and that
names the same tests (`mcp__atlassian__getJiraIssue` on any linked issue),
and reuse it and its open PR if one exists.

## Cleanup (hard gate, every run)

Before this skill's final result line — regardless of outcome (landed,
bounced at any phase, or error):

1. **If you (or `qa-agent`) started the target repo's dev server, stop it.**
   Confirm it's actually stopped (e.g. the port is free), not just that you
   sent a stop signal.
2. **Remove this run's worktree** — with one exception:
   - If the run **landed** (branch pushed, PR open), reached
     **`ready_to_push`** (under `push=host` everything is committed), or
     **bounced with all in-progress work already committed** — remove it:
     `git -C <REPO_DIR> worktree remove
     <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>`. The branch
     itself lives on in the remote (landed) or in that checkout's branch
     list (bounced) either way — removing the worktree doesn't lose
     anything.
   - If the run is **bouncing with uncommitted work still in the working
     tree** (e.g. mid-Green, or Red confirmed but not yet fully
     implemented) — **keep the worktree**, and say so explicitly in the
     bounce `detail` / result line (e.g. "worktree left at
     `<REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>` for inspection") so a
     human or `ticket-refine`'s revision pass can inspect exactly what was
     tried. This is the only case where cleanup is conditional — everything
     else removes the worktree unconditionally.

Both apply even if you never reached Phase 0's worktree setup (nothing to
clean up, but check before assuming so) and even if the run is about to
bounce or error out. Aside from the single uncommitted-work exception
above, this is not conditional on how the run concludes.

## Bouncing (any phase)

A bounce is a normal, successful exit of this skill — not a crash. On any
bounce:

1. Run Cleanup (see above) — it applies regardless of why this run is
   ending; a bounce is not an exception to it, aside from the one
   uncommitted-work case Cleanup itself carves out.
2. Write `verdict.json` with `outcome: "bounced"`, the `phase_reached` you
   stopped at, a `failure_category` from the closed enum (see below), and a
   `detail` string with concrete evidence (file paths, test output excerpts,
   the specific AC or scope line that's the problem) — never a vague "this
   was unclear."
3. Emit the always-emitted result line and stop. Do not attempt any further
   phases.

**Closed failure_category enum** (never invent new values):
`spec_ambiguous · spec_contradicted · blocked · too_large · tests_flaky · env_setup · verify_rejected · subagent_stall · merge_conflict · agent_error · killed_ceiling`

This skill will only ever self-report `spec_ambiguous`, `spec_contradicted`,
`too_large`, `tests_flaky`, `verify_rejected`, `env_setup`, `merge_conflict`,
or `blocked` — the remaining categories (`subagent_stall`, `agent_error`,
`killed_ceiling`) are the loop runner's own failure modes, not this skill's.

## verdict.json schema

Write to `RUN_DIR/verdict.json` (never elsewhere — the loop runner reads it
from this exact path, and only from there):

```json
{
  "outcome": "landed | bounced | error | ready_to_push",
  "phase_reached": "intake | plan | red | green | verify | pr",
  "failure_category": null,
  "detail": "the always-emitted result line's content, without the RESULT: prefix",
  "red_confirmed": true,
  "verify_loops": 1,
  "retries": 0,
  "skill_version": "<git SHA of this SKILL.md's commit in dev-loop>",
  "model": "sonnet",
  "pr": "https://github.com/fandango/webtarsthree/pull/123",
  "branch": "TARS-1301-delete-tv-objects",
  "pr_title": "TARS-1301: delete tv objects",
  "pr_body": "<the Phase 4 step 7 body>",
  "cost_usd": 0,
  "tokens": { "in": 0, "out": 0 },
  "qa_notes": [
    "Navigate to `/rotten-tomatoes/critics?query=tina+kakad`",
    "Expected: the Self-Service badge appears next to the critic's name"
  ],
  "preexisting_failures": []
}
```

`branch`, `pr_title` and `pr_body` are optional, and required when
`outcome` is `ready_to_push` (only under `push=host`; `pr` is `null` then).
`branch` is the literal current branch; the title and body are Phase 4
step 7 verbatim. `pr_title` is at most 200 characters with no `"`,
backtick, `$`, `\` or newline (the loop rejects it otherwise). Omit all
three otherwise.

`follow_up` is optional: `{"ticket": "<KEY>", "pr": "<url>" | null}` when
the run filed a follow-up for pre-existing failures that blocked a hook
("Pre-existing failures blocking a hook"); omit it otherwise.

`preexisting_failures` is optional: the `"<file> > <test name>"` of each
test that failed on the branch and identically on the unmodified base
branch (Phase 4 step 1). Omit it or leave it empty when there were none.

`cost_usd` and `tokens` are left as `0`/zeros by this skill — the loop
runner derives the real values from `claude -p --output-format json`'s own
usage report, not from anything this skill self-reports (a skill cannot
reliably know its own total cost from inside the run).

`qa_notes` is optional — omit it (or write an empty array) on a `bounced`
or `error` outcome with nothing to report; the loop runner falls back to
a PR-link stub in that case. On a `landed` outcome, always populate it per
Phase 4 step 6 above. The PR body's `## QA Notes` (Phase 4 step 7) carries
this same list.

## Invocation (for the loop runner)

```
claude -p "/ticket-to-pr <TICKET-KEY> run-dir=<abs RUN_DIR> repo-dir=<abs REPO_DIR>" --model sonnet --permission-mode acceptEdits --output-format json
```

`src/worker/skill-runner.ts` builds this prompt from validated values only
(`src/core/build-prompt.ts`), creates `RUN_DIR` first, spawns from the
dev-loop checkout's root, and reads `RUN_DIR/verdict.json` afterwards.
`--model sonnet` is explicit, not ambient-default — this skill is the
literal-minded executor tier per the spec (§5.0), never the tier that
questions the spec. `qa-agent` pins its own model in its frontmatter and does
not inherit this invocation.
