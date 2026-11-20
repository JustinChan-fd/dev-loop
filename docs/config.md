# Config

> Merged in dev-loop 2.0.0: one repo, two phases. `## Research phase` is the
> former research-loop doc (`--phase=research`); `## Dev phase` is the former
> dev-loop doc (`--phase=dev`). Wording inside each section still describes its
> repo as it was; "this repo" / "the sibling repo" there means that phase, and
> paths like `src/types.ts` map to `src/core/` and `src/roles/<phase>/` now.
> See `docs/migration-ledger.md`.

## 2.0.0 shape (current)

One `pipeline.<project>.config.json` per project, at the repo root, read by
both phases. `src/core/types.ts`'s `Config` is the source of truth;
`validateConfig` in `src/core/config.ts` enforces it (`loadConfig` calls it).
The two v1 files per project are archived, unmodified, under
`docs/changelog/legacy-config/{dev-loop,research-loop}/`. Where a section
below names a v1 key, the mapping is: `jira.triggerLabel` (research) →
`roles.research.triggerLabel`; `jira.handoffLabel` → `roles.research.handoffLabel`
(= `roles.dev.triggerLabel`); `jira.pollJql.refine` → `roles.research.pollJql`;
`jira.pollJql.dev` → `roles.dev.pollJql`; `jira.codeReviewFields` →
`roles.dev.codeReviewFields`; `ceilings.{maxCostPerRunUsd,runTimeoutMin}` →
`roles.<role>.ceilings`.

```jsonc
{
  "targetRepo": { "url", "defaultBranch", "path"?, "local"? },
  "github": { "repo" },
  "jira": { "repoLabel", "statusNames": { "bounced", "prOpen" }, "claimStatus": { "from", "to" } },
  "roles": {
    "research": { "triggerLabel", "handoffLabel", "pollJql", "ceilings": { "maxCostPerRunUsd", "runTimeoutMin" } },
    "dev":      { "triggerLabel", "pollJql", "codeReviewFields", "ceilings": { "maxCostPerRunUsd", "runTimeoutMin" } }
  },
  "ceilings": { "maxRunsPerDay", "maxAttemptsPerTicket", "maxCostPerTicketUsd" }
}
```

- **Validation.** Unknown keys and missing keys are errors. `autoPromoteLabel`
  is rejected ("removed in 2.0.0"): a green research verdict always hands off.
  Every label and status value is interpolated into JQL, so `"`, `\` and
  newlines are rejected. `roles.research.handoffLabel` must equal
  `roles.dev.triggerLabel`, and the two trigger labels must differ. Ceilings
  are numbers > 0 (`maxRunsPerDay` and `maxAttemptsPerTicket` integers).
  `"___"` is allowed by the validator.
- **`targetRepo.local` (optional): how the project runs locally.** Every
  field is optional, and with no block the loop behaves as it always has
  (webtarsthree has none). `localProfile(config)` fills the defaults;
  `src/core/project-profile.ts` resolves it once at startup and the loop
  hands the skills `RUN_DIR/project.json` (`appDir`, `nodeMajor`,
  `devCommand`, `devUrl`). Paths are relative to the repo root: plain
  segments, no `..`, no leading or trailing slash.

  | Field | Default | Meaning |
  |---|---|---|
  | `appDir` | `"."` | The folder holding `package.json`. Installs, tests, coverage and the dev server run here (`direnv exec <worktree>/<appDir> …`); git stays at the worktree root. Must exist on `origin/<defaultBranch>`. |
  | `node.versionFile` | none (host Node) | The file naming the project's Node (e.g. `app/.nvmrc`), read from `origin/<defaultBranch>`. The loop finds the newest matching host nvm install and puts its `bin` on the robot's `PATH`; no match is a startup error (`nvm install <major>`), never a silent fallback. The sbx image must have the same major. |
  | `envTemplate` | `{ "path": ".envrc.example", "format": "export" }` | The committed template the robot's fake values come from. `export` is `export NAME=value` (direnv); `dotenv` is plain `NAME=value`. Same quoting, comment and never-override rules either way. |
  | `realEnvFiles` | `[]` | Extra real env files to deny the robot, besides the env files at the repo root and at the top of `appDir` (e.g. `app/.env.local`). |
  | `robotEnv` | `{}` | Fixed robot-only settings, added after the template's (they win). Never `PATH`, `HOME`, `NODE_OPTIONS`, `GIT_*` and the like. |
  | `devCommand` | `"npm run dev"` | How the app starts, run from `appDir`. |
  | `devUrl` | `"http://localhost:3000"` | Where the dev server answers. Must be `http(s)://localhost` or `127.0.0.1`. |

- **Placeholders.** `requiredPlaceholderFree(config, phase)` refuses, at
  startup, every `"___"` the phase needs: the shared `targetRepo`/`github`/
  `jira` values, plus `roles.research.*` (research), `roles.dev.*` including
  `codeReviewFields` (dev), or both (`worker`). So `catalog-ui-public` runs
  `--phase=research` but not `--phase=dev` until its `codeReviewFields` are
  filled.
