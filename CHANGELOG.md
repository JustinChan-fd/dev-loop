# Changelog

Notable fixes and behavior changes to the pipeline itself (not the tickets it
processes). Newest first. Add an entry whenever you fix a bug a human had to
diagnose from a real run.

Tag every bullet with where it applies: `[core]` (src/core, both phases),
`[research]` (research phase only), `[dev]` (dev phase only), `[hooks]`
(`.claude/hooks`, `.claude/settings.json`).

History before 2.0.0 lives in two files, one per former repo:

- [docs/changelog/dev-loop-legacy.md](docs/changelog/dev-loop-legacy.md)
- [docs/changelog/research-loop-legacy.md](docs/changelog/research-loop-legacy.md)

## [Unreleased]

Run watcher (POC; merge pending user review). Design:
[run watcher](docs/superpowers/specs/2026-11-20-run-watcher-design.md),
plan [2026-11-20-run-watcher](docs/superpowers/plans/2026-11-20-run-watcher.md).

- `[core]` **`npm run dashboard`: a local, read-only live page of the runs.**
  `src/dashboard/` serves http://127.0.0.1:4317/ (`--project=<name>`,
  `--port=<n>`, `--root=<dir>`). Runs view: live and finished runs as cards
  with a labeled step bar that shows where a finished run ended and how (a
  bounce is indigo, never red), the latest message, and the full log grouped
  by step. Timeline view: by run, by worker, or every progress line. Batch
  view: an empty state until batch mode exists. It reads v2 logs only
  (`runs/v2`, `.pipeline/v2`; not the reset archive), updates over SSE from
  `fs.watch` plus a 2-second poll, and never writes a file, touches a lock or
  calls Jira or GitHub (a structure test checks the code for writes,
  spawns and `fetch`). Step lists come from each skill's declared progress
  phases: dev is `intake, plan, red, green, verify, pr`, with no `qa` step.
  A lock with a dead process is a warning, not a running card. `package.json`
  gains the one `dashboard` script line; no new dependencies.
  From a git worktree it reads the main checkout's logs by default (a
  worktree's own `runs/` are empty). A finished run's summary shows two
  whole lines and opens in full on click.

  Pillar check (each change against each pillar):

  | Change | Agents judge, loop does mechanics | Handoff is a contract | Security | TDD | A bounce beats a guess | Plain loop unchanged |
  |---|---|---|---|---|---|---|
  | `src/dashboard/model.ts`, `read.ts` (pure model, read-only reader) | fine: plain tested TypeScript, no agent | fine: reads facts (logs, locks, pids), acts on nothing | fine: reads only; `run_dir` paths are checked against the v2 run-dir shape before any read | fine: RED then GREEN commits | fine: a missing or unreadable file is said ("log gone", lock warning), never guessed | fine: no loop file changed; it reuses `paths.ts`, `config.ts`, `isProcessAlive` |
  | `src/dashboard/server.ts`, `page.html` | fine | fine | fine: 127.0.0.1 only, Host check, `/log` only for runs in the snapshot, no env file loaded (the Jira token never enters it) | fine: server tests RED then GREEN | fine | fine |
  | `package.json` `dashboard` script | fine | n/a | fine: no `--env-file` | covered by a structure test | n/a | **bend**: `package.json` is shared with the loop's scripts. One line added, nothing else touched. Acceptable: the brief asks for `npm run dashboard`, and no other script changes |
  | Docs (README, guide `DATA.companions`, future-enhancements, spec, plan) | fine | n/a | n/a | n/a | n/a | fine: the guide only adds a "Watch it" line; no step in the loop's picture changes |

  One **bend** on scope: the dashboard reads a lock's pid liveness with the
  loop's own `isProcessAlive`, which runs `ps -o lstart=`. It is read-only,
  and it is the same check the loop uses, so the dashboard and the loop agree
  on what "live" means.

Dev-loop sessions in sbx (`npm run claude:sbx`). Design:
[claude:sbx](docs/superpowers/specs/2026-11-20-claude-sbx-design.md).
Found on 2026-11-20, before an overnight unattended build: the robot ran in
sbx for target repos, but work on dev-loop's own code ran on the host with
permissions bypassed.

- `[core]` **`npm run claude:sbx`: Claude Code on dev-loop itself, inside a
  sandbox.** It is the same as plain `claude --dangerously-skip-permissions`
  (unchanged), but inside sbx:
  - `sbx create --clone`: the sandbox gets its own clone, and the host
    checkout is read-only and never written;
  - GitHub is denied for this sandbox only;
  - there is no signing key inside;
  - npm installs from nexus3;
  - superpowers is mounted read-only (`--plugin-dir`);
  - `.overnight/in` is mounted read-only and `.overnight/out` writable.

  A real sandbox check runs before Claude starts: Linux, `/home/agent`, no
  readable SSH key, a read-only clone source, and GitHub not reachable.
  sbx also mounts the whole host checkout read-only (ignored files
  included), so it refuses to start while a real env file is anywhere in
  the checkout. A sandbox that fails it is
  removed. `--overnight --prompt-file=.overnight/in/<f>.md` runs it detached
  under `screen` and `caffeinate`. Config: `sbx.session.config.json`, whose
  `sandbox.sbx` block is checked by the same validator as a project's. The
  decisions are pure functions in `src/sandbox/sbx/session.ts`, with tests.
