# Skills

> Merged in dev-loop 2.0.0: one repo, two phases. `## Research phase` is the
> former research-loop doc; `## Dev phase` is the former dev-loop doc. Wording inside each section still describes its
> repo as it was; "this repo" / "the sibling repo" there means that phase, and
> paths like `src/types.ts` map to `src/core/` and `src/roles/<phase>/` now.
> See `docs/migration-ledger.md`.

## Invocation contract (2.0.0, both skills)

The loop runner (`src/worker/skill-runner.ts`) invokes each skill as

```
/<ticket-refine|ticket-to-pr> <KEY> run-dir=<abs RUN_DIR> repo-dir=<abs REPO_DIR>
```

- `RUN_DIR` is `resolveRepoPath(v2RunDir(...))`:
  `<repo>/.pipeline/v2/<project>/<session>/<KEY>/<role>-<RUN_ID>`. The runner
  creates it before spawning and afterwards reads `RUN_DIR/verdict.json`, the
  only place a verdict is read. Raw claude usage goes to `RUN_DIR/usage.json`.
- `RUN_DIR/attachments/` and `RUN_DIR/attachments.json` are written by the
  loop before every spawn, for both roles and every project
  (`src/core/attachments.ts`). The loop downloads the ticket's Jira attachments
  on the host with its own Jira credentials: text-like files and images only,
  at most 2 MB each and 10 MB per ticket. The manifest names each attachment
  as `fetched` (with `path`), `skipped` (with `reason`) or `failed` (with
  `error`). A failed listing writes the manifest with `error` and never stops
  the run. ticket-refine and ticket-to-pr read the manifest and the fetched
  files and never fetch one themselves; an attachment the ticket depends on
  that was not fetched is grounds for a bounce, cited from the manifest.
  For research, any unreadable attachment (or a failed listing) is a
  `blocked` bounce, and the loop enforces it (see "Loop checks on the
  research verdict" below).
- `RUN_DIR/size-context.json` is written by the loop before every
  **research** spawn (`src/core/size-context.ts`): the dev limits
  (`dev_max_cost_per_run_usd`, `dev_run_timeout_min`,
  `max_cost_per_ticket_usd`), `stats` (median and p90 of cost and minutes,
  nearest rank) over the 30 most recent landed tickets in the v1 and v2 dev
  logs, and per ticket its cost and minutes summed over every dev run, dev
  runs, QA loops, files/additions/deletions (from the entry's `diff_stats`
  or the backfill sidecar), research's `size_estimate` and `ac_count`.
  A project with no history gets `tickets: []`, null stats and its limits.
  A failure to build it is logged; the run still starts.
- `RUN_DIR/project.json` is written by the loop before every spawn
  (`src/core/project-profile.ts` `projectJson`): `{ appDir, nodeMajor,
  devCommand, devUrl }`, from the project config's `targetRepo.local` (see
  `docs/config.md`). ticket-to-pr, qa-agent, ticket-refine and recon-agent
  read it instead of guessing: installs, tests, coverage and the dev server
  run as `direnv exec <worktree>/<appDir> <cmd>`, git stays at `<worktree>`,
  and ticket-to-pr bounces `env_setup` when `node --version` in the app
  folder is not `nodeMajor`. Missing means the defaults (`.`, host Node,
  `npm run dev`, `http://localhost:3000`). The skills also read and follow
  the target repo's own `CLAUDE.md`/`AGENTS.md`, never create a real env file
  such as `app/.env.local`, and bounce on a hook failure they can't fix
  (never `--no-verify`).
- `REPO_DIR` is `targetRepo.path` when set, else the absolute v2 clone
  (`v2CloneDir`). The skill clones it if it has no `.git` yet, and creates its
  per-run worktree inside it: `<REPO_DIR>/.claude/worktrees/<KEY>-<RUN_ID>`
  (ticket-to-pr) or `...-<RUN_ID>-ground` (ticket-refine). `RUN_ID` is the last
  segment of `RUN_DIR` after its `<role>-` prefix.
