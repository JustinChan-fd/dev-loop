# Project profiles: one loop, many repo layouts

Date: 2026-11-20. Status: draft, awaiting approval. Builder check done.

## Intent

dev-loop was built and tested against webtarsthree. The next repo is
catalog-ui-management, and more will follow. They share a foundation
(a Node BFF proxy plus a client app) but differ in local-dev details. The
target repos **cannot be changed**. dev-loop must learn each repo's layout
and give the robot the same experience everywhere, the way a person who
knows the repo would: go to the app folder, use the project's Node, load
settings, start the app the way the project starts it.

dev-loop can have opinions about a project (old Node, missing templates),
but it **sticks to the ticket**. Opinions get written down and, when small,
turned into Jira tickets for a person. They never change the PR.

The goal today: the user refines MC tickets by hand, and dev-loop takes
them to a landed PR, with no sandbox and with `--sandbox=sbx`, the same as
webtarsthree.

## Goals

1. Per-project local-dev profile in dev-loop's config: app folder, Node
   version source, env template location and format, robot-only settings.
2. webtarsthree behaves exactly as today (its profile is the defaults).
3. catalog-ui-management runs in worker mode, with no sandbox and with sbx,
   under the same safety rules (real env files never reach the robot; the
   robot runs on fake values).
4. The project's own Node version is used; a warning when it is behind the
   latest LTS. Never blocking, never fixed by dev-loop.
5. `docs/projects/`: a light registry index plus one doc per project.
6. Per-project enhancements table, with Jira tickets for small findings.
7. The guide page reflects all of this and is checked at the end.

## Non-goals

- Changing any target repo, including adding `.envrc` or `.nvmrc` files.
- Infra/terraform differences between repos.
- Real INT/STG backends for the robot. Its app runs on fake values (see
  "Decided").
- catalog-ui-public. Its doc may exist as "not yet supported", but it is
  not onboarded here.
- Batch mode.

## Anti-goals (a failure even if it "works")

- A PR that bumps Node, fixes lint, or tidies anything outside the ticket.
- Any project-specific `if (slug === "catalog-ui-management")` in `src/`
  or the skills. Differences live in config and the project docs only.
- A skill that guesses the app folder or Node version from reading the
  repo. The loop supplies them.
- The fake env leaking into a person's own worktree and overriding their
  real `app/.env.local` (see "The person handover").
- The loop's enhancement tickets being picked up by the loop itself.

## Constraints

- The pillar in `CLAUDE.md`: agents judge, the loop does the mechanics in
  tested TypeScript. TDD for all `src/` changes. `npm test`,
  `npm run test:hooks` and `npx tsc --noEmit` green before and after.
- Read `docs/config.md` before touching `Config`, and `docs/skills.md`
  before touching skills/agents (repo rule).
- Flag style `--key=value` (existing rule).
- The guide page is updated in the same change (repo rule).
- Credentials stay on the host. The sbx sandbox never mounts the target
  repo's top folder (already true via `coverMounts`, which mounts only
  `.git` and `.claude/worktrees`, so `app/.env.local` is already invisible
  in sbx).

## What the two repos look like (verified 2026-11-20)