- `[core]` **`npm run claude:sbx:sync` brings the sandbox's branches back,
  re-signed, and never pushes.** It also runs when an attended `claude:sbx`
  exits.
  - It fetches the `sandbox-<name>` remote.
  - It refuses unsafe branch names, names that would shadow a ref
    (`origin/main`, a tag), names that differ only in case (the Mac's disk
    folds case: `MAIN` would land on `main`), merge commits, unrelated
    history and commits on `main` (`main` is never moved). One bad branch is
    reported; the others still sync.
  - A branch where any commit touches a protected path, in any case, is held
    until `--allow-protected`: `.claude/` (settings, hooks, skills, agents), `CLAUDE.md`, `scripts/check-*`, `.github/`, `.mcp.json`, `package.json`, `package-lock.json`, `.npmrc`, `sbx.session.config.json`.
  - Each commit is rebuilt with `git commit-tree -S` on the host (same tree,
    same message plus a `Sandbox-Commit:` trailer, the host's identity). The
    trees and signatures are checked before a local branch is created. An
    existing branch, in any case, is never moved.
  - It prints the look / keep / drop commands.
  - It is tested against real git (`test/sandbox/sbx/session-sync.test.ts`).
- `[core]` **Main is PR-only.** On GitHub, `main` requires a PR, allows no
  force-push and no deletion, and enforces this for admins too (set
  2026-11-20). The stale `core.hooksPath = app/.husky` was removed from the
  local `.git/config`. dev-loop has no `app/`, so no hooks ever ran from it.
- `[core]` **New pillar (CLAUDE.md): long unattended work runs in a sandbox,
  and you're asked first.** Sandbox or host is the user's call each session.
  Unsandboxed is an explicit choice, never the default. Every change reaches
  `main` through a PR the user merges. README "Starting a session" and
  `docs/sandbox-sbx.md` "Dev-loop sessions" show the two commands side by
  side. The guide is now v1.1.0: pillar 06 "We follow our own rules" and
  section 05 "How we build dev-loop".
- `[core]` **Sync counts only the sandbox's own commits.** Found in the
  user's smoke run (2026-11-21). `smoke/test` was cut from the unmerged
  `feat/claude-sbx`, and sync measured "new" against `main`. It counted the
  host's own 4 unmerged commits (which touch `CLAUDE.md` and `package.json`)
  as sandbox work and held the branch as protected. That was safe (nothing
  was created or moved) but wrong. "New" is now what no host branch, tag or
  `origin` ref has. Those commits are re-signed on top of the host commit
  they grew from, and the "look" line diffs from that commit, not `main`.
- `[core]` **Sync catches a branch git made straight from the sandbox.**
  Found syncing run 2 (2026-11-21). Sync held `feat/run-watcher` (it touches
  `package.json`), so only `sandbox-<name>/feat/run-watcher` existed. Then
  `git worktree add <dir> feat/run-watcher` let git pick that remote ref and
  make a local branch with the sandbox's unsigned commits. The
  `--allow-protected` rerun saw nothing new and said nothing. Now a local
  branch whose upstream is the sandbox remote, and not the one sync signed,
  is reported as failed with `git branch -D` to fix it. Sync never moves or
  deletes it. The "held" message also says not to check out or add a
  worktree for the branch until it's synced. Found by the overnight session;
  the user had already deleted the branch and re-synced.
- `[core]` **`--overnight` no longer stops its own subagents after 10
  minutes.** Found in the first overnight run (2026-11-21), which ended after
  12 minutes with no commits. The sandboxed `claude -p` passed the check, ran
  `npm ci`, cut both branches off `main` and started two builder subagents,
  then ended its turn. `claude -p` stops background tasks 10 minutes after
  the last turn unless `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`. The loop
  sets that for its own runs; the launcher didn't. `--overnight` now always
  passes it as 0 and runs `claude -p` with stdin from `/dev/null`, which
  removes a 3 s wait. Its prompt says that `origin` is the host's checkout
  and that the run ends when the turn does. The session relaunched it with
  the variable set (run 2).
- `[core]` **`--overnight` shows what it's doing, live.** It was hard to
  tell what was happening: the log held only `claude -p`'s final answer. It
  now runs with `--output-format stream-json`, and a host-side filter
  (`scripts/claude-sbx-stream.mjs`, pure formatter `formatStreamLine`, with
  tests) prints one line per event to `.overnight/logs/<name>.log` and the
  screen session: tool calls, the agent's words, short results, `↳` for
  subagents, and the final cost and turns. Secrets are redacted and control
  characters stripped. The raw events are kept in `<name>.jsonl`.
  `--stream` follows the log in the launching terminal; Ctrl-c there stops
  only the watching. The filter can't take the run down with it: it guards
  every write and reads to the end.
- **Bend, written down:** `scripts/claude-sbx.mjs` (the thin launcher that
  runs sbx, screen and git) has no unit tests of its own, like the existing
  `scripts/sbx.mjs`. Every decision it makes is a pure function in
  `src/sandbox/sbx/session.ts` or `session-sync.ts`, with tests, and the
  script itself was proven by the live runs and the user's smoke run.
- **Bend, written down:** this change was built in a host session, not in
  `claude:sbx`, because the launcher didn't exist yet. Every later change
  to dev-loop is offered `claude:sbx` first.

Guide versioning. Design:
[guide versioning](docs/superpowers/specs/2026-11-20-guide-versioning-design.md).

- `[core]` **The guide page has its own version and a "What's new" page.**
  `docs/guide/how-dev-loop-works.html` now carries `DATA.guideVersion`
  (starting at 1.0.0) and `DATA.loopVersion`, and its footer reads "Guide
  v1.0.0 · checked against dev-loop 2.2.0 · 2026-11-20 · What's new". The
  new `docs/guide/changelog.html` lists each guide version with an anchor
  (`#v1-0-0`), so a link can point at one. Both pages read the entries from
  one file, `docs/guide/guide-changes.js`. v1.0.0 is backfilled from the 14
  commits that touched the guide. Bump rule (CLAUDE.md, "The guide page"):
  patch for wording, minor for a new section, step or repo, major for a
  restructure. A vitest check (`test/guide/guide-version.test.ts`) fails
  when the page's version, date or loop version drifts from the newest
  entry or package.json. GitHub Pages already publishes all of
  `docs/guide/`, so the new page needs no workflow change.

Bounce criteria v2. Design:
[bounce criteria v2](docs/superpowers/specs/2026-11-20-bounce-criteria-v2-design.md),
plan [2026-11-20-bounce-criteria-v2](docs/superpowers/plans/2026-11-20-bounce-criteria-v2.md).
Found on MC-1435 (bounced XL after 86 s with no grounding, then landed for
$1.73 in 8.5 min) and catalog PR #237 (4 of 6 review fixes were things the
POC showed but no AC covered, behind a "this spec wins" clause).

- `[core]` **A pending handoff on a closed ticket is dropped, never built.**
  Found in the post-merge log reconcile: MC-1718, a research-only test clone,
  landed research and was then closed in Jira, but the log still showed it as a
  pending research → dev handoff. The next worker-mode run would have swapped
  its label and run dev on a closed ticket. Step 1 now reads the ticket's Jira
  status before retrying a handoff. If the ticket is in the Done category, the
  loop writes one phase-less `handoff-dropped` record, which resolves the
  pending handoff. If the status can't be read, the handoff stays pending.
- `[research]` **too_large is judged after Ground, against real history.**
  Only for two or more separately mergeable deliverables (with a split) or a
  real risk to the dev limits (naming comparison tickets and risk factors).
  AC count alone is never evidence; a design choice is `spec_ambiguous`; a
  person's scope ruling is final. The loop writes `RUN_DIR/size-context.json`
  (dev limits, median/p90 cost and minutes, per-ticket cost, QA loops, diff
  size, research's estimate) before every research run.
- `[research]` **Attachments become ACs.** Each design attachment is
  inventoried (new component: everything plus layout; change: the delta;
  styling: one line) and each item maps to an AC or a named out-of-scope
  line, recorded as `attachment_coverage`. No blanket "spec wins". The
  verifier checks it (item 9); qa-agent names the POC element.
- `[research]` **The loop checks the research verdict before acting**
  (`src/roles/research/verdict-checks.ts`): a too_large without a ground
  phase or `size_evidence` is refused (agent_error, runs again); a ready
  verdict with an unreadable attachment becomes a `blocked` bounce with a
  Jira comment; a ready verdict missing coverage is warned for the first
  `roles.research.attachmentCoverageWarnRuns` (default 5) runs, then refused.
- `[research]` `size_estimate` and `ac_count` are logged on every research
  run, bounced ones too, so estimate can be compared with actual.
- `[core]` **Evals run from either path case.** `evals/lib.sh` `assert_clone`
  compared `git rev-parse --show-toplevel` with `pwd -P`, which keep different
  cases on case-insensitive macOS, so a run from `~/Desktop/repos/dev-loop`
  failed preflight with "git root mismatch" (the user's live `clean` eval,
  2026-11-20). It now asks git whether the folder is the repo root
  (`--show-prefix` empty); a folder inside another repo is still refused.
- `[dev]` A landed dev entry records its PR's `diff_stats`
  (`gh pr view --json changedFiles,additions,deletions`). One-off backfill
  for older PRs: `scripts/backfill-diff-stats.mjs` (writes a sidecar, never
  the logs).

Live check (2026-11-20): MC-1718, a clone of MC-1435's description as it was when it bounced, passed research for $2.46. It was grounded first and sized M. It named mockup variant B and listed A and C as out of scope, and wrote no "spec wins" clause. The verifier's coverage check found unmapped mockup items, for example the tile groups, quality chips and footer, and they were mapped over 3 fix rounds. All 3 attachments are in `attachment_coverage`. The loop's check accepted it.

Pillar check: agents judge (fine: the agent still makes the size and
coverage calls; the loop supplies facts and checks the parts exist). Loop
does the mechanics (fine: stats, diff stats and checks are tested
TypeScript). Handoff is a contract (stronger: new required fields, refused
when missing). Security (fine: `gh` runs on the host, read-only; no new
agent access). A bounce beats a guess (stronger). TDD (fine). Plain loop
unchanged (fine: a project with no history or attachments gets one extra
file and no behaviour change). **Bend:** the loop itself turns a `ready`
verdict into a `blocked` bounce when `attachments.json` shows an unreadable
attachment. Acceptable because it acts only on the manifest the loop wrote,
a mechanical fact, and the rule is the user's own decision (an attachment
is a resource the ask rests on); the agent's judgment is not overridden on
anything it could have read.

## [2.2.0] — 2026-11-20

The sbx sandbox adapter, project profiles, and catalog-ui-management on v2.
First real catalog run (MC-1435): blocked by a cross-repo ticket, then too
large, then missing its attachments; each turned into a fix below, and the
ticket then passed research and went to dev. Designs:
[sbx sandboxed spawns](docs/superpowers/specs/2026-11-12-sbx-sandboxed-spawns-design.md),
[project profiles](docs/superpowers/specs/2026-11-20-project-profiles-design.md).