- `src/core/build-prompt.ts` builds the line from validated values only (the
  key through `TICKET_KEY`, absolute normalized paths of `[A-Za-z0-9@._/+-]` only, a
  run dir ending in `/<KEY>/<role>-<RUN_ID>` under `/.pipeline/v2/`) and throws
  otherwise. The skills check again: a missing or malformed `run-dir=`/
  `repo-dir=` (not absolute, or no `/.pipeline/v2/`) means write no files and
  stop with `agent_error`. Skills never derive a run path.
- Both roles spawn with cwd = the repo root. Research adds
  `--settings {"claudeMdExcludes":["<repo>/CLAUDE.md"]}` (the root CLAUDE.md
  is the dev stance) and `--append-system-prompt <src/roles/research/stance.md>`
  (the skeptic stance; formerly `research-loop/CLAUDE.md`, which is gone),
  plus `permissions.deny` on Edit/Write/NotebookEdit under `REPO_DIR`
  (`--allowedTools` only auto-approves; without the deny, acceptEdits +
  `--add-dir` let research write the target checkout). Research writes only
  `RUN_DIR`; its Bash is not restricted, so it is only partly read-only.
- Every spawn: `--max-budget-usd`, a kill at the role's `runTimeoutMin`, and
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = runTimeoutMin × 60000`.
- The contract strings (`✅ research-loop -`, `❌ research-loop -`) are
  `CONTRACT` in `src/core/contract.ts`; `test/core/contract.test.ts` pins them
  byte-for-byte in both SKILL.md files. `test/structure.test.ts` checks every
  path `.claude/**` names exists and that no skill or agent hardcodes
  `.pipeline/`.

Where the sections below say "invoked as `claude -p "/ticket-refine <KEY>"`"
or name `.pipeline/<slug>/...` paths, read the contract above.

## Research phase

### ticket-refine

`.claude/skills/ticket-refine/SKILL.md` — the skeptic. Invoked by the loop
runner as `claude -p "/ticket-refine <TICKET-KEY>"`. Treats the raw ticket
as an unverified claim, not an instruction to execute, and runs a fixed
sequence against an isolated per-run `git worktree` branched off
`targetRepo.path` (a local checkout, if configured) or a shared fetch-only
clone at `.pipeline/<slug>/repo` otherwise (see `docs/logging.md`) — never
that source checkout directly, so a human working in it manually is never
affected by a background run:

0. **Triage & route** — pick a checklist by issue type (Bug vs Tech Story
   vs unknown); for bugs, determine fault domain (client-side vs upstream
   service) before anything else.
0.5. **Open/link the GitHub Issue** — opens/renames this run's mirror
   GitHub Issue (created or found by `main.ts` right after claim, per
   Phase 1 of `docs/future-enhancements.md`'s Jira label-trigger design)
   before Interpret, and remembers its number/URL for every GitHub-only
   comment the rest of the run writes.
1. **Interpret** — first exhausts available Jira context (this ticket's own
   comment thread, and linked issues one hop out) before concluding
   anything is ambiguous; only then restates the ask. More than one
   plausible reading *after* that context check is an immediate bounce
   (`spec_ambiguous`), never a coin flip. A cheap pre-gate before Ground
   catches only the zero-signal case (a bug with no repro/error/surface
   named at all, or a story with no AC and no current-vs-desired
   description) and bounces there without paying for subagent fan-out —
   everything short of that (including ordinary thin tickets) proceeds to
   Ground/Attack, and only bounces afterward if the investigation itself
   can't resolve the gap. Tickets here vary a lot by author and are often
   under-specified; the default is to investigate and bounce with
   evidence, not to bounce on input alone.
2. **Ground** — starts with a cheap **currency check**: one direct
   `Read`/`grep` on the specific file(s)/behavior the ticket names — no
   subagent fan-out — to confirm the ticket's premise still holds before
   paying for anything expensive. Fully resolved (the described gap no
   longer exists at all) bounces `spec_contradicted` right there, cheaply.
   Partially stale (real work remains, but the ticket's framing is wrong —
   e.g. it assumes a file needs creating when it already exists and the
   actual gap is extending it) is *not* a bounce: the premise is corrected
   in place and the run continues with the corrected understanding, since
   the work is real, just mis-described — a bounce here would just cost a
   human round-trip for something fixable in the same run. Only past this
   check does it become pragmatic, hypothesis-driven investigation, not a
   lookup: creates this run's worktree first, then forms 2-3 concrete
   competing explanations when the cause isn't obvious. If any hypothesis
   needs a live API call to test (not just reading client code),
   `ticket-refine` starts the target repo's own dev server *once* inside
   that worktree, checking first whether one's already running — then
   fans out one `recon-agent` per hypothesis in parallel (below), each
   testing its own hypothesis against the worktree (and the running dev
   server's local proxy routes, if relevant). "More than one confirmed, or
   none" is a finding to carry into Attack, not something to silently
   resolve by picking one.
3. **Attack** — spawn `devils-advocate-agent` (below) to try to break the
   working assumptions from Interpret/Ground.
4. **Scope & sequence** — if oversized, draft (never create) a split as
   comments for the human gate to approve; bounce `too_large`. Also logs a
   `step4_tshirt` (S/M/L/XL) note to `progress.jsonl` every run — pure
   shadow telemetry, no behavior change; see "Shadow-mode size telemetry"
   below.
5. **Blocked detection** — bounce `blocked` if work can't proceed regardless
   of spec quality (external dependency, missing access, upstream fault).
6. **Synthesize** — write the refined ticket (working comments during work
   go to the GitHub Issue, not Jira, per Phase 1's routing rule; on a
   passing verdict, the full `## ✅ research-loop - <short context>`
   content goes to the GitHub Issue and a short pointer comment of the
   same title convention goes to Jira). The stakeholder's original
   description is never touched, ever — see "Jira/GitHub content routing
   (Phase 1)" below.
7. **Verify** — spawn `verifier-agent` (below) for an independent
   definition-of-ready check before reporting a passing verdict.

Core rule: a bounce is a normal, successful exit — concrete evidence, not a
crash. Everything questioned here happens *once*, upstream of the human
review gate; once a ticket crosses into Review, `dev-loop` trusts it fully.
A bounce is written to one comment titled `❌ research-loop - <short
context>` — same greppable leading-icon + `research-loop -` prefix
convention as the passing-verdict `✅ research-loop - <short context>`
comment, in the same Context + Needs-decision shape as a passing verdict
(see `SKILL.md`'s "Ticket content protocol" item 3), so a human can tell
at a glance what decision unblocks the ticket. Neither title carries an
@-mention — dropped as excessive in practice (see `CHANGELOG.md`).

**Cleanup is a hard gate, unconditional, every run**: stop the dev server if
one was started, and remove this run's worktree — regardless of outcome
(ready, bounced at any step, or error). Since this skill never commits,
there's no "leave it for inspection" exception here (unlike `ticket-to-pr`,
which has one for uncommitted work — see dev-loop's `docs/skills.md`).

### Subagents

- **recon-agent** (`.claude/agents/recon-agent.md`) — one instance per
  hypothesis (spawned in parallel when Ground has more than one candidate
  explanation); each confirms or refutes only its own hypothesis, not a
  generic "does the ticket hold" pass. Works inside `ticket-refine`'s
  per-run worktree — never the checkout it was branched from — and can run
  the test suite or a throwaway repro script there, and, when `ticket-refine` handed it a
  running dev server's local URL, make live **read-only** calls against
  that instance's own proxy routes (never any other host, never a mutating
  call) — chained calls (e.g. search for an id, then fetch it) are expected
  when that's what it takes to see an endpoint's real response. It never
  starts/stops the dev server or manages the worktree itself — both
  lifecycles belong to `ticket-refine`. Trial and error is expected: a
  first attempt not panning out isn't grounds to report `inconclusive`
  without trying a different angle. For bugs, also determines fault domain
  and, via `git log -p`/`git blame` on the specific file(s), the regression
  window — while scanning that commit history for Jira keys that lead to a
  prior ticket which touched the same code. Never proposes a fix.
- **devils-advocate-agent** (`.claude/agents/devils-advocate-agent.md`) —
  attacks Interpret/Ground's assumptions across four angles (symptom vs.
  cause? hidden dependencies? unstated scope? ambiguity Ground missed?) —
  deliberately narrowed from an earlier six to angles judgeable from
  Interpret/Ground's own findings, without needing this subagent's own
  open-ended codebase exploration (which risked running long enough to hit
  the CLI's own background-task time limit in headless mode); "already
  fixed elsewhere?" and "blocked prerequisites?" were dropped, the latter
  because it's redundant with Step 5's own "Blocked detection." Surviving
  assumptions get written into the refined ticket's Overview, explicitly
  labeled as assumptions.
- **verifier-agent** (`.claude/agents/verifier-agent.md`) — an
  independent pass over the definition-of-ready checklist (see below); not
  the same reasoning that produced the ticket rubber-stamping itself. On a
  passing run, also mechanically computes and reports a `size_trajectory`
  score (see "Shadow-mode size telemetry" below) — this is a separate
  reporting duty, not a tenth checklist item; items 4 and 8 below are
  unchanged by it.

### Definition-of-ready checklist

Enforced by `verifier-agent`, checked in order — first failure is the
bounce: (0) template sections populated (the full Overview/AC/Scope now
lives in the GitHub Issue's `## ✅ research-loop - <short context>`
comment, not Jira, per "Jira/GitHub content routing (Phase 1)" below —
the Jira comment is just its pointer), (1) every AC testable, (2)
files/modules named, (3) TDD-ready
test expectations per AC, (4) size per Step 4's criteria A/B (after
Ground, against `size-context.json`; AC count is never evidence), (5) no open
questions, (6) a literal-minded Sonnet-tier implementer could act on it
without inferring anything, (7) no raw secret/credential/token/password
value anywhere in the draft (presence/shape only — see Ticket content
protocol), (8) AC shape, (9) attachment coverage (every fetched attachment
in `attachment_coverage`, every mockup item an AC or a named out-of-scope
line, no blanket "spec wins" clause). Item 7 also has a code-level backstop: a `PreToolUse` hook
(`.claude/hooks/block-secret-comments.sh`) denies any Jira/Confluence write
whose content matches a known secret name or format pattern before it
reaches the real API — see `CHANGELOG.md`'s "Round 2" entry. Phase 1 added
a mirror-image hook, `.claude/hooks/block-github-secret-writes.sh`, denying
the equivalent `gh issue create`/`edit`/`comment` shape, since working
content now flows to GitHub too (see "Jira/GitHub content routing (Phase
1)" below). Neither hook is a replacement for this checklist item, just a
heuristic backstop behind it.

### Shadow-mode size telemetry

Every passing run logs a `size_trajectory` — `step4_tshirt` (S/M/L/XL,
Step 4's own qualitative read), `delta` (`grew`/`shrank`/`unchanged`
across this run's self-heal/re-pickup cycles), and `final_score` (a
mechanically computed, clamped-to-`[0,10]` number `verifier-agent`
derives from parent-AC count, files touched, subsystems touched, and
self-heal growth) — into `verdict.json` and, from there, `runs.jsonl` (see
`docs/logging.md`). **This is pure telemetry: nothing reads or acts on
it.** The Definition-of-ready checklist's items 4 (size bound) and 8 (AC
shape / ~10-AC advisory) are completely unchanged — no new checklist item,
no new bounce category, no new gate. The point is to accumulate real-run
history before deciding whether this score should eventually replace
items 4/8, or gate a cross-run growth cap — see
`docs/future-enhancements.md`'s size-score entry for everything that was
deliberately deferred out of this change, and why.

Since bounce criteria v2 (2.3.0) the AC-count advisory is gone: item 8 is
shape only, and too_large is decided by Step 4's criteria (below).

`src/verdict.ts`'s `parseSizeTrajectory` validates this field completely
independently of the rest of `Verdict` — a malformed `size_trajectory`
is dropped (never persisted) and can never flip a verdict's `outcome` to
`"error"`.

### Size and attachments (bounce criteria v2)

Design: `docs/superpowers/specs/2026-11-20-bounce-criteria-v2-design.md`.

- **too_large** only after Ground, and only for (A) two or more separately
  mergeable deliverables, with a drafted split, or (B) a real risk to the
  dev limits, judged against `size-context.json`, naming comparison
  tickets and risk factors (new infrastructure, async/stateful UI, more
  than one service, about 21+ files). AC count alone is never evidence. A
  design choice inside one deliverable is `spec_ambiguous`; a person's
  scope ruling is final.
- **Attachments become ACs.** Research inventories each design attachment
  (a new component: everything plus layout; a change: the delta against
  today's UI; styling: one line plus a QA note), maps each item to an AC or
  an `Out of scope: X (shown in the mockup)` line, and records the map in
  `attachment_coverage`. Unchosen mockup variants are `spec_ambiguous`.
  The verifier gets the attachments (item 9); qa-agent names the POC
  element for visual ACs.
- **Verdict fields:** `size_estimate` (every outcome), `ac_count`,
  `size_evidence` (required on too_large), `attachment_coverage` (required
  on ready when attachments were fetched).

### Loop checks on the research verdict

`src/roles/research/verdict-checks.ts`, run in `runResearchPhase` before
the loop acts. The agent judges; the loop checks the parts are there:

| Verdict | Fact checked | Result |
|---|---|---|
| bounced `too_large` | no `ground` `phase_end` in `progress.jsonl` | refused → `agent_error` (`verdict_check: too_large_ungrounded`) |
| bounced `too_large` | no valid `size_evidence` (A: split of 2+; B: comparison tickets + risk factors) | refused → `agent_error` (`too_large_no_evidence`) |
| `ready` | `attachments.json` has a skipped/failed entry or a listing `error` | loop bounces `blocked` with a Jira comment naming the files (`attachment_unreadable`) |
| `ready` | a fetched attachment missing from `attachment_coverage` | warned and accepted for the first `roles.research.attachmentCoverageWarnRuns` (default 5) such runs (`coverage_warned`), then refused (`coverage_missing`) |

A refused verdict makes no Jira write and counts as a failed attempt, so
the ticket runs again. Every other verdict passes untouched.

### Ticket content protocol

`ticket-refine` **never writes to the Jira description field.** The
stakeholder's original description is permanent and untouched — tickets
are authored by many different people in many different styles, and
normalizing someone else's ticket into our house format is bad practice
regardless of how good the result is.

Before Phase 1, all refined output — the normalized Overview/AC/Scope,
grounding evidence, surviving assumptions — went into one Jira comment,
written once on a passing verdict, titled exactly `Refined Spec — ready
for ticket-to-pr`, which `dev-loop`'s `ticket-to-pr` read as its work
order. Phase 1 splits that single comment across Jira and a mirror GitHub
Issue — see "Jira/GitHub content routing (Phase 1)" immediately below for
the current rule. A later, undated change (see `CHANGELOG.md`) replaced
that fixed title, both outcomes, with `{✅|❌} research-loop - <short
context>`, and replaced the pointer's section-manifest line with a clean
`[GitHub Issue](<url>)` link — `ticket-to-pr` keeps reading the Jira
comment as its work order until dev-loop migrates in Phase 2 (see
dev-loop's `docs/skills.md`); until then the Jira comment's link is what
a human clicks through to review the GitHub Issue's full content.

### Jira/GitHub content routing (Phase 1)

Per Phase 1 of `docs/future-enhancements.md`'s Jira label-trigger design,
`ticket-refine` now writes to two surfaces instead of one. **Jira gets only
four kinds of content** — a blocking ambiguity needing a human product
decision (`spec_ambiguous`), a scope call (`too_large` and its drafted
split), an explicit confirmation request, and the passing-verdict pointer
comment — **everything else goes to the GitHub Issue**: recon findings,
devil's-advocate attack findings, verifier results, working/interpretation
notes, and bounce evidence detail not itself one of the four Jira-worthy
kinds. Phase 1 introduced a requirement that every Jira comment under this
rule @-mention a configured Jira accountId; a later change (see
`CHANGELOG.md`) dropped that requirement as excessive in practice, and
the now-unused `jira.mentionAccountId` config field was removed outright
(see `CHANGELOG.md`'s most recent entry) rather than left dead.
See `SKILL.md`'s "Ticket content protocol" for the full routing rule
(items 1-8) and Step 0.5 for how the GitHub Issue is found/renamed each
run.

**Design decision (Task 4): GitHub Issue creation is loop-runner-owned, not
skill-owned.** `src/main.ts` creates or finds the mirror Issue (via
`GitHubClient.findIssueByJiraKey`/`createIssue`) immediately after claiming
a ticket, *before* spawning `ticket-refine` — not inside the skill itself.
This keeps the idempotency check (does an Issue for this Jira key already
exist) in TypeScript, backed by `test/github-client.test.ts`'s TDD suite,
rather than re-implemented as prompt instructions the skill would have to
get right on every run. `ticket-refine`'s Step 0.5 only looks up and
renames the Issue `main.ts` already created — it never creates one itself.
A GitHub Issue creation failure in `main.ts` never blocks the actual
`ticket-refine` run (same never-throw contract as every other I/O boundary
in `runSkill`); the skill proceeds without a mirror Issue for that run,
noting it once in `progress.jsonl`, and a later run's idempotency check
will retry.

### Model policy

`ticket-refine` itself runs on `--model sonnet` (pinned explicitly in the
invocation command — not an ambient default). It originally ran on Opus,
reserved in intent for this skill's own judgment calls (Interpret,
synthesizing Attack's findings, Scope, Synthesize) — but a single
continuous `claude -p` session bills *every* turn at one model tier, not
just the turns that need deep reasoning, so Triage/Ground bookkeeping/every
intermediate turn paid Opus pricing too. That drove real cost without a way
to scope Opus to just the four steps short of a larger re-architecture
(splitting into a Sonnet-tier orchestrator that calls out to Opus only for
specific steps). Switched to Sonnet for the whole session as the simpler
fix — revisit (either back to Opus, or the split-orchestrator design) if
bounce/synthesis judgment quality visibly degrades on real tickets. Every
subagent it spawns (`recon-agent`, `devils-advocate-agent`, `verifier-agent`)
pins `model: sonnet` in its own frontmatter regardless of the parent's tier.

### verdict.json contract

Every skill run writes `RUN_DIR/verdict.json` (schema in the SKILL.md file
itself). The loop runner (`src/loop-runner.ts`) reads it via
`parseVerdict()` in `src/verdict.ts` — a missing or malformed file becomes
`outcome: "error"`, `failure_category: "agent_error"`, never a crash.

**Closed `failure_category` enum** — do not add or remove values without
updating the pipeline spec: `spec_ambiguous · spec_contradicted · blocked ·
too_large · tests_flaky · env_setup · verify_rejected · subagent_stall ·
merge_conflict · agent_error · killed_ceiling · sandbox_denied`. This skill only ever
self-reports `spec_ambiguous`, `spec_contradicted`, `too_large`, or
`blocked`.

## Dev phase

### ticket-to-pr

`.claude/skills/ticket-to-pr/SKILL.md` — the executor. Invoked by the loop
runner as `claude -p "/ticket-to-pr <TICKET-KEY>"`. Runs a fixed phase
sequence against an isolated per-run `git worktree`, on its own branch,
branched off `targetRepo.path` (a local checkout, if configured — its
`origin` is already the real remote, so push/PR need no extra setup) or a
shared fetch-only clone at `.pipeline/<slug>/repo` otherwise (see
`docs/logging.md`) — never that source checkout directly, so a human
working in it manually is never affected by a background run:

1. **Intake** — find the research-loop comment (title starts with `✅
   research-loop -`, per research-loop's own comment convention) and
   confirm it has the template sections populated; bounce immediately if
   the comment is missing or malformed.
2. **Plan** — break the research-loop comment's acceptance criteria into
   concrete steps; bounce on any AC that requires inference it doesn't
   state.
3. **Red** — write a failing test per AC, confirm it fails for the right
   reason, commit tests before any implementation.
4. **Green** — implement the minimum change to pass, touching only the
   files the ticket's Scope section names.
5. **Verify** — full suite must be green, except for failures that also
   fail identically on the unmodified base branch: those are re-run on a
   throwaway baseline worktree, named in the PR's `## Pre-existing failures`
   section and `verdict.json`'s `preexisting_failures`, and do not block the
   PR (Ruling 29). A failure only on the branch is still a defect. Also runs whatever the target
   repo's own CI runs beyond tests (lint, typecheck, build) so a
   lint/build failure is caught here, not after the PR is already open;
   spawns `qa-agent` (see below) for a fresh-context adversarial pass, up
   to 3 retry loops.
6. **PR** — Phase 4 finishes all reasoning (title, `## Changes` bullets,
   `qa_notes`); Phase 5 is then mechanical: it reads the operator's local
   `~/.claude/skills/push-branch/SKILL.md` and follows it in its
   *content supplied* mode with `--no-jira`, so the push (hooks on), the
   create-or-edit-existing-PR step, and the body shape
   (`## Jira Ticket` / `## Changes` / `## QA Notes` manual steps) live in
   one place. That skill is **machine-local, not in this repo** and is the single
   source of truth for both manual and loop use; if it is missing, Phase 5
   bounces `env_setup` rather than carrying its own copy. Writes
   `verdict.json`.

**Resume, not restart.** If a `<TICKET>-*` branch already has commits ahead
of the default branch (e.g. from an earlier `verify_rejected` bounce), the
run creates its worktree *on that branch* instead of a fresh one, merges the
default branch in, plans only the work the newest spec still needs, and gets
a fresh 3-loop verify budget. Ambiguous cases (several candidate branches,
local/remote divergence) bounce `env_setup` rather than guess. A bounce never
pushes, and its `detail` must say whether the branch is on `origin`
(`git ls-remote`), never just "pushed". See the skill's "Resume" section.

Core rule: this skill **never edits the spec**. Any ambiguity, contradiction,
or oversized scope is `research-loop`'s problem to fix upstream — this skill
bounces with evidence instead of guessing.

**A bounce's evidence reaches the ticket itself, not just runs.jsonl.**
`ticket-to-pr` has no Jira-write tool of its own (see "Model policy" below,
and `ALLOWED_TOOLS` in `src/main.ts`) — it only writes `verdict.detail`
into `verdict.json`. The loop runner (`runLoopIteration` in
`src/roles/dev/phase.ts`) is what turns a genuine bounce (`verdict.pr === null`)
into a Jira comment, via `buildBounceCommentAdf()` + `JiraClient.addComment`,
posted immediately before the existing Blocked transition. Before this
existed, a bounce's only trace was the local `runs/<project>.jsonl` line —
the ticket itself went Blocked with nothing explaining why, which is exactly
what made TARS-1441/TARS-1438 look opaque on 2026-09-14 (see CHANGELOG).

**Ticket content protocol**: the ticket's description is the stakeholder's
original, untouched by `research-loop`, and is background context only —
never authoritative for AC/Scope. The research-loop comment (title starts
with `✅ research-loop -`) is the actual work order (see research-loop's
`docs/skills.md` for why it lives in a comment instead of the
description).

**Cleanup is a hard gate, every run**: stop the dev server if one was
started (by this skill or by `qa-agent`), and remove this run's worktree —
with one exception. If the run **landed** or **bounced with everything
already committed**, the worktree is removed unconditionally. If the run
**bounces with uncommitted in-progress work** still in the working tree,
the worktree is deliberately **kept** (and the bounce detail says so) so a
human or `ticket-refine`'s revision pass can inspect exactly what was
tried. That single case is the only conditional part of Cleanup — dev
server shutdown is never conditional.

### qa-agent

`.claude/agents/qa-agent.md` — a genuinely fresh-context subagent spawned
during Verify. It sees only the ticket key, the path to `ticket-to-pr`'s
already-created run worktree, and the dev-loop checkout path (to run
`src/roles/dev/qa-browser.ts`; never echoed into PR/Jira) — never the implementer's reasoning — and
checks, against the research-loop comment's AC/Scope (not the description):
AC satisfaction, scope discipline (no files touched beyond what Scope
names), regressions, test quality, and unrelated diff noise. Not
limited to static diff reading: for ACs that are visual, timing-sensitive,
or otherwise hard to trust from a diff and its tests alone, it starts the
app and exercises the behavior directly — and if it does, stopping it is
its own hard gate, independent of `ticket-to-pr`'s end-of-run Cleanup (it
started it, it stops it).

Browser checks go through one pinned helper, `src/roles/dev/qa-browser.ts` (Playwright
is a devDependency of dev-loop; a human runs `npm run setup-qa` once to fetch
the matching Chromium). It is localhost-only, and the agent is forbidden from
installing or downloading anything mid-run: if the browser is unavailable the
criterion is reported **unverified**, not worked around.

**Auth is deliberately not handled.** Local dev at `localhost:3000` shows a
login form (webtarsthree's client gate is a token in `localStorage`; the real
login uses the employee auth service). The qa-agent must not forge tokens or
use credentials, so UI behind the login is reported **unverified (needs
human)** for a person to check. See CHANGELOG 2026-09-30 for how earlier runs
got past it and why that stopped.

The qa-agent never manages the worktree itself — that lifecycle belongs to
`ticket-to-pr`. Returns `pass`/`fail` plus concrete findings the implementer
can act on.

### Model policy

`ticket-to-pr` runs on `--model sonnet` (pinned explicitly in the invocation
command, not an ambient default) — it's the literal-minded executor tier per
the spec, never the tier that questions the spec. `qa-agent` pins `model:
sonnet` in its own frontmatter too, so it doesn't inherit a different model
from whatever spawned it.

### verdict.json contract

Every skill run writes `RUN_DIR/verdict.json` (schema in the SKILL.md file
itself). The loop runner (`src/roles/dev/phase.ts`) reads it via
`parseVerdict()` in `src/core/verdict.ts` — a missing or malformed file becomes
`outcome: "error"`, `failure_category: "agent_error"`, never a crash. The
loop runner derives the real `RunLogLine` (adding ticket/skill/timing
metadata the skill doesn't need to self-report) from this verdict — it no
longer derives any epic-or-label-move decision from the verdict at all
(`decideEpicMove` was deleted; no loop moves anything epic-or-label-shaped
on a landed dev-loop verdict).

**`ready_to_push` (dev only).** When the loop passes `push=host` (a sandbox
that can't sign commits), `ticket-to-pr` stops at Phase 5 with
`outcome: "ready_to_push"`, `pr: null`, and flat `branch`, `pr_title`,
`pr_body` fields (required for this outcome; `pr_title` is at most 200
characters with no `"`, backtick, `$`, `\` or newline). It does not push or rename the
branch; the loop re-signs the unpushed commits as the operator and runs
`push-branch` on the host. On a run without `push=host` this outcome is an
`agent_error`.

**Closed `failure_category` enum** — do not add or remove values without
updating the pipeline spec: `spec_ambiguous · spec_contradicted · blocked ·
too_large · tests_flaky · env_setup · verify_rejected · subagent_stall ·
merge_conflict · agent_error · killed_ceiling · sandbox_denied`.

**`qa_notes` (optional `string[]`)** — sequential manual-testing steps for
a human QA reviewer (real routes/URLs, one action + one `Expected:` result
per Acceptance Criterion), written by `ticket-to-pr` in Phase 4 (see
SKILL.md). The loop runner's `buildQaNotesAdf()` renders this into Jira's
QA Notes field (`codeReviewFields.qaNotesField`) as a bold "Manual testing
steps:" header + ordered list, with `Expected:` entries bold-marked —
falling back to a terse `PR: <url>` / `Verify loops: N` stub when absent
or empty. The PR body's `## QA Notes` section carries this same list (numbered,
matching `push-branch`'s format); the earlier pass/fail summary was removed
from the PR and lives only in `verdict.json` / `progress.jsonl`.
When `qa-agent` reports an AC as **unverified (needs human)** (e.g. UI behind
the login), that AC's first `qa_notes` entry is prefixed
`[Not verified by automation] ` so it survives into Jira and the PR.