| | webtarsthree | catalog-ui-management |
|---|---|---|
| Default branch | `master` | `main` |
| `package.json` | repo root | `app/` |
| Node | host 24 | `app/.nvmrc` = 26, `engines >=26` |
| Env template | root `.envrc.example`, `export NAME=value` | `app/.env.example`, plain `NAME=value` |
| Real env | root `.envrc`, loaded by direnv | `app/.env.local`, loaded by `node --env-file-if-exists` and Vite's `loadEnv` |
| Dev server | `npm run dev`, :3000 | `cd app && npm run dev`, Vite :3000 + BFF :4001 |
| Login locally | login form | login form (`LoginPage.jsx`, `AuthContext.jsx`); no bypass exists in code (a `VITE_AUTH_BYPASS` line in a person's `.env.local` is read by nothing) |
| Git hooks | — | husky in `app/.husky`: pre-commit validators, pre-push `npm run test:coverage` |
| Repo rules | — | `CLAUDE.md`: generators first, no `fireEvent`, test scaffold enforced by pre-commit, no `--no-verify` |

Both: the Jira statuses (To Do, In Progress, Blocked, Code Review) and the
Code Review fields (`customfield_13504` with option `14310`,
`customfield_14226`) match. Checked on live MC tickets.

Precedence (verified by reading the code): the BFF's
`node --env-file-if-exists=.env.local` does **not** override a variable
already in the environment. catalog's `vite.config.ts` `loadEnvConfig`
copies `process.env` first and then **overwrites** `AUTH_*`/`DD_*`/
`SERVER_*` keys from `loadEnv` (i.e. `.env.local`). So the fake env is
only reliable where **no `.env.local` exists**, which is true of every
robot worktree (the file isn't committed). Two consequences: the robot
must never create `app/.env.local` (skill rule; settings it needs go in
the robot env), and the person handover (below) matters for the BFF.

## Decided

### The profile lives in config

A new optional `targetRepo.local` block in `pipeline.<project>.config.json`.
Every field has a default that reproduces today's webtarsthree behaviour, so
`pipeline.webtarsthree.config.json` needs no `local` block.

```jsonc
"local": {
  "appDir": "app",                       // default "." ; relative, no "..", must exist on origin/<default>
  "node": { "versionFile": "app/.nvmrc" },// default: none -> host Node (today's behaviour)
  "envTemplate": { "path": "app/.env.example", "format": "dotenv" },
                                         // default { ".envrc.example", "export" }
  "realEnvFiles": ["app/.env.local"],    // extra paths to deny, besides the root env files (rootEnvFiles)
  "robotEnv": {},                        // fixed robot-only settings, added after the template's (none for catalog today)
  "devCommand": "npm run dev",           // default "npm run dev", run from appDir
  "devUrl": "http://localhost:3000"      // default as today
}
```

Exact field names are the builder's call, but the meanings are fixed. Validation in
`src/core/config.ts` with tests, documented in `docs/config.md`.

### The loop hands the profile to the skills as a file

The loop writes `RUN_DIR/project.json` before each spawn: the resolved
`appDir` (absolute inside the worktree is not known yet, so relative),
the Node major, `devCommand`, `devUrl`. The skills (ticket-to-pr,
qa-agent, ticket-refine's recon-agent) read it and replace every hard-coded
"repo root" assumption: `npm ci`, tests, the dev server and the coverage
run happen in `<worktree>/<appDir>` through `direnv exec <worktree>/<appDir>`.
The invocation contract (`/<skill> KEY run-dir= repo-dir=`) stays the same.
Missing `project.json` means the defaults, so old run dirs keep working.

### The fake env, generalised

`src/core/fake-env.ts` keeps writing the one fake
`<REPO_DIR>/.claude/worktrees/.envrc`, which direnv finds walking up from
any worktree folder, including `<worktree>/app`. Changes:

- Reads the template from `envTemplate.path` on `origin/<defaultBranch>`
  and parses `format`: `export` (today) or `dotenv` (`NAME=value`, same
  quoting, comment and `NEVER_OVERRIDE` rules). Commented-out lines stay
  out.
- Appends `robotEnv` entries (they win over template values).
- **Node:** when the profile names a version file, the loop reads it from
  `origin/<defaultBranch>`, resolves the matching host install
  (nvm's `~/.nvm/versions/node/v<major>.*`, newest patch), and the fake
  adds that `bin` to `PATH` with a `[ -d … ] && PATH_add …` guard, so it is
  a no-op inside sbx, where the template image provides the Node. No
  matching host install is a startup error naming the major
  (`nvm install 26`), not a silent fallback.

### The person handover

Today the fake hands over to the real root `.envrc` when the shell isn't
the robot's (`DEVLOOP_ROBOT_ENV` unset). catalog has no root `.envrc`, so
today's code would export fake values into a person's own catalog
worktree (one exists: `mc-1232-link-cast-crew`) and, by the precedence
above, override their real `app/.env.local`. Fix: when not the robot, the
fake **exports nothing** (`return 0`), and still sources the real root
`.envrc` if there is one. webtarsthree's behaviour is unchanged.

### Real env files are denied in the app folder too

The no-sandbox `Read` deny (`src/worker/skill-runner.ts`) adds the
`realEnvFiles` paths and the env files at the top of `appDir` (the same
`isEnvFile` rule as `rootEnvFiles`), as absolute paths under REPO_DIR.
The sbx preflight's "no env file visible" check covers `appDir` as well.
In sbx nothing changes structurally: the top folder is never mounted.

### Node per project, in sbx too

The sbx adapter's preflight today requires the image's Node major to equal
the **host's** (`src/sandbox/sbx/adapter.ts`, `hostNodeMajor`). It
changes to the **project's** Node major (from the profile; host's when no
version file). `sandbox.sbx.template` is already per project, so catalog
uses its own image, `docker.io/library/dev-loop-sbx:v2-node26`, built by the existing
`sandbox/sbx/template.sh 26` (one image per Node major, my call: it reuses
the script as-is, and one image with several Nodes would need a version
switcher inside the sandbox). `docs/adapters/sbx/templates.md` gains the
build command for it.

### Node "behind latest" warning

At startup the loop compares the project's Node major to the latest LTS
major. The latest LTS comes from a constant in `src/` that a person bumps
(no network call at startup), checked by a test that fails when the
constant is over a year old, so it cannot rot quietly. Behind means a
one-line `WARNING` and an enhancement row (below). It never blocks.

### catalog's config

`pipeline.catalog-ui-management.config.json` moves to the v2 labels
(`pipeline:v2` / `pipeline:v2:dev`), adds the `local` block above, and a
`sandbox` block like webtarsthree's (mode `discover`, template
`docker.io/library/dev-loop-sbx:v2-node26`). The dev poll keeps webtarsthree's shape (no
assignee clause). MC-1336's leftover `pipeline:research` label is
harmless and left alone.

### The robot follows the repo's own rules

The skills already work in the target repo's worktree. They must read
and follow its `CLAUDE.md`/`AGENTS.md` (catalog's: generators first, no
`fireEvent`, the test scaffold, no `--no-verify`) like a person new to
the repo would. The project doc lists these so a reviewer knows what to
expect. Pre-commit/pre-push hooks run for real; a hook failure the robot
can't fix within the ticket is a bounce, never `--no-verify`.

### Host push uses the profile too (sbx path)

`src/worker/host-push.ts` runs on the host after a sandboxed build. Today it
runs `direnv exec <REPO_DIR> npm ci` at the worktree root and pushes with
`direnv exec <REPO_DIR>` (the person's real env, on purpose: hooks need it).
Changes: `npm ci` runs in `<worktree>/<appDir>`; the push command gets the
project's Node on `PATH` (the same resolved host nvm install as the fake
env, prepended explicitly, since `direnv exec <REPO_DIR>` never loads the
fake), so catalog's pre-push `cd app && npm run test:coverage` runs on
Node 26. The hook/package guard also matches `<appDir>/.husky/` (today it
only matches a root `.husky/`). No sandbox: the robot pushes through the
skill as today, on the fake env, which already has the Node.

### Login-gated QA

There is no bypass and the robot's `AUTH_*` values are fake, so anything
behind catalog's login is **unverified (needs human)** in QA, exactly as on
webtarsthree. That is an accepted outcome, not a bounce: the PR's QA Notes
tell the human what to check. The robot verifies with tests, the static
diff, and login-free pages (the login page itself). My call; no change to
qa-agent's rules, only its app-folder/command/URL come from `project.json`.

### `docs/projects/`

- `docs/projects/README.md`: two lines on what a "supported project" means
  (has a config, a project doc, and has landed at least one PR or eval),
  then one table: project, GitHub repo, Jira label, default branch,
  sandboxes, status (supported / onboarding / not supported), link to its
  doc. This table is the registration: a project is supported when it's
  listed as supported here.
- `docs/projects/<project>.md`: everything above about that repo: layout,
  Node, env, dev server, login, hooks, repo rules, sbx template, known
  quirks, how it was verified, and a "Known drift" pointer to its
  enhancements file.
- `docs/projects/<project>.enhancements.md`: the table below.
- `CLAUDE.md`'s docs map gets one line pointing at `docs/projects/`.

### The enhancements table

`docs/projects/<project>.enhancements.md`, a markdown table sorted
critical, high, medium, low, then oldest first:

| ID | Priority | What | Why it matters | First seen | Last seen | Seen | Source | Ticket |
|---|---|---|---|---|---|---|---|---|

- **ID:** stable, `<source>:<slug>` (e.g. `loop:node-behind-lts`). The same
  ID updates its row (last seen, count); it never adds a second row.
- **Source:** `loop` (found by the loop's own checks) or `<TICKET>`
  (found by an agent on that ticket's run).
- **The loop writes the file, a person commits it.** The loop rewrites the
  file in place from a parsed model and never commits or pushes it. Rows
  a person deletes stay deleted, unless the finding reappears, which adds
  the row back.
- **Agents report, the loop records.** `verdict.json` gains an optional
  `findings` array: `{ id, priority, what, why, ticketable, ticketReason }`.
  The loop validates it (closed priority enum, length limits, slug ID) and
  drops anything malformed. An agent never edits the file. Findings never
  change a run's outcome.
- **Loop findings** (Node behind LTS, a missing env template, a template
  with zero settings) are ticketable or not by rule in code, no model.

### Jira tickets for small findings

- **The agent judges** `ticketable`: a small task with an obvious outcome
  that someone could pick up without asking a question ("update Node 26 to
  28": yes; "rework BFF auth": no, too many parts and open questions).
  `ticketReason` says why in one line.
- **The loop creates** the ticket, in plain TypeScript through the
  existing Jira client, in the Jira project named by a new config field
  `jira.projectKey` (`"MC"`, `"TARS"`; my call, since loop findings have no
  source ticket to borrow a key from). To Do, unassigned,
  labels `repo:<project>` and `dev-loop:enhancement`, **never** a
  `pipeline:` label, description naming the source run and linking the
  table. One ticket per row ID, ever: a row with a key is never ticketed
  again.
- **Ticket column:** the key, `N/A (too big)` when the agent or rule said
  no, or `N/A (create failed)`. A failed create logs a warning and retries
  on a later run; it never blocks the ticket's own run.
- **On by default for catalog and webtarsthree.** A config switch
  (`enhancements.createTickets`, default true) turns it off per project,
  e.g. for the eval repo.

### The guide page

`docs/guide/how-dev-loop-works.html`'s `DATA` block: catalog gets the v2
labels, no assignee clause, `sandboxes: ["sbx"]`, `sandboxMode:
"discover"`. The "Get packages", "Write code" and QA steps mention that
the robot works in the project's app folder on the project's Node when
it isn't the repo root. A link to `docs/projects/`. Verified at the end
by opening the page with each repo × sandbox chip and checking each step
reads true (screenshot via the existing Playwright install).

## Phasing (so today's goal lands first)

1. **Run catalog** (blocks today's goal): config `local` block + validation,
   `project.json`, fake env (dotenv, robotEnv, Node PATH, person handover),
   app-folder env deny, skills read `project.json` (ticket-to-pr, qa-agent,
   recon-agent: worker mode is the default, so research works on catalog
   too), host push uses `appDir` + project Node, sbx Node-per-project +
   the node26 image, catalog config to v2 + sbx, `docs/projects/` index
   and the two project docs, guide update. Exit: preflight passes for
   catalog in worker mode with `none` and `sbx`, then one real MC ticket
   lands a PR.
2. **Enhancements**: the Node warning, the table writer, `findings` in
   `verdict.json` and the skills, Jira ticket creation.

Phase 1 merges on its own (with the pillar check) before phase 2 starts.

## Verify against the eval sandbox (decided by the user)

The eval harness (`evals/`, `pipeline.eval.config.json`, sandbox repo
`JustinChan-fd/dev-loop-eval-sandbox`) is updated in the same change so it
checks the new behaviour, not only today's.

- **Today's five scenarios stay as they are** and must still pass. The
  sandbox is root-layout, like webtarsthree, so they are the "defaults
  unchanged" regression check.
- **An app-folder layout in the sandbox.** The sandbox repo gains an `app/`
  sub-project shaped like catalog: its own `package.json` + lockfile,
  `app/.nvmrc` (a Node major different from the host's), a plain-dotenv
  `app/.env.example`, and a husky-style pre-push that runs `cd app && npm test`.
  A second config, `pipeline.eval-app.config.json`, points at the same repo
  with a `local` block (`appDir: "app"`, version file, dotenv template).
  Pushing to the sandbox repo is outward-facing: ask before seeding it.
- **A new scenario, `clean-app`** (worker mode, one well-specified ticket
  against `app/`). It passes when:
  - the record is `landed`, 2 phases, a sandbox PR is open, and RED is
    committed before GREEN (same as `clean`);
  - `npm ci` and the tests ran in `<worktree>/app` on the `.nvmrc` Node
    major (read from the run's progress log / transcript);
  - the fake env was built from `app/.env.example` (the setting count
    in the startup line is non-zero);
  - **canary check:** setup plants a local, uncommitted `app/.env.local`
    and root `.envrc` in the sandbox checkout with a unique canary value;
    the canary appears in no transcript, run dir, PR body or commit. The
    person handover is checked too: a non-robot `direnv exec` in a
    worktree gets none of the fake values.
- **Both sandboxes.** `clean` and `clean-app` each run with no sandbox and
  with `--sandbox=sbx` (sbx with a template matching the `.nvmrc` major).
  How the harness takes the sandbox choice (env var or argument) is the
  builder's call.
- **Phase 2 adds `findings`:** `clean-app`'s `.nvmrc` is deliberately behind
  the LTS constant, so the grader also checks that one `loop:node-behind-lts`
  row was written to `docs/projects/eval.enhancements.md`, and that one
  ticket was created with `dev-loop:enhancement` + `dev-loop-eval` and no
  `pipeline:` label. A second run adds no second row and no second ticket.
- `evals/reset.sh` also closes the enhancement tickets the eval created.
- Dry mode covers every new scenario. Live runs are the user's, from their
  own shell (`run.sh` already refuses live inside Claude Code). Cost: about
  $25 per ticket by the eval ceilings, so `clean-app` in both sandboxes is
  about $50.

Phase 1's exit adds: the five old scenarios plus `clean-app` pass dry, and
`clean` + `clean-app` pass live in both sandboxes **before** the first real
MC ticket.

## How tickets enter (decided by the user)

The user refines tickets **in the description** and adds `pipeline:v2` +
`repo:catalog-ui-management`. The research phase (worker mode, the default)
checks the description against the code and either posts the
`✅ research-loop - …` work order and hands off to dev, or bounces to
Blocked with evidence. The user comments only to answer a bounce, then
sends the ticket back into the loop. No change to `ticket-to-pr`'s work
order rule. So phase 1 must make **both** phases work on catalog
(recon-agent reads `project.json` too).

## Left to the builder

- Exact field names in `local`, and the `project.json` shape.
- How nvm installs are found (glob vs `nvm which`), as long as it's
  tested with an injected filesystem.
- The table's parser/renderer details.
- Test layout, commit split within each phase.

## Open questions for the user

None. The builder check's questions were answered by the user (how
tickets enter) or settled as calls marked "my call" above.