- `[core]` **Ticket attachments reach the agents.** Found on MC-1435: research
  bounced `spec_ambiguous` because the response sample was a Jira attachment it
  could not open (no download tool, and sbx blocks the media host). Before
  every spawn, both roles and every project, the loop now downloads the
  ticket's attachments on the host into `RUN_DIR/attachments/`, with
  `RUN_DIR/attachments.json` naming each as fetched, skipped (type or size:
  text-like and images only, 2 MB each, 10 MB per ticket) or failed. No new
  tool, network rule or credential reaches the agent; it reads files.
- `[dev]` catalog-ui-management's dev limits are raised to $40 and 150 minutes per run,
  and its per-ticket cap to $90, so one XL ticket (MC-1435, about 30 files) can
  land as one PR. The other projects keep $20 and 75 minutes.
- `[core]` **A blocker can clear on its Jira status** (`jira.blockerClearedStatuses`).
  Found on the first catalog run: MC-1435 "is blocked by" MC-1431, a
  catalog-svc-management ticket already Deployed to INT. The gate only knew
  merged PRs in this repo, so it skipped MC-1435 as needing a human. Now a
  blocker in a listed status (exact name) or Jira's Done category clears.
  The three project configs list Development Complete through Deployed to
  PROD. The eval config and any config without the list keep the old rule.
- `[core]` **Project profiles** (spec `docs/superpowers/specs/2026-11-20-project-profiles-design.md`).
  A project config may carry `targetRepo.local`: its app folder, Node version
  file, env template (and its format), extra real env files, robot-only
  settings, dev command and URL. No block means today's behaviour
  (webtarsthree has none). `src/core/project-profile.ts` resolves it once at
  startup (the project's Node major from origin, the matching host nvm
  install; a missing one is a startup error naming `nvm install N`), and the
  loop writes `RUN_DIR/project.json` for the skills.
- `[core]` The robot's fake env comes from the profile's template, plain
  dotenv included, plus `robotEnv`, and puts the project's Node on the
  robot's `PATH` (a no-op inside sbx).
- `[core]` **Fix:** a person's own worktree under `.claude/worktrees/` got the
  robot's fake values when the repo has no root `.envrc` (catalog: they
  would override the person's real `app/.env.local`). A non-robot shell now
  gets the real root `.envrc` if any, and never the fake.
  Inside sbx the marker `DEVLOOP_ROBOT_ENV` is now forwarded (default env
  allowlist), and the sbx preflight checks that a robot shell really gets the
  fake's first setting. Found in the final review: without the forward, the
  new handover would have left every sbx run (webtarsthree's too) with an
  empty fake env.
- `[core]` A project with a Node version file and no clone yet is a startup
  error ("clone … there first"), never a silent run on host Node.
- `[core]` The robot's Read deny covers the env files at the top of the app
  folder and the profile's `realEnvFiles` (catalog: `app/.env.local`).
- `[core]` The sbx preflight checks the image's Node against the project's
  major, not the host's, and names the build command
  (`npm run sbx:template:build -- --tag=v2-nodeN --node=N`); it also refuses
  an env file in the app folder of a repo inside dev-loop's folder.
  `template.sh` waits for the image's own boot-time apt run (the apt lock
  failed two builds).
- `[dev]` Host push runs `npm ci` in the app folder, puts the project's Node
  first on `PATH` for `npm ci`, the signing git calls and the push, and its
  hook/package guard also matches `<appDir>/.husky/`.
- `[dev]` `[research]` ticket-to-pr, qa-agent, ticket-refine and recon-agent
  read `RUN_DIR/project.json`: installs, tests and the dev server run in
  `<worktree>/<appDir>`; ticket-to-pr checks the Node major after install
  (`env_setup` bounce) and logs an `installed:` note. The skills follow the
  target repo's own `CLAUDE.md`/`AGENTS.md`, never create `.env.local`, and
  name no project.
- `[core]` catalog-ui-management moves to the v2 labels with webtarsthree's
  poll shape and an sbx block (`dev-loop-sbx:v2-node26`), with a `local`
  block for its `app/` layout. `docs/projects/` is the registry of supported
  repos.
- Evals: `clean-app` (an `app/`-layout sandbox: Node from `.nvmrc`, dotenv
  fake, a canary in the real env files, the person handover) and
  `EVAL_SANDBOX=none|sbx` for any scenario.
- `[dev]` The dev poll skips finished tickets (`statusCategory != Done`) in
  every project config. The eval closed TARS-1640 while it still carried
  `pipeline:v2:dev`, and dev ran it again instead of the new TARS-1641.
  Checked live: the old query found the closed ticket, the new one doesn't.
  The eval's close also removes every `pipeline:*` label now.
- `[core]` With no sandbox, the robot may call the Atlassian tools under
  either server's names. TARS-1640's eval (2026-11-17): the host connector
  was Atlassian's `/v2/mcp`, where the comment tool is
  `addOrEditJiraIssueComment`. The allowlist had only the v1
  `addCommentToJiraIssue`, so research's ✅ Jira comment was denied, and dev
  then bounced `spec_ambiguous` for want of it. The write hooks already
  matched both names. The skills now carry a table of both names for each
  renamed tool. They read comments with `listJiraIssueComments` where it
  exists (dev saw zero comments from `getJiraIssue` alone). With no
  `createIssueLink`, a follow-up records its link in its description.
- `[core]` Evals: tickets go under Epic TARS-1384 (TARS now requires an
  Epic), carry `repo:dev-loop-eval`, and the loop starts only once Jira
  search finds them (~30 s lag). A Jira error now prints Jira's own reason.
- `[core]` `[dev]` `[research]` The robot never sees the target repo's real
  `.envrc`. Worktrees sit inside the repo, so `direnv exec <worktree>` used
  to walk up and load the person's real keys. Now the loop writes a fake env
  at `<repo>/.claude/worktrees/.envrc` from the committed `.envrc.example`
  (placeholder values, single-quoted, never executed) and allows it. direnv
  stops there.
  - **sbx:** the target repo's top folder is no longer mounted, only its
    `.git` and `.claude/worktrees`. A read-only file over `.envrc` was
    tried and dropped: on the Mac's case-insensitive disk, `.ENVRC`
    reached the real file. Preflight checks from inside a sandbox that no
    env file shows, in any case.
  - **No sandbox:** a `Read` deny rule covers the real files (soft: a shell
    `cat` still could).
  - **Host push** names the repo dir for direnv, so it keeps the real env.
  - **A person's own worktrees** in `.claude/worktrees/` still get the real
    `.envrc`: the fake hands over to it unless `DEVLOOP_ROBOT_ENV=1`, which
    only robot spawns set.
  - **Settings parsing:** a trailing `# note` is dropped. Names that change
    how commands run (`PATH`, `NODE_OPTIONS`, `LD_*`, `GIT_*` …) are never
    overridden.
  - **Template build** no longer mounts the target repo or asks to allow its
    `.envrc`.
  - **Skills:** new settings go into `.envrc.example` with fake values, and
    the PR names them ("New settings: … add the real INT value to your
    .envrc"). A setting the fake lacks bounces `env_setup`.
  - Spec: [docs/superpowers/specs/2026-11-17-robot-fake-env-design.md](docs/superpowers/specs/2026-11-17-robot-fake-env-design.md).
- `[dev]` ticket-to-pr installs the target repo's packages (`npm ci`) in each
  worktree it creates, and bounces `env_setup` when the suite can't start
  instead of carrying on. A sandboxed TARS-1634 run (2026-11-17) found no
  `node_modules`, saw only the macOS-built ones, called vitest "not runnable"
  and handed over untested work. A probe confirmed `npm ci` + `vitest run`
  work inside the sandbox (8013 tests).
- `[dev]` `[core]` A sandboxed dev run's commits are signed on the host.
  TARS-1634 (2026-11-17) pushed unsigned commits from the sandbox and hit
  GH013 (signed commits required). When the sandbox can't sign, the loop
  passes `push=host`; ticket-to-pr stops at Phase 5 with `outcome:
  "ready_to_push"` (plus `branch`, `pr_title`, `pr_body`) instead of pushing.
  The loop then re-signs only the unpushed commits as the operator in a
  fresh host worktree, running the repo's commit hooks on each, and runs
  push-branch unchanged on haiku. If signing fails, the branch is restored
  and the run bounces `env_setup`. Re-signing keeps the branch's fork point
  (never replays onto a moved default branch). The run bounces before
  `npm ci` if the branch edits package/lock files, `.npmrc` or `.husky/`.
  The PR body is passed to haiku between markers, as data. The loop won't
  start if the target `.envrc` isn't allowed or push-branch is missing.
  Host runs are unchanged. See docs/sandbox-sbx.md section 10.
- `[dev]` A sandboxed dev run can read your `push-branch` skill. The sbx
  sandbox can't see `~/.claude`, so TARS-1634's dev run bounced `env_setup`
  at the PR step. New `sandbox.sbx.hostSkills` mounts each listed skill
  read-only at `/home/agent/.dev-loop/skills/<name>`. The adapter's new
  optional `hostSkillPaths` hook gives dev `push-branch=<path>`, and
  ticket-to-pr reads that path. Preflight checks the skill exists and is
  readable in the sandbox, and a drift test keeps the list in step with what
  the skills read. Runs on the host are unchanged: no pointer is passed, so
  dev reads `~/.claude/skills/push-branch/SKILL.md` as before.
- `[core]` reset-project, per ticket, is a checklist: it surveys local files,
  git, Jira, GitHub and the sandbox adapters, prints one table, asks
  `Proceed? [y/N]` once (`--yes` when there is no terminal), runs the rows
  (sandbox, git, local, Jira/GitHub), then prints `Ran` and `After reset`
  tables and ends `<KEY> is at zero` or the steps that need you. It now also
  resets the Jira status and label and deletes the loop's own comments (a
  loop prefix AND created inside a recorded run window), removes unpushed
  stale worktrees and branches, and removes leftover sandboxes of every
  configured adapter (`--sandbox=<name>` adds one). Both reset scripts load
  the env file; without credentials the Jira/GitHub rows say needs you. The
  reset-project skill tells agents to `--dry-run`, show the table, and rerun
  with `--yes` only after a yes. Whole-project reset is unchanged. Docs:
  `docs/reset.md`.