- **Role views.** Runners never read the whole `Config`; they take
  `roleView(config, role)`: that role's `triggerLabel`, `pollJql`,
  `handoffLabel` (research) or `codeReviewFields` (dev), the shared
  `repoLabel`/`claimStatus`/`statusNames`, and `limits` =
  `{ maxRunsPerDay` (shared value, counted per role), `maxCostPerRunUsd`,
  `runTimeoutMin }` (that role's).
- **Poll JQL.** `buildPollJql(view, { assigneeAccountId })` (`src/core/jql.ts`)
  fills `{label}` (the role's `triggerLabel`), `{repoLabel}`, `{assignee}`,
  `{bouncedStatus}` and `{prOpenStatus}`, and throws on any other `{name}`. The
  assignee (`JIRA_ASSIGNEE_ACCOUNT_ID`) must match `[A-Za-z0-9:_-]+`.
  `excludeKeysFromJql` throws on anything that is not a Jira key.
- **Ceilings.** `maxCostPerRunUsd` / `runTimeoutMin` are per phase run
  (research $50 / 120 min, dev $20 / 75 min). `maxRunsPerDay` (100) applies
  to each role separately. `maxAttemptsPerTicket` (2) is the failed
  (error/killed) attempts per role per ticket before the worker moves it to
  Blocked, and `maxCostPerTicketUsd` (50) is a per-ticket cost cap across both
  phases. The worker enforces both: the attempt cap in `src/worker/attempts.ts`
  and `src/worker/recover.ts`, the per-ticket cap as each spawn's
  `--max-budget-usd` in `src/worker/cycle-steps.ts`.
- **Labels and the version guard.** `webtarsthree` uses the v2 labels:
  research polls `pipeline:v2` and hands off to `pipeline:v2:dev`,
  which dev polls. Its dev poll has no assignee clause (the v2-only label
  already scopes it), and both polls exclude `dev-loop-eval` tickets. The
  `catalog-ui-*` configs keep the v1 labels (`pipeline:research` /
  `pipeline:dev`) until cutover. The label carries the major version only
  (`pipeline:v<major>`), so minor and patch releases share it.
  `checkLabelVersion(config, pkgVersion)` refuses an unversioned label, the
  old full-version form (`pipeline:v2.0.0`), and another major's label. Worker
  mode (`--phase=worker`, the default) enforces it at startup, after the
  placeholder check: ok:false exits 1 (so the `catalog-ui-*` configs are
  refused until cutover). `--phase=research|dev` do not.
- `pipeline.loop.config.json` (poll interval, post-run delay) is unchanged and
  is read from the repo root by both phases.

## Research phase

### Selecting a project (CLI)

`src/main.ts` requires `--project=<name>`, resolved via
`resolveProjectConfigPath()` in `src/config.ts` to
`pipeline.<name>.config.json` at the repo root:

```
npm run loop -- --project=webtarsthree
npm run loop -- --stream --project=webtarsthree
npm run loop -- --project=catalog-ui-management --once
```

Since 2.1.0 every value flag is `--name=value` only (`src/core/flags.ts`).
The old space-separated `--project webtarsthree` is refused with the exact
replacement (`use --project=webtarsthree`). Boolean flags (`--once`,
`--stream`) stay bare.

Omitting `--project`, or naming a project with no matching config file,
fails immediately — before any Jira/GitHub call — with a list of the
projects actually present (every `pipeline.*.config.json` at the repo
root except `pipeline.loop.config.json`, which is loop-mechanics, not a
project). `--config=<path>` still works as a fallback for an arbitrary
path outside the naming convention; passing both `--project` and
`--config` together is an error.

Each terminal's own `--project` selects its own project independently —
running N terminals against N different projects is safe, since
per-project on-disk state (`runs/<slug>.jsonl`, `.pipeline/<slug>/...`)
is already namespaced by `repoSlugFromUrl()`. The one remaining gap is
two terminals against the *same* project — see "Ticket status never
reverts" below for the "Future: multiple concurrent loop instances" note
that still applies.

### Shape

`src/types.ts`'s `Config` interface is the source of truth for
`pipeline.<project>.config.json`'s shape:

- `jira.triggerLabel` / `handoffLabel` — the two pipeline-stage labels a
  ticket moves through. `triggerLabel` (`"pipeline:research"`) is this
  loop's own poll target — fresh, unrefined tickets *and* already-refined
  tickets awaiting Justin's approval both carry it; there is no separate
  label for "awaiting approval" (that distinction is a comment on the
  ticket itself — presence of `Refined Spec — ready for ticket-to-pr` —
  not a label). `handoffLabel` (`"pipeline:dev"`) is dev-loop's poll
  target. Since 2.0.0 the worker cycle (`src/worker/`) writes it on every
  green research verdict, by swapping it in for `triggerLabel` after the
  post-research ceiling check. There is no human gate, and the research
  role never polls for it.
- `jira.repoLabel` — a second, always-paired label naming which repo a
  ticket belongs to (e.g. `"repo:catalog-ui-management"`), ANDed into both
  `pollJql` templates alongside the stage label. Needed because more than
  one target repo can share a single Jira project — `catalog-ui-management`
  and `catalog-ui-public` both file into project `MC` — so the stage label
  alone (`triggerLabel`/`handoffLabel`) can't tell which repo a given
  ticket actually belongs to. Unlike `triggerLabel`/`handoffLabel`,
  `repoLabel` never changes across a ticket's lifecycle. A project with
  only one target repo (e.g. `webtarsthree`/`TARS`) doesn't strictly need
  this for disambiguation, but every `pipeline.<project>.config.json` sets
  it anyway for a uniform scheme across projects. Ported from dev-loop's
  identical field (see dev-loop's `CHANGELOG.md`, 2026-09-16).
- `jira.claimStatus.{from,to}` — the status transition this loop uses to
  atomically claim a ticket (race-safe: `JiraClient.claim` returns `false`,
  never throws, if another process already claimed it).
- `jira.pollJql.{refine,dev}` — JQL templates with `{label}` and `{repoLabel}`
  placeholders, filled in by `src/jql.ts`. This repo only ever polls with `refine`.
- `jira.statusNames.{bounced,prOpen}` — this Jira instance has no literal
  "bounced" status, so these map the loop's terminal outcomes onto whatever
  statuses actually exist in the *child ticket's* (Bug/Story/Task) workflow.
  **Important**: check the child issue type's own transitions
  (`getTransitionsForJiraIssue`) — epics have a separate, simpler workflow
  and will give you the wrong answer.
- `ceilings.{maxRunsPerDay,maxCostPerRunUsd,runTimeoutMin}` — enforced by
  `src/ceilings.ts`; a breach pauses the loop, it never silently continues.
- `autoPromoteLabel` — a ticket label that lets a passing verdict skip
  human approval and swap the ticket straight from `triggerLabel` to
  `handoffLabel`. Without it, a passing verdict leaves the ticket at
  `triggerLabel`, refined and awaiting approval.
- `targetRepo.{url,defaultBranch}` — the codebase `ticket-refine` grounds
  tickets against (not this pipeline repo itself). Read-only for this repo.
- `targetRepo.path` (optional) — local filesystem path to an existing
  checkout of `targetRepo.url` on this machine. When set, per-run worktrees
  branch directly off it instead of a fresh clone into
  `.pipeline/<slug>/repo` — faster, and skips a redundant clone since the
  checkout's `origin` is already the real remote. Omit on a machine with no
  local checkout yet; the clone-based flow is used instead.
- `github.repo` — `"owner/repo"` shorthand (e.g. `"fandango/webtarsthree"`)
  passed directly to `gh`'s own `--repo` flag. Phase 1 of the Jira-label-trigger
  design (see `docs/future-enhancements.md`): this pipeline mirrors every
  claimed ticket into a GitHub Issue and posts recon/attack/verify/working-note
  content there instead of Jira, per the routing rule in `SKILL.md`. One target
  repo per project config, same granularity as `targetRepo` — derived from the
  same codebase this skill grounds tickets against, not a separate system.

There's no config field for live API testing. `ticket-refine` starts the
target repo's *own* dev server (its own `npm run dev` or equivalent) when a
hypothesis in Ground needs to see what an endpoint actually returns, and
`recon-agent` calls that local instance's proxy routes directly — this
exercises the target repo's real server-side logic, not a bypass, and needs
no separate URL to configure or keep in sync. See `docs/skills.md` for the
lifecycle (who starts/stops it, and the hard gate that it's always stopped
before Ground ends).

### Sandbox (optional)

An optional top-level `sandbox` block selects a sandbox adapter for agent
spawns. Absent means the `none` adapter: spawns are exactly as before.

```json
"sandbox": { "adapter": "none", "mode": "enforce" }
```

- `adapter` — a registered adapter name (`none` or `sbx`). Default `none`.
- `mode` — `"discover"` or `"enforce"`. Default `"enforce"`.
- An adapter's own sub-block is keyed by its name (`sandbox.<adapter>`) and
  validated by that adapter; errors are prefixed `sandbox.<adapter>: `.
- `sandbox.sbx` (adapter `sbx`, Docker Sandboxes) takes:
  - `kitDir` — required, an absolute path (or `~/...`) to the Keystone kit
    folder (must hold a kit `.yaml`).
  - `template` — optional, a saved `sbx template save` image such as
    `"docker.io/library/dev-loop-sbx:v1"` (node, jq, direnv, the HTTPS rewrite, the target `.envrc` approval).
    Created with `-t <ref> --pull never`; the kit is still applied.
  - `memory` — optional, e.g. `"4g"` or `"512m"`.
  - `mcp` — optional list of MCP server names registered with
    `sbx mcp add` (e.g. `["atlassian"]`), passed as `--static-mcp`.
    Preflight refuses one that is not registered or not ready.
  - `hostSkills` — optional list of your own skill folder names under
    `~/.claude/skills` that a pipeline skill reads by path (today only
    `push-branch`, read by ticket-to-pr Phase 5). The sandbox can't see
    `~/.claude`, so each is mounted read-only at
    `/home/agent/.dev-loop/skills/<name>` (sbx reserves
    `/home/agent/.claude/skills`), and dev is passed
    `<name>=<that SKILL.md>`. Preflight refuses one with no `SKILL.md` on
    the host, or one not readable in the sandbox. A run on the host is
    unchanged. `test/sandbox/sbx/host-skills-drift.test.ts` fails when a
    pipeline skill starts reading one that isn't listed.
  - `envAllow` — optional list of bare env var names to pass into the
    sandbox, added to the defaults (the three `ANTHROPIC_DEFAULT_*_MODEL`
    names and `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). Secret-shaped names
    (`TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `AUTH`) are refused.

  Setup steps: [sandbox-sbx.md](sandbox-sbx.md).
- Any other key is rejected (`sandbox: unknown key "<k>"`).
- CLI precedence: `--sandbox=<name>` wins over `sandbox.adapter`.
  `--sandbox=none` is the per-run off switch. An unknown name fails at
  startup with `--sandbox: unknown sandbox adapter ...`.
- **Opt-in per run:** leave out `adapter` and keep only `mode` and the
  adapter's sub-block. A plain run uses `none`; `--sandbox=<name>` uses the
  settings. Every sub-block present is validated at load, selected or not.
  `webtarsthree` is set up this way for `sbx` while sbx is being vetted:
  `npm run loop -- --project=webtarsthree --sandbox=sbx ...`.

### Ticket status never reverts

Once this loop claims a ticket (`claimStatus.from` → `claimStatus.to`,
typically `To Do` → `In Progress`), status stays at `claimStatus.to` for the
rest of the pipeline's lifecycle — this loop never transitions it back
toward `claimStatus.from`, even on a passing verdict. The **label swap**
(`triggerLabel` → `handoffLabel`, on human approval or `autoPromoteLabel`)
is the real human-approval gate; status is not overloaded to also signal
that.

This matters for `dev-loop`, which has no atomic claim step of its own and
instead polls directly for `labels = "pipeline:dev"` (the `handoffLabel`
this loop swaps in) plus an assignee match — no status clause at all, since
the label now signals pipeline stage directly — see dev-loop's own
`docs/config.md` for its "Future: multiple concurrent loop instances" note,
which applies to this loop too (this MVP assumes exactly one research-loop
instance running against a project at a time).

### Assignee bookkeeping

Right after claiming a ticket, this loop checks its assignee: if currently
unassigned, it's assigned to a configured human via `JiraClient.assignTicket`.
If already assigned to anyone, it's left alone — "assign if unassigned," not
"reassign to force ownership."

The human's Jira account ID (`JIRA_ASSIGNEE_ACCOUNT_ID`) lives in `.env`, not
`pipeline.<project>.config.json` — it's a per-machine/per-runner-identity
setting like `JIRA_EMAIL`/`JIRA_API_TOKEN`, not per-project wiring. Read via
`assigneeAccountIdFromEnv()` in `src/jira-client.ts`, same pattern as
`credentialsFromEnv()`. Find your own account ID via the Atlassian REST API
(`GET /rest/api/3/myself`) or your Jira profile URL.

**Env file location.** The npm scripts that need credentials (`loop`,
`check-auth`, `cutover:relabel`, `reset-project:remote`) load
`--env-file="${DEVLOOP_ENV_FILE:-.env}"`, so with the variable unset they
read `.env` in the repo root, as before. Recommended:
`DEVLOOP_ENV_FILE=$HOME/.config/dev-loop/.env` (export it in your shell
profile). Why: the repo root is the `claude -p` spawn cwd, so a `.env` there
is one `cat .env` away from every run (settings deny `Read`, not a Bash
`cat`). Move the file yourself; nothing in this repo moves or creates it.
When `DEVLOOP_ENV_FILE` is set and a `.env` still exists in the repo root,
`npm run loop` logs a warning at startup, unless the variable resolves to
that root `.env` itself (e.g. `DEVLOOP_ENV_FILE=.env`).

The assign call is wrapped in try/catch and surfaced via the existing
`jiraSyncError` result field — a failed assignment never blocks the actual
work or crashes the loop.

### Appendix A (Jira wiring)

Every Jira-specific value above starts as the literal placeholder string
`"___"` in a fresh `pipeline.<project>.config.json`. `findPlaceholders()` /
`assertNoPlaceholders()` in `src/config.ts` detect leftover placeholders —
`RealJiraClient` refuses to make a Jira call while any remain. Filling these
in for a real project means: confirming the three pipeline label strings
(`triggerLabel`, `handoffLabel`, `repoLabel`) and checking the *child
ticket* workflow for real status names.

### Adding a new project

1. Copy an existing `pipeline.<project>.config.json` to
   `pipeline.<new-project>.config.json`.
2. Fill in that project's own label strings, statuses, JQL, `targetRepo`,
   and `github.repo` (derived from the same targetRepo).
   If `package.json` isn't at the repo root, or the project pins Node, add a
   `targetRepo.local` block (see "2.0.0 shape" above); see `docs/projects/`
   for a worked example.
3. Run it via `npm run loop -- --project=<new-project>` —
   `resolveProjectConfigPath()` finds it automatically by the naming
   convention above; no code changes required.

No code changes required. The project's **repo slug** — used to namespace
`runs/<slug>.jsonl` and `.pipeline/<slug>/...` so multiple projects can
coexist under one `research-loop` checkout — is derived from `targetRepo.url`
by `repoSlugFromUrl()` in `src/config.ts` (e.g. `"webtarsthree"` from
`git@github.com:fandango/webtarsthree.git`), not a separate config field.

## Dev phase

### Selecting a project (CLI)

`src/main.ts` requires `--project=<name>`, resolved via
`resolveProjectConfigPath()` in `src/core/config.ts` to
`pipeline.<name>.config.json` at the repo root:

```
npm run loop -- --project=webtarsthree
npm run loop -- --stream --project=webtarsthree
npm run loop -- --project=catalog-ui-public --once
```

Since 2.1.0 every value flag is `--name=value` only (`src/core/flags.ts`).
The old space-separated `--project webtarsthree` is refused with the exact
replacement (`use --project=webtarsthree`). Boolean flags (`--once`,
`--stream`) stay bare.

Omitting `--project`, or naming a project with no matching config file,
fails immediately — before any Jira/GitHub call — with a list of the
projects actually present (every `pipeline.*.config.json` at the repo
root except `pipeline.loop.config.json`, which is loop-mechanics, not a
project). `--config=<path>` still works as a fallback for an arbitrary
path outside the naming convention; passing both `--project` and
`--config` together is an error.

Each terminal's own `--project` selects its own project independently —
running N terminals against N *different* projects is safe, since
per-project on-disk state (`runs/<slug>.jsonl`, `.pipeline/<slug>/...`)
is already namespaced by `repoSlugFromUrl()`. The one remaining gap is
two terminals against the *same* project — see "Future: multiple
concurrent loop instances" below, which this change does not solve.

### Shape

`src/core/types.ts`'s `Config` interface is the source of truth for
`pipeline.<project>.config.json`'s shape:

- `jira.triggerLabel` / `handoffLabel` — the two pipeline-stage labels a
  ticket moves through: `triggerLabel` (`"pipeline:dev"`) is this repo's
  own poll target — dev-loop's whole territory, end to end: picked up,
  coded, PR'd, code-reviewed, merged. `handoffLabel` (also
  `"pipeline:dev"`) is carried in this repo's Config for shape symmetry
  with research-loop's own Config, even though this repo's runtime never
  performs a label swap itself.
- `jira.claimStatus.{from,to}` — the status transition research-loop uses to
  atomically claim a ticket from an intake epic (race-safe:
  `JiraClient.claimTicket` returns `false`, never throws, if another
  process already claimed it). **dev-loop does not use this** — see
  "Ticket status never reverts" below.
- `jira.repoLabel` — a second, always-paired label naming which repo a
  ticket belongs to (e.g. `"repo:catalog-ui-management"`), ANDed into both
  `pollJql` templates alongside the stage label. Needed because more than
  one target repo can share a single Jira project — `catalog-ui-management`
  and `catalog-ui-public` both file into project `MC` — so the stage label
  alone (`triggerLabel`/`handoffLabel`) can't tell which repo a given
  `pipeline:dev`-labeled ticket actually belongs to; without this, whichever
  dev-loop instance happens to poll first could claim the wrong repo's
  ticket. Unlike `triggerLabel`/`handoffLabel`, `repoLabel` never changes
  across a ticket's lifecycle. A project with only one target repo (e.g.
  `webtarsthree`/`TARS`) doesn't strictly need this for disambiguation, but
  every `pipeline.<project>.config.json` sets it anyway for a uniform
  scheme across projects.
- `jira.pollJql.{refine,dev}` — JQL templates with `{label}` and
  `{repoLabel}` placeholders, filled in by `src/core/jql.ts`.
- `jira.statusNames.{bounced,prOpen}` — this Jira instance has no literal
  "bounced" status, so these map the loop's terminal outcomes onto whatever
  statuses actually exist in the *child ticket's* (Bug/Story/Task) workflow.
  **Important**: check the child issue type's own transitions
  (`getTransitionsForJiraIssue`) — epics have a separate, simpler workflow
  and will give you the wrong answer.
- `jira.codeReviewFields.{piiField,piiNoImpactOptionId,qaNotesField}` — see
  "Code Review transition screen fields" below. dev-loop-only; this Jira
  instance's Code Review transition (`prOpen`) has a required screen that
  rejects an empty payload. Optional in the shared `Config` type (a
  research-role config has no such key); the dev role's startup check,
  `assertNoPlaceholders(config, "dev")`, fails if it is missing.
- `ceilings.{maxRunsPerDay,maxCostPerRunUsd,runTimeoutMin}` — enforced by
  `src/core/ceilings.ts`; a breach pauses the loop, it never silently continues.
- `autoPromoteLabel` — the field research-loop's own config reads to decide
  whether to auto-swap a ticket straight to `handoffLabel` (`"pipeline:dev"`)
  without human approval, skipping the manual-review gate. This repo's own
  config carries the same field name for shape symmetry with research-loop's
  Config, but dev-loop's own runtime never reads it for a label-swap
  decision — only research-loop's `loop-runner.ts` does.
- `targetRepo.{url,defaultBranch}` — the codebase this pipeline operates on
  (not this pipeline repo itself).
- `targetRepo.path` (optional) — local filesystem path to an existing
  checkout of `targetRepo.url` on this machine. When set, per-run worktrees
  branch directly off it instead of a fresh clone into
  `.pipeline/<slug>/repo` — faster, and its `origin` remote is already the
  real one, so `ticket-to-pr`'s `git push`/`gh pr create` need no extra
  setup. Omit on a machine with no local checkout yet; the clone-based flow
  is used instead.
- `github.repo` — the GitHub repo this project's mirror Issues live in
  (`"owner/repo"` shorthand, passed straight to `gh --repo`). One target
  repo per project config, same granularity as `targetRepo`. Mirrors
  research-loop's own `Config.github.repo` — research-loop creates the
  mirror Issue there; this repo's `GitHubClient` (`src/core/github-client.ts`)
  reads and writes to the same repo once a ticket crosses to
  `pipeline:dev`.

### Sandbox (optional)

(Same as in the Research phase section.) An optional top-level `sandbox` block selects a sandbox adapter for agent
spawns. Absent means the `none` adapter: spawns are exactly as before.

```json
"sandbox": { "adapter": "none", "mode": "enforce" }
```

- `adapter` — a registered adapter name (`none` or `sbx`). Default `none`.
- `mode` — `"discover"` or `"enforce"`. Default `"enforce"`.
- An adapter's own sub-block is keyed by its name (`sandbox.<adapter>`) and
  validated by that adapter; errors are prefixed `sandbox.<adapter>: `.
- `sandbox.sbx` (adapter `sbx`, Docker Sandboxes) takes:
  - `kitDir` — required, an absolute path (or `~/...`) to the Keystone kit
    folder (must hold a kit `.yaml`).
  - `template` — optional, a saved `sbx template save` image such as
    `"docker.io/library/dev-loop-sbx:v1"` (node, jq, direnv, the HTTPS rewrite, the target `.envrc` approval).
    Created with `-t <ref> --pull never`; the kit is still applied.
  - `memory` — optional, e.g. `"4g"` or `"512m"`.
  - `mcp` — optional list of MCP server names registered with
    `sbx mcp add` (e.g. `["atlassian"]`), passed as `--static-mcp`.
    Preflight refuses one that is not registered or not ready.
  - `hostSkills` — optional list of your own skill folder names under
    `~/.claude/skills` that a pipeline skill reads by path (today only
    `push-branch`, read by ticket-to-pr Phase 5). The sandbox can't see
    `~/.claude`, so each is mounted read-only at
    `/home/agent/.dev-loop/skills/<name>` (sbx reserves
    `/home/agent/.claude/skills`), and dev is passed
    `<name>=<that SKILL.md>`. Preflight refuses one with no `SKILL.md` on
    the host, or one not readable in the sandbox. A run on the host is
    unchanged. `test/sandbox/sbx/host-skills-drift.test.ts` fails when a
    pipeline skill starts reading one that isn't listed.
  - `envAllow` — optional list of bare env var names to pass into the
    sandbox, added to the defaults (the three `ANTHROPIC_DEFAULT_*_MODEL`
    names and `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). Secret-shaped names
    (`TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `AUTH`) are refused.

  Setup steps: [sandbox-sbx.md](sandbox-sbx.md).
- Any other key is rejected (`sandbox: unknown key "<k>"`).
- CLI precedence: `--sandbox=<name>` wins over `sandbox.adapter`.
  `--sandbox=none` is the per-run off switch. An unknown name fails at
  startup with `--sandbox: unknown sandbox adapter ...`.
- **Opt-in per run:** leave out `adapter` and keep only `mode` and the
  adapter's sub-block. A plain run uses `none`; `--sandbox=<name>` uses the
  settings. Every sub-block present is validated at load, selected or not.
  `webtarsthree` is set up this way for `sbx` while sbx is being vetted:
  `npm run loop -- --project=webtarsthree --sandbox=sbx ...`.

### Ticket status never reverts

Once research-loop claims a ticket (`To Do` → `In Progress`), status stays
`In Progress` for the rest of the pipeline's lifecycle — no loop ever
transitions it back toward `To Do`. The **label swap**
(`triggerLabel` → `handoffLabel`, on human approval or `autoPromoteLabel`)
is the real human-approval gate; status is not overloaded to also signal
that.

This means dev-loop can't claim a ticket the way research-loop does (there's
no `In Progress` → `In Progress` self-transition in a normal Jira workflow).
Instead, `jira.pollJql.dev` matches on `labels = "pipeline:dev"` directly
plus an `assignee = "{assignee}"` clause (filled from
`JIRA_ASSIGNEE_ACCOUNT_ID`, see below), plus (as of the bounce-loop fix
below) `AND status != "{bouncedStatus}"` (filled from
`jira.statusNames.bounced`) and (as of the landed-loop fix below)
`AND status != "{prOpenStatus}"` (filled from `jira.statusNames.prOpen`)
and (2026-11-17, TARS-1640) `AND statusCategory != Done`, so a closed or
done ticket that still carries the dev label is never run again
— the label signals pipeline stage, but a genuine bounce, a landed PR or a
finished ticket each need their own exclusion so the very next poll cycle doesn't
immediately re-match and re-run the same ticket. `runLoopIteration`
for `loopKind: "dev"` still has **no atomic claim step at all**: it goes
straight from poll to running the skill. This is safe only because this
MVP assumes exactly one dev-loop instance is ever running against a
project at a time.

