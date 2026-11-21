# Logging

> Merged in dev-loop 2.0.0: one repo, two phases. `## Research phase` is the
> former research-loop doc (`--phase=research`); `## Dev phase` is the former
> dev-loop doc (`--phase=dev`). Wording inside each section still describes its
> repo as it was; "this repo" / "the sibling repo" there means that phase, and
> paths like `src/types.ts` map to `src/core/` and `src/roles/<phase>/` now.
> See `docs/migration-ledger.md`.

## Research phase

### runs/&lt;project&gt;.jsonl — audit trail

Append-only, one JSON line per completed loop iteration, written by
`appendRunLog()` in `src/runs-log.ts` — this module is the single writer;
it never rewrites or truncates. Namespaced per project (via the repo slug,
see `docs/config.md`) so multiple projects' history can coexist. Gitignored
(`runs/`) — this is local run data, not tracked source.

Schema: `RunLogLine` in `src/types.ts` — ticket, skill, skill_version,
model, started/ended timestamps, outcome, phase_reached, red_confirmed,
verify_loops, retries, failure_category, detail, pr, cost_usd, tokens
(`pr` and TDD fields are always null/zero for this repo's runs — they only
apply to `dev-loop`), plus two optional fields: `log_version` (schema
version this line was written under — `"1.1"` as of the `size_trajectory`
field below; a line with no `log_version` at all is implicitly `"1.0"`,
never backfilled) and `size_trajectory` (shadow-mode size telemetry —
`step4_tshirt`, `delta`, `final_score`, written by `verifier-agent` on a
passing run and carried through from `verdict.json` unchanged — see
`docs/skills.md`). **Pure telemetry**: nothing reads or acts on
`size_trajectory` yet. It exists so enough real-run history accumulates to
later decide whether it should replace the Definition-of-ready checklist's
items 4/8 — see `docs/future-enhancements.md`'s size-score entry for what
that would require and why it isn't built yet. A malformed
`size_trajectory` in `verdict.json` is dropped (not persisted) by
`parseSizeTrajectory` in `src/verdict.ts` before it ever reaches this
file — it can never flip a run's `outcome`.

### .pipeline/&lt;slug&gt;/ — per-run scratch space

- `.pipeline/<slug>/repo/` — used only when `targetRepo.path` is **not**
  set in config: a shared `git clone` of the target repo, kept current with
  `git fetch` **only**. No run ever checks out a branch or resets this
  directory directly — a human can `cd` into it at any time without a
  background run pulling the rug out from under them. When `targetRepo.path`
  **is** set (a local checkout already exists on this machine), worktrees
  branch directly off that path instead and this directory is never created.
- `<targetRepo.path>/.claude/worktrees/<TICKET>-<RUN_ID>-ground/` (or
  `.pipeline/<slug>/repo/.claude/worktrees/<TICKET>-<RUN_ID>-ground/` in the
  fallback case) — this run's own isolated, detached `git worktree`,
  **nested inside the checkout it was branched from**, not a sibling path
  elsewhere. Its `direnv` loads the loop's fake env,
  `<REPO_DIR>/.claude/worktrees/.envrc` (placeholder values from the
  committed `.envrc.example`, `src/core/fake-env.ts`), never the person's
  real `.envrc`. Created at the start of Ground and removed
  unconditionally (hard gate) before the run's Cleanup completes — see
  `docs/skills.md`. `ticket-refine` never branches or commits here either;
  it's read-only by convention, just isolated per run. Expected to be
  listed in `targetRepo.path`'s own `.git/info/exclude` (machine-local,
  never committed) so it doesn't clutter a human's normal `git status` in
  that repo.
- `.pipeline/<slug>/runs/<TICKET>-<RUN_ID>/` — one directory per run:
  - `progress.jsonl` — append-only phase-transition log the skill writes
    *while running* (phase_start/phase_end/note events for
    triage/interpret/ground/attack/scope/blocked-check/synthesize/verify),
    so a future dashboard can show live progress without parsing model
    output.
  - `verdict.json` — the skill's final self-report (see `docs/skills.md`).

Also gitignored (`.pipeline/`) — entirely local working state.

### The always-emitted result line

Whatever step a run ends at, the skill emits exactly one line — to stdout,
as `progress.jsonl`'s final event, and as `verdict.json`'s `detail` field:

- `RESULT: ready — refined ticket written`
- `RESULT: bounced (<failure_category>) — <one-line reason with evidence>`
- `RESULT: error — <what went wrong>` (tooling/environment failures only)

This is the one line a human skimming a terminal, or a future dashboard,
needs to read to know what happened — no other file required.

### npm run stats

`scripts/stats.mjs` rolls up `runs/<project>.jsonl` into a landed/bounced/
error/killed breakdown with percentages, a `failure_category` histogram,
and total cost — the "are we succeeding over time" view. ("landed" here
reflects the shared `RunOutcome` type; this repo's own passing outcome,
`ready`, is normalized to it by the loop runner.)

```
npm run stats                              # last 7 days, webtarsthree
npm run stats -- --project=webtarsthree --days=30
```

## Dev phase

### runs/&lt;project&gt;.jsonl — audit trail

Append-only, one JSON line per completed loop iteration, written by
`appendRunLog()` in `src/core/runs-log.ts` — this module is the single writer;
it never rewrites or truncates. Namespaced per project (via the repo slug,
see `docs/config.md`) so multiple projects' history can coexist. Gitignored
(`runs/`) — this is local run data, not tracked source.

Schema: `RunLogLine` in `src/core/types.ts` — ticket, skill, skill_version,
model, started/ended timestamps, outcome, phase_reached, red_confirmed,
verify_loops, retries, failure_category, detail, pr, cost_usd, tokens.

### .pipeline/&lt;slug&gt;/ — per-run scratch space

- `.pipeline/<slug>/repo/` — used only when `targetRepo.path` is **not**
  set in config: a shared `git clone` of the target repo, kept current with
  `git fetch` **only**. No run ever checks out a branch or resets this
  directory directly — a human can `cd` into it at any time without a
  background run pulling the rug out from under them. When `targetRepo.path`
  **is** set (a local checkout already exists on this machine, with its
  real `origin` remote already in place for push/PR), worktrees branch
  directly off that path instead and this directory is never created.
- `<targetRepo.path>/.claude/worktrees/<TICKET>-<RUN_ID>/` (or
  `.pipeline/<slug>/repo/.claude/worktrees/<TICKET>-<RUN_ID>/` in the fallback
  case) — this run's own isolated `git worktree`, **nested inside the
  checkout it was branched from**, not a sibling path elsewhere, on its
  own branch (`<TICKET>-<slug>`). Its `direnv` loads the loop's fake env
  (`<REPO_DIR>/.claude/worktrees/.envrc`), never the person's real
  `.envrc`. Removed once the run's Cleanup runs — unconditionally if the run
  landed or bounced with everything committed, but deliberately **kept**
  if the run bounces with uncommitted in-progress work, so a human can
  inspect exactly what was tried (see `docs/skills.md`). Expected to be
  listed in `targetRepo.path`'s own `.git/info/exclude` (machine-local,
  never committed) so it doesn't clutter a human's normal `git status` in
  that repo.
- `.pipeline/<slug>/runs/<TICKET>-<RUN_ID>/` — one directory per run:
  - `progress.jsonl` — append-only phase-transition log a skill writes
    *while running* (phase_start/phase_end/note events), so a future
    dashboard can show live progress without parsing model output.
  - `verdict.json` — the skill's final self-report (see `docs/skills.md`).

Also gitignored (`.pipeline/`) — entirely local working state.

### The always-emitted result line

Whatever phase a run ends at, the skill emits exactly one line — to stdout,
as `progress.jsonl`'s final event, and as `verdict.json`'s `detail` field:

- `RESULT: landed — PR opened at <url>`
- `RESULT: bounced (<failure_category>) — <one-line reason with evidence>`
- `RESULT: error — <what went wrong>` (tooling/environment failures only)

This is the one line a human skimming a terminal, or a future dashboard,
needs to read to know what happened — no other file required.

### npm run stats (2.0.0)

The two v1 `npm run stats` sections above describe the pre-2.0.0 script.
`scripts/stats.mjs` now reads, and never writes:

- **default (v2):** `runs/v2/<project>.jsonl`, per role, counted from
  **phase entries** (not records): phases run, landed, bounced,
  error/killed, cost sum, and a `failure_category` histogram. A phase is
  in the window when its `started` is within `--days`. Records with no
  phases (`handoff-done`, `interrupted`, `resume-dropped`, `parked`,
  `unparked`, `skipped-*`) add nothing. After the role lines it prints
  `parked: <n> ticket(s) currently parked` when any ticket's latest record
  is `parked` (not windowed).
- **`--v1`:** v1 dev and v1 research reported separately. Each reads
  `runs/v1/<role>/<project>.jsonl` when it exists, else the pre-cutover
  live log (dev: `runs/<project>.jsonl`, research:
  `research-loop/runs/<project>.jsonl`), and prints which file it read.
- **`--root=<dir>`:** the state root (default: the repo root).

```
npm run stats                              # v2, last 7 days, webtarsthree
npm run stats -- --project=webtarsthree --days=30
npm run stats -- --v1
```

The same v1 resolution (post-cutover first, else pre-cutover) is used by
`resolveV1RunsLog` in `src/core/iteration-log.ts`, behind reconcile's
`findLandedTicketsAcross`, the landed guard's `findLandedPrUrlAcross`, the
research "already refined in v1" check (`hasLandedV1`) and reset's
`--close-remote` PR lookup (`findRecordedPrUrlAcross`).

### v2 path layout

All paths come from `src/core/paths.ts` (validated segments, contained under
the repo root). v2: `runs/v2/<project>.jsonl`; run dirs
`.pipeline/v2/<project>/<session>/<ticket>/<phase>-<runId>/` (raw usage is
`usage.json` inside); clone `.pipeline/v2/<project>/repo`; `.../sessions`.
v1 archive: `runs/v1/<role>/<project>.jsonl`. `--phase=research|dev` write
v2 records to `runs/v2/<project>.jsonl` (2.0.0 Task 13). The runner passes
each skill its v2 run dir as `run-dir=` (absolute) and its target checkout as
`repo-dir=` (Task 15, `docs/skills.md` "Invocation contract"); the skill writes
`progress.jsonl`, `draft-spec.md` and `verdict.json` there, and raw claude
usage goes to `usage.json` beside them. The loop also writes
`project.json`, `attachments.json` + `attachments/`, and (research only)
`size-context.json` there before the spawn. No skill derives a run path, and the
cwd-relative legacy path functions are gone. Reset works on the v2 layout only
(`docs/reset.md`); `runs/v2/<project>.reset-archive.jsonl` holds what it
archived.

### v2 iteration record (`runs/v2/<project>.jsonl`)

One JSON line per ticket iteration (`src/core/iteration-log.ts`), append-only.
`phases` has one entry per skill run (empty for `skipped-blocked` /
`claim-error`). `detail` and `jira_sync_error` are redacted before writing. `jira_status_changed: true` is set when the iteration changed the ticket's Jira status (a claim or transition); only such records hold the ticket back for the 2-minute recent window.
Readers skip blank, truncated and malformed lines.

Phase-entry fields added by bounce criteria v2 (2.3.0), each optional:

- `diff_stats` (dev, landed): `{files, additions, deletions}` of the PR,
  read with `gh pr view --json changedFiles,additions,deletions` after the
  run. Absent when the read failed; never changes the outcome. Older
  landed PRs: `node scripts/backfill-diff-stats.mjs --project=<slug>
  [--dry-run]` writes `<log>.diff-stats.json` beside each log (keyed by PR
  URL) and never rewrites the log.
- `size_estimate` (`S|M|L|XL`) and `ac_count` (research, every outcome).
- `size_evidence` (research, an accepted too_large bounce).
- `verdict_check` (research): set when the loop's verdict check acted:
  `too_large_ungrounded`, `too_large_no_evidence`, `coverage_missing`
  (refused, entry is `agent_error`), `coverage_warned` (accepted, counted
  toward the warn period), `attachment_unreadable` (loop-made `blocked`
  bounce). See `docs/skills.md` "Loop checks on the research verdict".

Outcomes: `landed`, `bounced`, `error`, `killed`, `skipped-blocked`,
`claim-error`, `handoff-pending`, `handoff-done`, `skipped-pr-exists`,
`blocked-attempts`, `interrupted`, `resume-dropped`, and (2.2.0, sandbox):