- `[core]` reset-project's "at zero" is stricter and safer (final review).
  A mirror Issue research would reuse is `needs you: close #<n> as not
  planned`. Only pipeline-made worktrees (`<KEY>-<RUN_ID>` and its `-ground`,
  `-baseline`, `-fu` variants) are ever removed, by any reset path; a
  person's own `<KEY>-*` worktree is reported, never removed. Worktree and
  branch rows list every item in their detail lines. The branch check never
  fetches and counts commits ahead of origin's `ls-remote` sha. The Jira rows
  run comments, label, then status, and the status move is skipped when an
  earlier Jira row failed. The attempt-cap comment is found for both roles.
  ADF emoji nodes count in a comment's first line. A held ticket is
  `needs you`. The status move runs after every other row and is held when
  any row needs you, errored or failed (e.g. a mirror Issue still open), so a
  half-reset ticket never goes back on the poll.
- `[core]` The "recently ended" poll hold is now 2 minutes (was 10) and only
  follows a run that changed the ticket's Jira status (`jira_status_changed`
  on the record). A skipped ticket logs `[worker] <KEY> skipped: a run on it
  ended <N>s|<M>m ago`.
- `[research]` A mirror Issue closed as "not planned" (what a reset leaves) is
  never reused. `main.ts` opens a fresh Issue whose body ends with
  `Previous attempt: #<n>` lines, and ticket-refine Step 0.5 reads the old
  Issue's comments as prior context only: an unverified claim, never a
  re-pickup trigger.
- `[core]` A dropped resume no longer ends the iteration. After a dev reset
  put TARS-1634 back in To Do, the dead session lock still named its old dev
  run; the next `--once` start adopted it, dropped the resume (status no
  longer In Progress) and exited without polling. A `resume-dropped` is
  bookkeeping only, so the worker now resolves every stale resume and goes
  on to poll in the same iteration. It also no longer puts the ticket in the
  "recently ended" hold (that hold covers Jira's index lag after a status
  write, and a dropped resume writes nothing), which kept the rerun idle. The
  hold has since been cut to 2 minutes and to status-changing runs only.