**Bounce-loop bug, fixed:** before this exclusion clause existed, a
bounced ticket (status transitioned to `statusNames.bounced`, e.g.
"Blocked") kept matching `pollJql.dev` every single poll cycle
(`postRunDelaySec` = 5s) since nothing about the JQL's own match criteria
ever changed on a bounce — only the label-based design (`triggerLabel`/
`handoffLabel`) changed anything, and a bounce never touches the label.
Confirmed live on TARS-1462: 5 near-identical bounces in ~14 minutes,
~$2.3 total cost, until the process was killed by hand. See
`CHANGELOG.md`'s entry for this fix and research-loop's
`docs/future-enhancements.md`'s "dev-loop bounce-loop bug" entry for the
full incident writeup and the tradeoff this fix resolves.

**Landed-loop bug, fixed:** the same shape of bug, one status over. A
landed PR transitions the ticket to `statusNames.prOpen` (e.g. "Code
Review") per `src/roles/dev/phase.ts`'s Phase-5 write, but nothing excluded that
status from `pollJql.dev` either, so a ticket kept re-matching the poll
after its PR was already open — same label, same assignee, status now
"Code Review" instead of "Blocked" but still `!= "Blocked"`. Each
re-poll correctly diagnosed "PR already open, nothing to do" at Phase 0
intake and bounced with `failure_category: "blocked"`, but that
diagnosis itself costs a full run. Confirmed live on TARS-1465: 5
consecutive re-runs over ~35 minutes after PR #431 landed, ~$3 total
cost, each one re-discovering and re-reporting the same already-landed
state before the fix. See `CHANGELOG.md`'s entry for this fix.

**Stuck-at-wrong-status bug, fixed:** the `pollJql.dev` exclusion above
only helps once the ticket's real Jira status actually reaches
`statusNames.prOpen`. If the original landed-verdict transition to Code
Review itself silently fails (a transient API error, or a race with
another write to the same ticket — both caught by `src/roles/dev/phase.ts`'s own
try/catch, which logs the run but never re-attempts the transition), the
ticket's real status stays wherever it was before (e.g. "In Progress"),
which the `prOpen` exclusion does nothing for, and every subsequent poll
still matches, re-runs, and re-bounces. Confirmed live on TARS-1465 a
second time: the *original* Code Review transition never took (Jira's
own changelog shows the ticket sitting at "In Progress" throughout),
so even with the `pollJql.dev` fix above in place it re-ran and
re-bounced 7+ times over 45 minutes, each bounce correctly reporting "PR
already open, nothing to do" but never correcting Jira's own state.
**Fix**: the bounced-with-existing-PR branch of `src/roles/dev/phase.ts` now
checks the polled ticket's real status against `statusNames.prOpen` and,
if they differ, performs the Code Review transition itself (self-heal)
before posting its GitHub comment — using the same fields a normal
landed verdict sends. If the ticket is already correctly at `prOpen`,
the transition is skipped as a no-op — this branch never transitions
toward `bounced`, only ever toward `prOpen`, so TARS-1389's original
"don't clobber Code Review back to Blocked" invariant stays intact.
This is a genuinely narrow trigger — it only fires when the earlier
landed-verdict write already failed — but nothing before this fix could
ever recover from it once it happened, so the ticket looped
indefinitely, burning cost every cycle, until a human noticed and
intervened by hand.

**Future: multiple concurrent loop instances.** Running more than one
research-loop or dev-loop terminal against the same project at once has no
coordination mechanism today and would race. A real fix would need
something like a per-instance label (e.g. `Runner1`/`Dev1`, incrementing per
instance) checked and set at pickup time, or each loop process being aware
of how many sibling instances are running. Not built — noted here so it's
not forgotten if this pipeline needs to scale beyond one terminal per loop.
`jira.repoLabel` (above) is a related but distinct concern — it disambiguates
*which repo* within a shared Jira project, not concurrent instances of the
*same* project/repo pair; the latter is still unsolved and still races.
Concretely: `repoLabel` prevents a `catalog-ui-management`-scoped dev-loop
instance from grabbing a `catalog-ui-public` ticket, but running two
dev-loop instances both scoped to `catalog-ui-management` at once still
races exactly as described above. `--project=<name>` (`CHANGELOG.md`,
2026-09-16) makes N-*different*-projects-concurrent safe, but doesn't
touch this gap — tracked as its own enhancement in research-loop's
`docs/future-enhancements.md` ("Concurrent loop instances against the
*same* project (N-per-project)"), since that's this pipeline's shared
holding pen for unimplemented ideas.

### Assignee bookkeeping

Both loops check the ticket's assignee right when they pick it up: if it's
currently unassigned, they assign it to a configured human via
`JiraClient.assignTicket`. If it's already assigned to anyone, it's left
alone — this is "assign if unassigned," not "reassign to force ownership."

The human's Jira account ID (`JIRA_ASSIGNEE_ACCOUNT_ID`) lives in `.env`, not
`pipeline.<project>.config.json` — it's a per-machine/per-runner-identity
setting like `JIRA_EMAIL`/`JIRA_API_TOKEN`, not per-project wiring. Read via
`assigneeAccountIdFromEnv()` in `src/core/jira-client.ts`, same pattern as
`credentialsFromEnv()`. Find your own account ID via the Atlassian REST API
(`GET /rest/api/3/myself`) or your Jira profile URL. Where that env file
lives: see "Env file location" under the research phase's Assignee
bookkeeping above.

The assign call is wrapped in try/catch and surfaced via the existing
`jiraSyncError` result field — a failed assignment never blocks the actual
work or crashes the loop.

### A landed dev-loop verdict never moves the epic

TARS-1349's real Jira run (the first end-to-end dev-loop pass) landed a PR
but never actually moved the ticket to Code Review — `moveToEpic` ran, but
nothing ever called `transitionStatus` for a landed outcome, so the
transition itself was simply missing from the code, not rejected by Jira.
That was fixed the same night — but the first fix also moved the ticket's
**epic** on a landed verdict, which turned out to be its own bug: at the
time, research-loop's spec-review epic ("Pipeline: Review") already meant
"refined spec is awaiting human approval," and landing a dev-loop PR there
too overloaded that same epic to mean two different things depending on
which ticket you were looking at — confirmed confusing on the real board
(landed PRs and spec-review tickets both showed the same epic name, with
no way to tell them apart without opening each one). That epic no longer
exists at all now (epics were retired system-wide in favor of a Jira label
trigger — see `CHANGELOG.md`) — but the underlying fix stands regardless
of naming.

Fixed by removing the epic move entirely for a landed dev-loop verdict —
`decideEpicMove` used to return `null` whenever `loopKind === "dev"`,
regardless of outcome; that function (and the epic-move call site
entirely) has since been deleted outright, since no loop moves anything
epic-or-label-shaped on a landed dev-loop verdict at all. A landed ticket
stays at whatever label it already carries (`handoffLabel`,
`"pipeline:dev"`); **status alone** — `In Progress` → `Code Review` — is
the "needs code review" signal now. research-loop's own landed/ready
verdicts still swap the label (`triggerLabel` → `handoffLabel`). Since
2.0.0 the worker cycle does this on every green verdict, and
`autoPromoteLabel` no longer exists.

### Code Review transition screen fields

Separately: this Jira instance's `statusNames.prOpen` transition ("Ready
for Code Review") has `hasScreen: true` — a required Jira UI screen with
PII/security and QA-notes fields. The interactive `push-branch` skill
(`~/.claude/skills/push-branch/SKILL.md`) already handles this by hand
today, by sending specific field values alongside the transition request;
`runLoopIteration` now mirrors that same write for a **landed dev-loop**
verdict only (never for research-loop, which has no PR to review):

- `jira.codeReviewFields.piiField` (`customfield_13504`, "Covered
  Information Data Inventory") is set to `[{ id: piiNoImpactOptionId }]` —
  unconditionally declaring **"No Impact."** This mirrors push-branch's own
  behavior exactly; neither push-branch nor this pipeline performs a real
  PII/security assessment of the diff. That's a known gap, not solved here
  — if this pipeline ever handles a project where PII impact is a real
  possibility, this needs actual assessment logic, not a hardcoded default.
- `jira.codeReviewFields.qaNotesField` (`customfield_14226`, "QA Notes") is
  a rich-text field — Jira rejects a plain string for it ("Operation value
  must be an Atlassian Document"), confirmed against a real transition
  attempt — so it's set to a short Atlassian Document (ADF)
  (`buildQaNotesAdf()` in `src/roles/dev/code-review.ts` — one paragraph per line,
  built purely from the verdict's PR URL and verify-loop count), not from
  anything the skill writes — no `SKILL.md`/verdict.json contract change.

`JiraClient.transitionStatus` takes an optional third `fields` argument for
this — omitted entirely (not sent as `{}`) when a transition needs none
(e.g. the `bounced` transition), so a transition with no screen requirement
isn't given an unnecessary payload.

### Per-poll merge-reconciliation pass and landed-ticket guard

Merges happen while dev-loop is off, and a GitHub workflow/automation on PR
merge then moves the ticket out of Code Review (e.g. to Development Complete), so
neither decision below looks at Jira status.

**Reconcile.** At the top of every poll cycle (before `runLoopIteration`),
`main.ts` runs `reconcileMergedTickets` (`src/roles/dev/reconcile.ts`). It takes every
ticket whose latest `"landed"` line in `runs/<slug>.jsonl` ended within the
last 30 days (no Jira query), checks the real merge state via `gh pr view
<url> --json state,mergedAt,baseRefName` (reconcile ignores the base), and for each merged PR:

1. comments on the mirror GitHub Issue ("Closed automatically by dev-loop":
   PR URL, merge time, ticket key, reason) and closes it
   (`state_reason: "completed"`); skipped if the Issue is already closed;
2. removes `handoffLabel` (`pipeline:dev`) from the Jira ticket with
   `JiraClient.removeLabel`, leaving only the repo label.

The label removal is the only Jira write: status and assignee are never
touched (a human closes the Jira ticket). A failed comment or label removal
never blocks the rest and is not reported as an error. `main.ts` passes a
process-lifetime `reconciled` set so a finished ticket is not re-checked
every cycle; a restart re-checks recent ones, which is harmless (idempotent).
A per-ticket `gh` failure is recorded in `errors` and the pass continues.

**Landed-ticket guard.** After polling and before `runSkill`,
`runLoopIteration` (dev loop only) looks up the polled ticket's latest
`"landed"` PR. If that PR is merged or still open, the ticket is skipped
(no run, no cost, one log line per skip) and the poll is repeated with
`AND key != "…"` so it cannot block tickets behind it. If the PR's state
cannot be read, the ticket is also skipped. This is the backstop for a
failed label removal, or a merge reconcile has not seen yet. A landed PR
closed without merging does not block a re-run.

### Blocker gate (Jira "is blocked by" links)

`src/core/blocker-gate.ts` holds the one rule. A ticket with Jira "is
blocked by" links (`JiraClient.getBlockedBy`) is worked only when every
blocker is **cleared**. A blocker is cleared when its PR has merged into the
default branch of this project's own `github.repo`. Either the blocker's
recorded landed PR is a `https://github.com/<repo>/pull/<n>` URL for this
repo and gh reports it merged with `baseRefName` equal to the default branch
(a recorded PR for any other repo is ignored), or `gh pr list --state merged` finds a PR
into the default branch whose head branch or title contains the blocker key
as a whole token (`TARS-1` never matches `TARS-12`). Anything else is not
cleared: an open PR, a merge into another base, a blocker from another Jira
project (gh is not called for it), or any error. A `gh` or Jira error is
reported as `check failed`, so the gate fails closed. A blocker key that fails the
ticket-key regex is not cleared (`check failed: invalid key`). Cleared results
are cached per `repo#key` for the process lifetime, because a merge never reverts. Failures are
never cached.

A blocker that is Done with no PR, or that lives in another repo or project,
gets the reason `blocker <K> has no merged PR in <repo> — needs a human`. The
gate never clears it on its own. A human clears it by **removing the Jira
link** (a manager's decision), and the ticket is picked up on the next poll.

### Appendix A (Jira wiring)

Every Jira-specific value above starts as the literal placeholder string
`"___"` in a fresh `pipeline.<project>.config.json`. `findPlaceholders()` /
`assertNoPlaceholders()` in `src/core/config.ts` detect leftover placeholders —
`RealJiraClient` refuses to make a Jira call while any remain. Filling these
in for a real project means: confirming the three pipeline label strings
(`triggerLabel`, `handoffLabel`, `repoLabel`) and checking the *child
ticket* workflow for real status names.

### Adding a new project

1. Copy an existing `pipeline.<project>.config.json` to
   `pipeline.<new-project>.config.json`.
2. Fill in that project's own label strings, statuses, JQL, `targetRepo`,
   and `github.repo` (the mirror Issue repo, same granularity as
   `targetRepo`).
   If `package.json` isn't at the repo root, or the project pins Node, add a
   `targetRepo.local` block (see "2.0.0 shape" above); see `docs/projects/`
   for a worked example.
3. Run it via `npm run loop -- --project=<new-project>` —
   `resolveProjectConfigPath()` finds it automatically by the naming
   convention above; no code changes required.

No code changes required. The project's **repo slug** — used to namespace
`runs/<slug>.jsonl` and `.pipeline/<slug>/...` so multiple projects can
coexist under one `dev-loop` checkout — is derived from `targetRepo.url` by
`repoSlugFromUrl()` in `src/core/config.ts` (e.g. `"webtarsthree"` from
`git@github.com:fandango/webtarsthree.git`), not a separate config field.