- `parked`: an enforcing sandbox refused a phase run (network, credential
  or infra). `resume: <role>` is set, but no phase entry is written for the
  refused run, so it is not a failed attempt. A research phase that landed
  before a refused dev phase stays in `phases`. The record carries
  `parked: { role, failure_category: "sandbox_denied", denied: [{ kind,
  target }], approveHint?, sandbox?: { adapter, instance, prepare_ms },
  cost_usd, run_dir }`; `approveHint` and every
  `target` are redacted. Jira is not touched after the run (the claim
  before a research run still happens). A desktop notification fires
  (macOS, `osascript`, redacted), and the loop carries on, unless the
  refused run itself breached its role's cost or duration ceiling (its cost
  is real but not in `phases`), which pauses after the record as for any
  phase. When every refusal is `infra` (the sandbox itself failed), the
  run parks in either sandbox mode (discover relaxes only network and
  credential refusals) and the worker also pauses. While a ticket's
  latest record is `parked`, step 2 excludes it from every poll and step 0
  doesn't resume it.
- A `phases` entry also carries `sandbox: { adapter, instance, prepare_ms }`
  when the run was sandboxed. In discover mode, when the sandbox refused
  something but the run carried on, it also carries `denied: [{ kind,
  target }]` and `approveHint?` (both redacted); `npm run
  sandbox:approvals` lists these under "Discovered in discover mode (not
  parked)".
- `unparked`: written by `npm run sandbox:approvals -- --clear=<KEY>`
  (`phases: []`, `resume` copied from the park), so step 0 re-runs it.

```json
{"ticket":"TARS-1465","session":"s1","loop_version":"2.0.0","started":"2026-11-10T10:00:00.000Z","ended":"2026-11-10T10:41:00.000Z","outcome":"landed","phases":[{"role":"dev","skill":"ticket-to-pr","skill_version":"2.0.0","model":"opus","started":"2026-11-10T10:00:00.000Z","ended":"2026-11-10T10:41:00.000Z","outcome":"landed","phase_reached":"pr","cost_usd":4.2,"tokens":{"in":120000,"out":30000},"failure_category":null,"detail":"PR opened","pr":"https://github.com/org/repo/pull/12","run_dir":".pipeline/v2/webtarsthree/s1/TARS-1465/dev-20261110T100000Z"}]}
```

### The worker cycle (`src/worker/`)

`runWorkerIteration(deps)` (`src/worker/cycle.ts`) is one iteration. It works
at most one ticket and writes one record per ticket iteration; an idle
iteration writes nothing. The steps run in this order:

0. **Recover** (`recover.ts`). Right after the session is acquired,
   `recordAdoptedFlights` (main.ts; `runWorkerIteration` does it too if
   the caller didn't) writes every in-flight record the session adopted (its
   `inFlight`, then each `orphanedInFlight`, each logged) to the log with
   `resume: <role>`, then clears the lock's `inFlight`. Until then a signal
   leaves the lock alone, so the adopted run is never lost:
   - A crashed run is outcome `error` with one `error` phase (`agent_error`),
     which counts toward `maxAttemptsPerTicket`.
   - A run stopped by SIGINT/SIGTERM (main marks the lock's flight
     `interrupted: true`) is outcome `interrupted` with no phase, so it is not
     an attempt.
   - A dev flight with an open PR (`findOpenPrUrl`) in a dev-running process
     is self-healed instead: Code Review with the PR-link QA stub,
     `skipped-pr-exists` with a `landed` dev phase carrying the PR (this
     resets attempts and teaches the landed lookup), no rebuild.

   Before either a self-heal or a resume, the ticket's live Jira status is
   re-read: only `claimStatus.to` (In Progress) proceeds. A dev resume also
   accepts `statusNames.prOpen` (Code Review; Ruling 51): the dev run had
   landed before the crash or signal, so with an open PR it gets the same
   `skipped-pr-exists` record without a Jira transition, and with none
   (merged, closed, or the lookup failed) it is `resume-dropped` ("Code
   Review with no open PR"); dev is never re-run from Code Review. Any other
   status appends a phase-less `resume-dropped` record (not an attempt, no
   `resume`, so it resolves the pending resume); a failed status lookup
   leaves the resume pending, keeps the ticket out of this iteration's polls,
   and retries next iteration.

   Then, every iteration, one ticket whose latest record has `resume` set to
   a role this process runs, and that is below both the attempt cap and that
   role's `maxRunsPerDay`, is re-run without a claim. A research phase that
   ends `error`/`killed` also records `resume: "research"`: the claim moved
   the ticket out of the research poll's status, so this is how it is
   retried until the attempt cap blocks it. Dev errors need nothing extra,
   because the dev poll re-finds them. Its new record resolves it. The resume lives in the log,
   not the lock, because every `--phase` process of a project shares the
   session dir: a `--phase=dev` start can adopt a `--phase=research` crash
   and must leave it for a research process. A claim whose research phase
   never started (the session lock couldn't be written) is recorded the same
   way and pauses the worker.
1. **Pending handoffs** (`handoff.ts`). For every ticket whose latest research
   entry landed without `handoff: "done"` and that has no later dev entry,
   the label swap is retried. A success writes one phase-less `handoff-done`
   record (no swap repeats). A failure writes one phase-less `handoff-pending`
   record, and only when the ticket's previous record isn't already one. It
   never pauses.
2. **Exclude**. Every poll excludes `recentlyEnded` (2 min, only records with
   `jira_status_changed`, read from the log, so the exclusion survives
   restarts; a skipped ticket logs `[worker] <KEY> skipped: a run on it ended
   <N>s|<M>m ago`), tickets whose latest record is
   `parked`, and tickets at
   `maxAttemptsPerTicket` failed attempts of a role (`attempts.ts`). A ticket
   that has just reached the cap, for a role this process runs, gets a
   comment, the bounced status and one `blocked-attempts` record. A
   `--phase=research` process never blocks a ticket over dev failures.
3. **Dev first** (no claim). The candidates are step 1's handoffs, then the
   dev poll; a polled unassigned ticket is assigned (non-fatal), as in v1. The landed guard (recorded PR merged/open/unreadable) and the
   blocker gate apply.
4. **Research**. Research polls, skips anything with a landed research entry
   (v2, or the v1 research log), gates, then claims. A ticket that loses the
   claim race is re-polled; a claim that throws gets a `claim-error` record
   and is re-polled. At most 20 candidates are skipped per iteration. Once
   the research phase is green, the post-phase ceiling check runs, then the
   label handoff, then dev on the same ticket in one record. A breach means
   `handoff: "skipped-ceiling"` and paused. A failed swap means
   `handoff: "failed"`. If dev is capped or less than $1 of the ticket budget
   remains, the record is `[research]` with `handoff: "done"` and dev picks
   it up later.
5. The post-phase ceiling (cost/duration of the last phase) pauses after the
   record is appended.

Budgets (`--max-budget-usd`): research gets
`min(research.maxCostPerRunUsd, maxCostPerTicketUsd)`. Dev in the same
iteration gets `min(dev.maxCostPerRunUsd, maxCostPerTicketUsd − research
cost)`. A dev-only iteration gets `min(dev.maxCostPerRunUsd,
maxCostPerTicketUsd)`. `maxRunsPerDay` is counted per role. `paused` means a
ceiling breach, a Jira 401/403 on the poll, a lost session lock (any phase
already run is recorded first), or every enabled role at its daily cap. A
polled ticket whose key fails the ticket-key regex is logged once and
excluded from later polls by its numeric issue id (`id not in (...)`). A per-ticket failure never pauses or throws.
Jira comments built by `src/` end with a `— <session>` paragraph, and GitHub
comments end with a `— <session>` line.

`--phase=research` runs the cycle with only research enabled: no handoff and
no dev, so a green ticket stays pending for a dev-enabled worker.
`--phase=dev` runs it with only dev enabled: steps 1 and 3, plus the v1
reconcile pass.

## Parked tickets

When an enforcing sandbox refuses a phase run, the loop appends a `parked`
record (`phases: []`, `resume` set, details under `parked`) and skips the
ticket until it is cleared.

```
npm run sandbox:approvals                          # list parked tickets + discover-mode denials (webtarsthree)
npm run sandbox:approvals -- --project=<name>
npm run sandbox:approvals -- --clear=TARS-123      # un-park one
```

The list shows each refusal (`kind target`) and the adapter's allow hint. The
script only prints the hint; run it yourself, then `--clear=<KEY>`, which
appends an `unparked` record. The next loop iteration resumes the ticket's
parked role. A key that is not currently parked exits 1.