- `[core]` reset-project clears a dead session lock's in-flight entry for
  the reset ticket and role (so a reset run isn't "resumed"), and runs
  `git worktree prune` after deleting worktrees (the branch was otherwise
  "checked out at" a deleted dir and could not be deleted).
- `[core]` sbx preflight: the GitHub check failed about 3 times in 11 inside
  the sandbox (a garbled `gh api` reply, `git` exit 128, a cut-off exec,
  each after ~12 s; the host never failed), and the error showed direnv's
  "loading .envrc" line, not the real one. An undiagnosed GitHub-step
  failure is now retried up to 3 times, 2 s apart, with a note per retry; a
  blocked host, missing repo or SSH problem still fails at once. Errors
  skip direnv's status lines and ANSI codes, and say "exit N, no error
  output" when there is nothing else.
- `[core]` `[hooks]` sbx: the sandboxed agent's Atlassian tools are named
  `mcp__mcp-gateway__*` with Atlassian's v2 names, but the allowlist only
  named `mcp__atlassian__*`, so the second TARS-1634 run was denied
  `getAccessibleAtlassianResources` at intake. `src/core/atlassian-tools.ts`
  is now the one list of Atlassian tools; each role's allowlist comes from
  it, in the gateway form when the adapter says it proxies Atlassian
  (`atlassianMcp`). Same tools only; generic/destructive gateway tools stay
  denied. The secret-scan, comment-edit and eval-boundary hooks now match
  any MCP server name (they let an unknown name through silently before), the
  comment-edit rule covers v2's `addOrEditJiraIssueComment`, and a test ties
  the hook matcher to the list. `sbx:smoke` makes one read-only Jira call by
  the gateway name.
- `[core]` sbx: `sandbox.sbx.mcp` (webtarsthree: `["atlassian"]`) passes
  `--static-mcp`, so the sandboxed agent has Jira tools. The first sandboxed
  run (TARS-1634) failed at intake with "MCP gateway permission denied":
  the host's MCP config isn't mounted. Preflight now checks `sbx mcp ls`
  and refuses a listed server that is unregistered or not ready.
- `[core]` `--sandbox=sbx` opens the sbx dashboard in a new Terminal window
  after preflight passes (macOS, interactive runs, none already open), so
  one command starts both. `--no-dashboard` skips it; a failure only logs.
  Wired through a new optional adapter hook, `onRunStart`.
- `[core]` sbx is opt-in per run: `pipeline.webtarsthree.config.json`
  keeps its `sandbox` settings (mode, `sbx` block) but no `adapter` line,
  so a plain run uses no sandbox and `--sandbox=sbx` turns it on. Every
  adapter sub-block present is validated at load, selected or not.
  `npm run sbx:preflight` passes `--sandbox=sbx`.
- `[core]` Pipeline labels carry the major version only: `pipeline:v2` and
  `pipeline:v2:dev` (were `pipeline:v2.0.0` / `pipeline:v2.0.0:dev`). The
  version guard only ever refused a major mismatch, so the minor/patch part
  only produced a warning on every 2.x release. `labelVersion` is now
  `labelMajor`; the guard refuses the old full-version form and names the
  label to use. Tickets carrying the old labels were relabeled in Jira.
- `[core]` sbx setup, from the first real setup: a `sandbox.sbx.template`
  key (`sbx create -t <ref> --pull never`, kit still applied); `kitDir`
  accepts `~/`. Preflight now checks GitHub with `git ls-remote` over the
  SSH URL and `gh api repos/<owner>/<repo>` instead of `gh auth status`,
  which reported "not logged in" while the proxy was injecting the token;
  it names the cause (firewall approval, token access or pending org
  approval, missing HTTPS rewrite). Preflight refuses an env file
  (`.env`, `.envrc`, `.env.*`) in dev-loop's folder, which the sandbox can
  read, and warns about one in the target repo. The model aliases are
  filled from `~/.claude/settings.json` when the env lacks them.
  `--preflight-only`, and `npm run sbx:status|dashboard|preflight|cleanup|smoke|template`
  (none of them grants access).
- `[core]` sbx template as code: `sandbox/sbx/template.sh` is the recipe and
  `npm run sbx:template:build -- --tag=<t>` rebuilds it (direnv approval is
  typed by you at a prompt, never given without a terminal). Preflight
  checks `direnv` and that the target repo's `.envrc` is allowed inside the
  sandbox, since the dev skill runs every command through `direnv exec`.
- `[core]` Node 24 is now the minimum (engines >=24.0.0); a sandbox's node
  must match the host's major version (spec §4.8).
- `[core]` A `claude -p` run that exits 0 but reports a failed result
  (`is_error`, a `terminal_reason` other than `completed`, or no result at
  all) is now an `agent_error` instead of a silent success. In the sbx
  spike, a run with no credential hung for about 3 min, then exited 0 with
  `terminal_reason: api_error`; the old loop recorded that as a success.
- `[core]` Pluggable sandbox adapter for agent spawns: an optional
  `sandbox` config block and a `--sandbox=<name>` flag (CLI wins;
  `--sandbox=none` forces it off). Only the `none` adapter exists so far,
  and it keeps today's behavior exactly.
- `[core]` New iteration outcome `parked` (failure category
  `sandbox_denied`): a run the sandbox refused (network, credential,
  infra) is held without counting an attempt or touching Jira, skipped by
  the poll, and announced by a desktop notification. A failed sandbox
  prepare parks with its error message as the hint.
- `[core]` `npm run sandbox:approvals` lists parked tickets with what was
  refused and the adapter's allow hint (printed, never run);
  `--clear=<KEY>` un-parks one. It also lists discover-mode denials
  (from the ticket's latest record) under "Discovered in discover mode
  (not parked)".
- `[core]` The skill runner gives each sandboxed run its own instance name
  (`dl-<len>-<project>-<ticket>-<role>-<6 hex>`, sanitized to `[a-z0-9-]`;
  `<len>` is the project name's length, so project `a` never matches
  project `a-b`'s sandboxes; shown in the "running" line) and mounts (repo root plus the target checkout
  when it is outside it). In enforce mode a sandbox refusal returns
  `parked` before verdict.json is read; discover mode logs it and carries
  on, keeping the denials and hint (redacted) on the phase entry's
  `sandbox` block. The adapter's preflight runs once before the session lock; its
  orphan cleanup runs once after the lock, scoped to `dl-<len>-<project>-`.
- `[core]` The `sbx` adapter (Docker Sandboxes with the Keystone kit):
  each agent run gets its own sandbox with only the repo folders mounted,
  and a blocked network host is logged and parked with a printed
  `sbx policy allow` line, never run for you. Preflight refuses a mount
  path whose case differs from the disk, a kit dir with no yaml, a
  sandbox without the host's node major or without `jq`, and a missing
  GitHub login (a wrong-case mount that is not the cwd also points at
  `targetRepo.path`). It warns, without failing and naming no values,
  when an `ANTHROPIC_DEFAULT_*_MODEL` name is unset, since the model
  aliases would otherwise fall back to stock ids inside the sandbox.
  Config: `sandbox.sbx` `kitDir`, `memory`, `envAllow`. Setup:
  [docs/sandbox-sbx.md](docs/sandbox-sbx.md). Everything sbx-specific
  lives in `src/sandbox/sbx/`.
- `[core]` Sandbox prepare now times out after 300 s and the denial
  inspection after 60 s; both become infra denials instead of hanging.
- `[core]` When every refusal in a parked run is infra (daemon down,
  prepare failed), the worker pauses instead of parking ticket after
  ticket. This applies in discover mode too: discover relaxes only
  network and credential refusals.
- `[core]` Run-log phase entries and parked records carry
  `sandbox: {adapter, instance, prepare_ms}`.
- `[core]` An unknown `terminal_reason` is logged with the instruction to
  add it to `ALLOWED_TERMINAL_REASONS` if it is a new success reason.
- `[core]` Sandbox instance names are capped at 63 characters (sbx's
  limit); a project name that makes the prefix longer than 56 characters
  fails at startup. The prepare failure message is redacted.

## [2.1.0] — 2026-11-12

- `[core]` **Breaking for the command line, not for Jira:** every value
  flag is now `--name=value` only, across `npm run loop`, `reset-project`,
  `stats`, `cutover:migrate`, `cutover:relabel` and the eval tools. The
  old space-separated form (`--project webtarsthree`) exits with the exact
  replacement (`use --project=webtarsthree`), so a stale command can't
  silently do something else. Boolean flags (`--once`, `--stream`,
  `--dry-run`, `--yes`, `--write`) stay bare. A flag given twice, or a
  value on a boolean, is also an error. One shared parser,
  `src/core/flags.ts`, replaces five hand-rolled ones.
- `[core]` The version is bumped while the trigger labels stay
  `pipeline:v2.0.0`. Only the CLI changed, not the Jira flow, so worker
  startup shows the minor-mismatch warning (`label is for 2.0.0`) until
  the labels are bumped. No relabel is required.

## [2.0.0] — 2026-11-12

dev-loop and research-loop are now one repo with two phases. Run
`npm run loop -- --project <name>` (worker mode, both roles) or add
`--phase research|dev` for one role. Per-divergence
detail and evidence: [docs/migration-ledger.md](docs/migration-ledger.md).

### Pipeline guards (behavior changes)

- `[hooks]` `[core]` Eval harness (Task 16, spec §9.2): `npm run eval -- <clean|ambiguous|dev-bounce|blocked|queue>` or `--all`. It runs the real loop, `--config pipeline.eval.config.json --once`, against the private sandbox `JustinChan-fd/dev-loop-eval-sandbox`. That config's polls require `labels = "dev-loop-eval"`, and its ceilings are lower: $15 research, $10 dev, 10 runs per role per day. Pure graders (`evals/check-*.mjs`) read the v2 records plus the GitHub/Jira state, and `DRY_RUN=1` prints every outward command instead of running it. New hook `block-non-eval-jira-writes.sh`, registered on every `mcp__atlassian__` tool, is inert unless `DEVLOOP_EVAL_KEYS` is set. While it is set, the hook denies any Jira write to a key outside the list, a link with a foreign end, a `createJiraIssue` without the `[dev-loop-eval]` summary prefix, and any unknown atlassian write; it also fails closed on malformed input. A `createJiraIssue` needs all five conditions: project TARS, the `[dev-loop-eval]` prefix, the `dev-loop-eval` label, no parent (or a listed one), and no transition. Dry is the default: only exactly `DRY_RUN=0` runs live, and any other value (e.g. `true`) is refused. So far the harness is verified only with stubs. The sandbox repo, the live preflight and the first paid run each need the user's go (see `evals/README.md`).

- `[core]` The eval harness's `run_to` (`evals/lib.sh`) now stops the whole process tree on timeout (session final review I2). Before, perl's `alarm` sent SIGALRM to `npm` only; npm forwards only SIGINT/SIGTERM, so `node src/main.ts` and its paid `claude -p` child kept running past the 3.5 h cap and the next scenario's loop hit `LiveWorkerError`. The command now runs in its own process group; on timeout the group gets SIGTERM, then SIGKILL after `RUN_TO_GRACE_S` (default 40 s), and `run_to` exits 124. `evals/run.sh` also refuses live mode (`DRY_RUN=0`) when `CLAUDECODE` is set, so an agent inside a Claude Code session cannot start a paid eval (the unsafe-git checker cannot see into `bash evals/run.sh`); dry mode still works there.
- `[core]` The env file can live outside the repo (final-review I4). `loop`, `check-auth`, `cutover:relabel` and `reset-project:remote` now load `--env-file="${DEVLOOP_ENV_FILE:-.env}"`: unset, they read the root `.env` as before; set (recommended `DEVLOOP_ENV_FILE=$HOME/.config/dev-loop/.env`), the Jira token is no longer inside the `claude -p` spawn cwd, where a Bash `cat .env` could read it. Startup warns when the variable is set but a `.env` is still in the repo root (`src/core/env-file.ts`), unless the variable resolves to that root `.env` itself (compared as resolved paths); the missing-credential hints name the variable. The user moves the file; nothing moves it for them. See docs/config.md "Env file location".
- `[hooks]` `block-unsafe-git` closes three documented residuals. An unknown wrapper whose single quoted argument hides a git push/commit or gh stack (`watch '...'`, `ssh host '...'`, `npx sh -c '...'`, `tmux new '...'`) is unverifiable. `printf -v`, `read` and `mapfile`/`readarray` naming `HUSKY`/`HUSKY_SKIP_HOOKS` are denied, and naming `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_KEY_<n>` is unverifiable. A shell reading its script from stdin is analyzed by content for a here-string, a heredoc or a pipe from a literal `echo`/`printf` (`echo '...' | sh`, `bash <<< '...'`); any other stdin (`bash < f`, `cat f | sh`, `curl ... | bash`) is unverifiable. A shell script operand of `/dev/stdin`, `/dev/fd/0` or `/proc/self/fd/0` reads stdin, so it gets the same stdin rules as `-`. A nameref (`declare`/`typeset`/`local -n r=NAME`) is checked by its target with the same HUSKY/GIT_CONFIG rules, and a nameref with no target yet is unverifiable; `getopts OPTS NAME` and zsh's `vared NAME` join `printf -v`/`read`/`mapfile`. git's own exec hooks (`rebase --exec`, `submodule foreach`, `bisect run`) and interpreter one-liners remain documented residuals.
- `[core]` A signal no longer lets the worker spawn a child or count an error attempt while it stops (final re-review minor 2). Before, the cycle kept running during the SIGINT/SIGTERM handler's awaits: a phase reached between kill and exit could spawn `claude -p` (orphaned, able to push) or write an in-flight into a just-released lock, and a killed child's run was appended as an `error` record, counted against `maxAttemptsPerTicket`. Now `stopOnSignal` calls `TrackedSession.beginStop()` first, synchronously: the cycle's `setInFlight` (set or clear) never calls through and never settles, so the cycle makes no further lock writes and spawns no new child, and `canRelease()` is false. Writes outside `setInFlight` can still happen in the stop window (polls, `claimTicket`, the missing-fields comment plus its `claim-error` record, `resume-dropped` and other record appends); all are idempotent or deduped, and closing that window is parked. `killActiveChild` (and the new `stopSpawning`) set a module-level flag first, so any later spawn settles with `spawnError: "stopping: signal received"` without spawning. A killed run's flight stays marked interrupted; the next start records it `interrupted`, not an attempt. A lock write already in flight when the signal arrives is awaited first, so the handler marks a landed set interrupted and releases after a landed clear, and that write's caller freezes once it lands. A pause reached while stopping no longer exits 1 over the signal's 130/143.
- `[core]` A resume re-reads the ticket's Jira status first (final-review M5). Before, a crashed or interrupted phase run was resumed (a paid run) even if a human had since moved the ticket. `JiraClient.getStatus` is new. Both `resumeNext` and the first-iteration flight recording (`recordFlights`, before a crashed dev flight's open-PR self-heal) check it: they proceed only when the live status equals `claimStatus.to`, else append a `resume-dropped` record (no phases, not an attempt, resolves the pending resume). A dev resume also accepts `statusNames.prOpen` (Code Review, Ruling 51; found in the session final review: a signal or crash after `runDevPhase` had moved the ticket left the landed run `resume-dropped`, with no landed record for reconcile, so a later Development Complete status could start a paid dev run on a merged ticket): with an open PR it records the same `skipped-pr-exists` landed entry without a Jira transition; with no open PR (merged, closed, or lookup failed) it is `resume-dropped` ("Code Review with no open PR") and dev is never re-run. Known gap: a merged PR at that point gets no landed record yet (parked). A failed status lookup leaves the resume pending, excludes the ticket from this iteration's polls, and retries next iteration.
- `[core]` Claiming a ticket now names the field(s) Jira requires for the transition (seen on TARS-1631: `Field Story Points is required.`). The claim POST's 400 is parsed (`parseRequiredFields`) into a `ClaimMissingFieldsError`; the `claim-error` record reads `claim blocked: required field(s) missing: Story Points` and the ticket gets one Jira comment (not repeated while the field set is unchanged). Other claim failures behave as before.
- `[hooks]` `[core]` Final-review hardening. `block-unsafe-git` now sees through `direnv exec <dir>` (Ruling 31's mandated spelling had bypassed it entirely: `direnv exec <wt> git push --force` was allowed) and `find -exec/-execdir`; it denies any assignment or `export` of `HUSKY`/`HUSKY_SKIP_HOOKS` and any `GIT_CONFIG_*` naming `hookspath`; and an unknown command (`npx`, `npm exec`, `pnpm exec`, `yarn`, ...) whose separate argument words include `git` then `push|commit`, or `gh` then `stack`, is unverifiable and denied (a guarded call inside one quoted script argument, e.g. `npx sh -c '...'`, is a documented residual). Interpreter one-liners and deleting/`chmod`ing hook files remain documented residuals in the checker header. The secret scan now also covers `gh pr comment`, `gh pr review --body/-b` and `gh api -f/-F body=`. `.claude/settings.json` denies `Read(/.env*)` next to `Edit(/.env*)`. A SIGINT/SIGTERM to the worker now stops the running `claude -p` child (SIGTERM, SIGKILL after `KILL_GRACE_MS`) before marking the flight interrupted; before, a `kill <pid>` left it running orphaned, able to push beside the resumed run. Startup refuses a `targetRepo.path` that is the dev-loop root, an ancestor of it, or inside it (other than the v2 clone dir). `scripts/migrate-v1-folders.mjs --v2-from <worktree>` carries the worktree's `runs/v2` and `.pipeline/v2` into the main checkout (Ruling 40); `docs/cutover.md` is reordered (Ruling 39). `scripts/size-checkpoint.mjs` is deleted.
- `[dev]` Cutover tooling: `scripts/migrate-v1-folders.mjs` (moves both repos' v1 `runs/` and `.pipeline/` under `runs/v1/{dev,research}/` and `.pipeline/v1/{dev,research}/<slug>/`; dry run by default, refuses on an existing destination or a running loop) and `scripts/relabel-v1-refined.mjs` (adds the dev trigger label to tickets whose latest research comment is a `✅` by `JIRA_ASSIGNEE_ACCOUNT_ID`; `--write` needs `--confirm <sha256>`). Run order and approval points: [docs/cutover.md](docs/cutover.md). `npm run cutover:migrate` / `cutover:relabel`.
- `[core]` Worker mode is the default (`--phase worker|research|dev`, `src/core/cli-args.ts`): one session runs both roles via `runWorkerIteration`. Startup: config -> placeholder check -> label-version guard (worker only: an unversioned or other-major trigger label exits 1, so `catalog-ui-*` are refused until cutover; a minor/patch difference warns) -> credentials -> session (a second start names the live session and exits 1) -> adopted flights recorded -> loop. Unknown arguments and flags without a value are errors; no session test seam is reachable from the CLI.
- `[core]` Skills get their paths: the prompt is `/<skill> <KEY> run-dir=<abs RUN_DIR> repo-dir=<abs REPO_DIR>` (`src/core/build-prompt.ts`, validated; `src/worker/skill-runner.ts`). The runner creates RUN_DIR and reads only `RUN_DIR/verdict.json`; the v1 snapshot/newest-run-dir discovery (`run-dirs.ts`) and `legacyRunDirs` are deleted. `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` = the role's `runTimeoutMin` x 60000. Contract strings live in `src/core/contract.ts`, pinned in both skills by `contract.test.ts`; `test/structure.test.ts` checks `.claude/**` paths exist, hook commands are executable, no skill/agent names `.pipeline/`, and banned git flags appear only beside "never"/"banned".
- `[research]` The research spawn runs from the repo root, not `research-loop/` (deleted, with its `.claude` symlink). It excludes the root `CLAUDE.md` and gets its skeptic stance from `src/roles/research/stance.md` via `--append-system-prompt`.
- `[research]` The research spawn is denied Edit/Write/NotebookEdit under REPO_DIR (`permissions.deny` `Edit(//<REPO_DIR>/**)` etc. in its `--settings`). `--allowedTools` only auto-approves, so acceptEdits plus `--add-dir` had made the target checkout writable (a live control probe edited it). RUN_DIR stays writable. Bash is still broad, so research is only partly read-only.
- `[core]` Prompt paths are checked against an allowlist (`^[A-Za-z0-9@._/+-]+$`), not just for whitespace, because the skills paste them into Bash. REPO_DIR is checked at startup, so a malformed `targetRepo.path` exits 1 instead of failing every ticket.
- `[dev]` Target-repo commands run through `direnv exec <worktree>` (Ruling 31): `ticket-to-pr` (install, tests, lint, build, dev server, `git commit`/`git push` so hooks share the env, baseline and follow-up worktrees) and `qa-agent`. direnv's shell hook never fires headless, so the first two TARS-1625 runs ran webtarsthree's suite without its git-ignored `.envrc` and misread `placements-body-limit.integration.test.js` (needs `PLACEMENT_SERVICE_ENDPOINT`) as broken on master; run 3 found it via the baseline suite and recovered by hand. A blocked or missing direnv bounces `env_setup`; the skill never runs `direnv allow`.
- `[dev]` Commit hooks that run the full suite no longer stall a run (Ruling 30). Found on the second TARS-1625 run: webtarsthree's `.husky/pre-commit` runs `npm test`, so the TDD Red commit (failing tests by design) and every commit while master has a broken test were rejected. Red now commits the new tests marked expected-to-fail (`it.fails`/`test.failing`) and Green removes the marker. Phase 0 records a `baseline_failures` suite run. When pre-existing failures block a hook, `ticket-to-pr` files a linked follow-up Jira ticket (no pipeline label), fixes them test-only on `<FOLLOW_UP>-fix-preexisting-tests` off `origin/<defaultBranch>` with its own PR, then carries that committed fix into the ticket's worktree unstaged so the hooks pass, staging only the ticket's files and checking the fix never enters its commits; it is reverted after the push. A failure needing app code files the ticket only, links it "is blocked by" and bounces. `verdict.json`/iteration records gain optional `follow_up`. The dev spawn's `--allowedTools` adds `mcp__atlassian__createJiraIssue` and `createIssueLink` (still behind the secret-content hooks). Never `--no-verify`/`HUSKY=0`.
- `[dev]` Failures that already exist on master no longer block a PR (Ruling 29). When the full suite fails, `ticket-to-pr` re-runs the failing test files on a throwaway detached worktree of unmodified `origin/<defaultBranch>`. If every branch failure also fails there with the same assertion, it opens the PR anyway, names them in a `## Pre-existing failures` section, a last `qa_notes` entry and `verdict.json`'s optional `preexisting_failures` (carried into the iteration record). A failure only on the branch is still a Green-phase defect; never `--no-verify`. Found on the first real v2 run (TARS-1625): `placements-body-limit.integration.test.js` fails on master because `PLACEMENT_SERVICE` is unset, so the run bounced `tests_flaky` with finished, tested commits.
- `[research]` `[dev]` `ticket-refine`, `ticket-to-pr`, `recon-agent`, `verifier-agent` and `qa-agent` use the given `run-dir=`/`repo-dir=` (missing or malformed: no files, `agent_error`), clone `REPO_DIR` if missing, and create their worktree at `<REPO_DIR>/.claude/worktrees/<KEY>-<RUN_ID>[-ground]`. `ticket-to-pr` Phase 5 says to push with the literal branch name; the passing-verdict Jira template no longer mentions Needs-decision bullets; `auto-promote` mentions are gone.
- `[hooks]` `block-unsafe-git` denies a push argument only known at run time with "spell the branch name literally, or use HEAD". Hook tests now also run from a cwd outside the repo (as after a skill `cd`s into its worktree) instead of via `research-loop/.claude`.
- `[core]` Dead code removed: `planRemoteClose`, `RemoteCloseDeps.runsLogPath`, `runs-log.ts`'s `findOpenPrUrl` (reset's PR lookup is `findRecordedPrUrlAcross`).
- `[core]` The worker cycle (`src/worker/`, `runWorkerIteration`): it claims, runs research, hands the label off and runs dev on the same ticket with no human gate, writing one v2 record per ticket iteration (`runs/v2/<project>.jsonl`). Covered: crash recovery from the session's in-flight record (an open PR self-heals to Code Review, no rebuild), pending-handoff retry, `maxAttemptsPerTicket` (moved to Blocked with a comment, `blocked-attempts`), exclusions that persist across restarts (`recentlyEnded`), a blocker skip logged once per blocker set, 20 skips max per iteration, per-role runs/day, and a post-phase ceiling check before the handoff. A per-ticket failure never pauses or throws; a Jira 401/403 on the poll pauses. See `docs/logging.md` "The worker cycle".
- `[core]` Per-ticket budget (`ceilings.maxCostPerTicketUsd`): research spawns get `min(research cap, ticket cap)`, and dev in the same iteration gets `min(dev cap, ticket cap − research cost)`. Dev is deferred, with the handoff done, when less than $1 remains.
- `[core]` `--phase research|dev` now run the worker cycle restricted to one role, acquire a session (`--session <name>`), and write v2 records. The v1 runner entry points (`runLoopIteration` in both roles), `countRunsToday` and `legacyRunsLog`-based run counting are gone. Research no longer swaps the label itself, and the `auto-promote` label has no effect: every green research hands off, done by the cycle.
- `[dev]` Jira bounce comments and GitHub detail comments built by `src/` end with `— <session>`.
- `[core]` Worker recovery is role-scoped and durable. Adopted in-flight runs (including orphans) are written to the v2 log with `resume: <role>` on the first iteration, and only a process that runs that role resumes them, so a `--phase dev` start never runs ticket-refine. SIGINT/SIGTERM mid-phase marks the lock's flight `interrupted` (not a failed attempt). A lost session lock never drops a finished phase or strands a claimed ticket. A successful step-1 handoff is recorded (`handoff-done`). A polled ticket with an invalid key is excluded by issue id instead of stalling the queue (`JiraTicket.id`, `excludeIdsFromJql`). Dev assigns an unassigned ticket again, as in v1.
- `[core]` A research phase ending `error`/`killed` after a claim is retried (`resume: "research"`) instead of being stranded In Progress, until `maxAttemptsPerTicket` moves it to Blocked. The attempt cap acts only for roles the process runs, resumes respect `maxRunsPerDay`, and a signal before the adopted in-flight runs are in the log keeps the session lock (`recordAdoptedFlights` runs first).

- `[dev]` Merge reconciliation reads both log generations (`findLandedTicketsAcross`: `runs/v2/<project>.jsonl`, and the v1 dev log, v2 winning per ticket). On a merge it removes every pipeline label (research trigger, handoff, dev trigger, `pipeline:research`, `pipeline:dev`), each independently, and the mirror-Issue close comment ends with `— <session>`.
- `[core]` v1 readers (reconcile, the dev landed guard, research's "already refined in v1" check, `stats --v1`, reset's PR lookup) read `runs/v1/<role>/<project>.jsonl` when it exists, else the pre-cutover live log (`runs/<project>.jsonl` for dev, `research-loop/runs/<project>.jsonl` for research): `resolveV1RunsLog`.
- `[core]` `npm run stats` reports v2 by default, per role from phase entries (runs, landed, bounced, error/killed, cost); `--v1` reports v1 dev and research separately and names the file read; `--root <dir>`. It never writes.
- `[core]` Reset works on v2 state with `--role research|dev|all` (default all): `<role>-*` run dirs in every session, and records with a phase (or resume) of that role, archived to `runs/v2/<project>.reset-archive.jsonl`. A whole-project role-all reset also prunes session leftovers (`.lock.adopted-*`, `.acquire.stale-/reclaim-/release-*`, `.tmp-*`), never a lock or the mutex. No v1 location is ever modified, in either layout; `executeReset` refuses paths outside the project's v2 roots. A role-scoped reset refuses (keeps, and lists as `REFUSED`) a record whose other role landed, unless `--include-cross-role`, so `--role research` can never drop a landed dev PR. A real reset refuses while a live worker holds a session lock (`--ignore-live-worker` overrides). The scan never follows symlinks (skipped with a WARNING). The cwd no longer selects the role (`--root` overrides the state root). The deprecated `legacyRunsLog`/`legacyRunsArchive`/`legacyPipelineDir`/`legacyRawUsageDir` path functions are gone (`legacyRunDirs` followed in Task 15).

- `[core]` `src/core/blocker-gate.ts`: the blocker gate. A ticket's Jira "is blocked by" links (`JiraClient.getBlockedBy`, keys validated) must all be cleared, meaning the blocker's PR merged into the default branch of the project's own repo (the recorded PR, only if its URL is in that repo, merged with `baseRefName` equal to the default branch; or a whole-token `gh` search filtered on `baseRefName`). The gate fails closed: an open PR, another base, a cross-project blocker or any error means not cleared, with a redacted reason capped at 200 chars. A human clears a no-PR or cross-repo blocker by removing the link. `ExecGhPrViewFn`/`ExecGhFindMergedPrFn` and their real implementations moved from `roles/dev/reconcile.ts` into `core/github-client.ts`, and `realDefaultBranch(repo)` was added there.
- `[core]` `src/core/iteration-log.ts`: the v2 per-ticket-iteration record (`runs/v2/<project>.jsonl`, append-only, one `appendFile` per line). `detail`/`jira_sync_error` are redacted at record and phase level; ticket and session are validated before writing. Readers skip blank, truncated-final, malformed and bad-ticket lines (`readIterationsDetailed` also returns the skip count). `findLandedPrUrlAcross`/`findLandedTicketsAcross` look up landed dev PRs across the v1 and v2 logs, v2 winning per ticket.
- `[core]` `src/core/session.ts`: one live worker per project via `<sessions>/<name>.lock` (`LiveWorkerError` names the holder). Acquire runs under a project-wide `.acquire` mutex (a nonce in every body; a stale one is reclaimed under a per-body claim and never restored, so it can't be hit by ABA), and every lock is published atomically (temp file + link), so a half-written lock is never seen. Process start times are epoch seconds from `ps -o lstart=` under `LC_ALL=C TZ=UTC`, and a pid whose start time can't be read counts as alive. A second acquire by the same process refuses. A dead or reused-pid lock is reclaimed and its `inFlight` adopted for resume; extra records come back as `orphanedInFlight` and are never dropped. Corrupt locks are reclaimed with `inFlight: null` and never throw.
- `[core]` `src/core/paths.ts` is the single owner of on-disk paths: validated identifiers, containment checks (`UnsafePathError`), v2 layout (`runs/v2/`, `.pipeline/v2/`). The `--phase` runners and reset use its `legacy*` functions until Task 13/14.
- `[core]` Every `claude -p` spawn gets `--max-budget-usd` (from
  `ceilings.maxCostPerRunUsd`), and a run past `runTimeoutMin` is killed with
  SIGTERM, then SIGKILL after a grace period, instead of being left running.
- `[core]` The child process env strips `JIRA_API_TOKEN`, `JIRA_EMAIL` and
  `JIRA_BASE_URL` (`childEnv`), so agents cannot read Jira credentials from it.
  `JIRA_ASSIGNEE_ACCOUNT_ID` passes through: it is an account id, not a secret.
- `[hooks]` New `block-unsafe-git` PreToolUse hook blocks unsafe git operations
  from agent spawns.
- `[hooks]` `permissions.deny` rules protect the pipeline's own files
  (settings, hooks, skills, agents) from agent edits.
- `[research]` Research spawns exclude the repo-root `CLAUDE.md`
  (`claudeMdExcludes`), so the skeptic stance in `research-loop/CLAUDE.md` is
  not overridden by the dev phase's "trust the ticket" stance.
- `[core]` An errored or timeout-killed run now logs its real cost and tokens
  to `runs/<project>.jsonl` and feeds them to the post-run ceiling; v1 logged 0,
  so budget-capped runs bypassed `maxCostPerRunUsd` and undercounted stats.
- `[dev]` `alwaysThinkingEnabled` (project settings) now applies to dev runs too;
  previously only research-loop's settings carried it.
- `[core]` `--phase research|dev` is required; there is no default phase.
- `[core]` One `pipeline.<project>.config.json` per project, shared by both
  phases (`roles.research` / `roles.dev`, docs/config.md). The loader validates
  it and rejects unknown keys, `autoPromoteLabel`, and label/status values with
  `"`, `\` or a newline. Startup refuses the `"___"` values the chosen phase
  needs. research-loop's own config copies are gone; both v1 sets are archived
  under `docs/changelog/legacy-config/`. New `ceilings.maxAttemptsPerTicket`
  (2) and `ceilings.maxCostPerTicketUsd` (50), unused until the worker.
- `[core]` Poll JQL is built by `buildPollJql`, which throws on an unfilled
  placeholder or a malformed assignee account id. `excludeKeysFromJql` throws on
  anything that is not a Jira ticket key, instead of interpolating it.
- `[research]` webtarsthree's research poll is now `pipeline:v2.0.0`, and its
  green-verdict handoff label is `pipeline:v2.0.0:dev` (was `pipeline:research`
  → `pipeline:dev`). `--phase research` still swaps labels only for
  `auto-promote` tickets, the v1 rule, now a constant in the runner.
- `[dev]` webtarsthree's dev poll is now `pipeline:v2.0.0:dev`, without the
  assignee clause. Both webtarsthree polls exclude `dev-loop-eval` tickets.
  Merge reconciliation removes the dev trigger label.
- `[research]` ticket-refine no longer reads the removed `autoPromoteLabel` key.
  Its `✅ research-loop -` comment output is unchanged from v1 (section always
  omitted): the "Needs decision" section is never written.
- `[core]` `reset-project` run from `research-loop/` (the research phase's
  state root) reads the project config from the repo root, since
  `research-loop/` no longer has its own copy.

### Fixes now shared by both phases (ledger class a)

- `[core]` `claim-error` poll result: a throwing claim sleeps `pollIntervalSec`
  rather than crashing the loop (was research-only; inert for dev until it has a claim).
- `[core]` `hasLandedRun(path, key)` in runs-log (was research-only).
- `[core]` Redaction: values starting with `[` in unquoted env/JSON assignments
  are now redacted (dev leaked them).
- `[core]` Redaction: pass order now also catches an env-style assignment in
  JSON-value position past a comma (research left the remainder).
- `[core]` Redaction: a quoted all-digit secret, e.g. `{"password":"123456789012"}`,
  is redacted; the true/false/number skip applies to unquoted values only.
- `[core]` Verdict parsing accepts and sanitizes `size_trajectory` under both
  profiles; a malformed one is dropped and never flips the outcome to error.
- `[core]` `CURRENT_LOG_VERSION` and the optional `log_version` / `size_trajectory`
  fields on `RunLogLine` (research-only before; dev lines stay implicit "1.0").
- `[core]` `GitHubIssue.state` is returned by both `findIssueByJiraKey` and
  `createIssue`; `createIssue` is available on the shared client.
- `[core]` `JiraTicket.labels` is returned by both poll calls.
- `[core]` `transitionStatus(key, to, fields?)` signature shared; omitting `fields`
  sends research's old body.

### Refactors (ledger entries that are dedup/rename/wording, not fixes)

- `[core]` One `excludeKeysFromJql` (`key not in (...)`) replaces dev's private
  `key != ...` chain; equivalent JQL.
- `[core]` `checkCeilings` takes explicit limits and returns research's
  `{breached, reason, detail}`; `detail` lists every breach. `assertWithinCeilings`
  carried over, no production caller.
- `[core]` `parseVerdict(raw, profile)` with `"refine"` / `"executor"` profiles;
  `config` role parameter for `assertNoPlaceholders` (`jira.codeReviewFields`
  now optional in `Config`, required for the dev role at startup).
- `[core]` `findOpenPrUrl` moved from the dev reconcile module to core runs-log,
  so core imports no role code. reset-cli and remote-close use the dev (PR-closing)
  superset for both phases; research data has `pr: null`, so nothing changes there.
- `[core]` Role-neutral wording in reset-project and github-client headers;
  renamed/aliased verdict helpers.
