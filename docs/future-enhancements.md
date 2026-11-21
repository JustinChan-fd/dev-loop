# Future Enhancements

> Merged in dev-loop 2.0.0: one repo, two phases. `## Research phase` is the
> former research-loop doc (`--phase=research`); `## Dev phase` is the former
> dev-loop doc (`--phase=dev`). Wording inside each section still describes its
> repo as it was; "this repo" / "the sibling repo" there means that phase, and
> paths like `src/types.ts` map to `src/core/` and `src/roles/<phase>/` now.
> See `docs/migration-ledger.md`.

## Research phase

Ideas for the pipeline itself (not tickets it processes) that are worth
doing but not yet drafted into a change. Unlike `CHANGELOG.md` (landed
fixes), this is a holding pen — write down the idea and the evidence that
motivated it, then leave it for later. When one of these actually gets
implemented, move its entry to `CHANGELOG.md` and delete it from here.

### Concurrent loop instances against the *same* project (N-per-project)

**Idea**: today, `--project=<name>` (see `CHANGELOG.md`, 2026-09-16) makes
it safe to run one loop instance per project concurrently, in as many
terminals as there are projects — each instance's on-disk state is
namespaced by `repoSlugFromUrl()` and each polls its own project's JQL.
What's still unsolved is running **more than one instance against the
same project** at once (e.g. two `--project=webtarsthree` terminals side
by side, to work through a backlog faster). This needs real coordination:
research-loop's `claim()` is already atomic (a status transition, race-
safe — a second instance's claim attempt on an already-claimed ticket
just returns `false`), so it may already be closer to N-safe than
dev-loop is; dev-loop's `loopKind: "dev"` poll has **no atomic claim step
at all** (see dev-loop's own `docs/config.md`, "Ticket status never
reverts" → "Future: multiple concurrent loop instances") — it goes
straight from poll to running the skill, and explicitly assumes exactly
one instance per project.

**Why**: the user's actual goal is "N loops per project," not just "one
loop per project" — `--project` closes the gap between zero-projects-
concurrent and one-per-project, but doesn't reach N-per-project. Worth
tracking as its own enhancement rather than assuming `--project` already
solved it.

**Not yet scoped**: whether research-loop's existing atomic claim is
actually sufficient for N-per-project as-is (needs verification, not just
assumed from "it's atomic"), or what dev-loop's own coordination
mechanism would need to look like (a per-instance label, an assignee-scoped
JQL clause, or something else) — dev-loop's own doc already sketches "a
per-instance label (e.g. `Runner1`/`Dev1`, incrementing per instance)
checked and set at pickup time" as one option, not yet designed in detail.

### Cheap-tier gate for test-only tickets (Step 0, ticket-refine)

**Idea**: add a triage-time check in `ticket-refine`'s Step 0 (Triage &
route) that recognizes a narrow ticket class — new test coverage only,
zero application-code changes, no new runtime behavior — and runs a
lighter pipeline for it: skip or shrink Attack's empirical
build-and-run-a-scratch-test step, and rely on Verify's static check
instead. Everything else (Ground's currency check, Synthesize, Verify)
stays as-is; this is scoped to the one most expensive step for the one
lowest-risk ticket class.

**Why**: on `TARS-1284` (add ~8 new tests to one new file, no changes to
`FormReviews.jsx` itself), the full run took ~47 minutes wall-clock. Of
that, Attack alone took ~13 minutes because `devils-advocate-agent`
built and ran a real scratch integration test to verify a test-file
mocking pattern. That's the right level of scrutiny for a ticket that
could break production behavior — but this ticket touched no production
code at all, so the blast radius of being slightly wrong is much smaller
than what Attack's cost is calibrated for. See `progress.jsonl` in
`.pipeline/webtarsthree/runs/TARS-1284-20260827T225552Z/` for the phase
timestamps this estimate is based on.

**Not yet scoped**: exact detection rule for "test-only ticket" (likely:
Scope's own files-to-touch enumeration, checked *before* Attack rather
than after); how much to shrink Attack (skip entirely vs. drop just the
empirical-build sub-step); whether this should be a new Step 0 branch or
a flag Ground/Attack read.

### `claim()` doesn't send a claim-transition's required screen fields

**Idea**: `RealJiraClient.claim` (`src/jira-client.ts:216`) transitions a
ticket via whatever transition leads to `claimStatus.to`, but only ever
sends `{ transition: { id } }` — no `fields`. If that transition's screen
has a field Jira enforces as required at submit time, the claim call
throws and the whole loop iteration dies uncaught (see the `main.ts:480`
stack trace from the fatal-error run below), rather than being treated as
a per-ticket skip/bounce the way a lost claim race already is.

**Why**: hit live on `TARS-1460` (a real smoke-test ticket for the Phase 0
label-trigger change) — its `claimStatus` transition in TARS's workflow is
"Start Development" (id `421`, `To Do` → `In Progress`), whose screen has
a `Story Points` (`customfield_10002`) field. `getTransitionsForJiraIssue`
reports that field as `required: false` in its own metadata, but the live
`POST .../transitions` call rejected the same transition with `400 Bad
Request: "Field 'Story Points is required.'"`. Same *class* of bug as the
undocumented parent-Epic requirement already known for Bug/Story/Tech
Story create calls (`configs/TARS.json` in the sibling `skills` repo's
`jira-create-ticket`) — Jira's create/transition metadata under-reporting
a real requirement — just hitting a different operation (claim/transition
in research-loop itself, not issue creation in `jira-create-ticket`).
Worked around for this one ticket by setting Story Points directly via
`editJiraIssue` before retrying the loop; not yet fixed in `claim()`.

**Not yet scoped**: whether to have `claim()` fetch the target
transition's screen fields (same call shape as `getTransitionsForJiraIssue`
already returns) and supply a configured default for any it finds
required, or something narrower (e.g. a config-level "extra transition
fields" map per project, since "what value" has no universal right
answer — Story Points has no meaningful default for a research-loop-only
ticket). Also unscoped: whether a claim failure of this shape should
become a new terminal outcome (distinct from today's clean lost-race
`false` return) or whether the loop runner should catch it and treat it
as `outcome: "error"` for that iteration rather than crashing the whole
process — right now it's an uncaught throw all the way out of `main`.

### Jira label-based trigger (both repos) + split Jira (PM) / GitHub Issues (research & dev)

**Idea**: replace Jira's epic-parent trigger with a Jira label-based
trigger, in both research-loop and dev-loop together (uniform across
project types, no more `epicLinkField` per-project variance, and no gap
where dev-loop stops being triggered). Then, once that's solid, split what
Jira carries from what GitHub Issues carries: Jira becomes pure PM
surface — clean ticket, a handful of templated must-know comments (always
@-mentioning the assignee), status/label only. All trigger logic and
heavy dev/research commentary move to a GitHub Issue that mirrors the
Jira ticket 1:1, using the *same* label vocabulary on both systems.

**Why**: today's fixed-title-comment convention (`Refined Spec — ready for
ticket-to-pr`, `Ticket-Refine Bounce — <category>`, both in
`.claude/skills/ticket-refine/SKILL.md`) hasn't kept Jira clean — Jira is
cluttered despite it existing, because there's no enforcement and no
routing rule separating product-level content from engineering-in-the-
weeds content. Separately, `Config.jira.epicLinkField`'s per-project-type
variance (`"parent"` for team-managed projects, a
`customfield_XXXXX` for company-managed ones, per `docs/config.md`) is a
real onboarding cost a label-based trigger removes outright, in both
repos — directly relevant to onboarding `catalog-ui-management` and
`catalog-ui-public` next. GitHub Issues is a more natural home for
dev-shaped conversation (markdown, code refs, multi-label state,
closes-via-PR) and becomes queryable "second brain" infrastructure
dev-loop can eventually read from directly.

**Label taxonomy** (shared stage vocabulary across Jira and GitHub; status
vocabulary scoped *per stage*, not one flat shared list — a two-pass
correction, see below):
- **Stage** (mutually exclusive, one at a time — mirrors today's two
  epics, and now also doubles as each repo's poll trigger):
  `pipeline:research` (research-loop's poll target), `pipeline:dev`
  (dev-loop's poll target, replacing `readyEpic` membership),
  `pipeline:merged` (terminal — reached only via the reconciliation pass
  below, never at PR-open time).
- **Status** (independent of stage, can co-occur with the current stage —
  fixes a documented Jira limitation: `docs/config.md` notes today "still
  being refined" and "refined, awaiting approval" look identical on the
  board since both share one epic). Scoped into two separate pools rather
  than one shared list, since research-loop's and dev-loop's statuses
  describe genuinely different situations:
  - Research-loop statuses (valid only while stage is `pipeline:research`):
    `pipeline:blocked`, `pipeline:bounced`, `pipeline:needs-product-input`.
  - Dev-loop statuses (valid only while stage is `pipeline:dev`):
    `pipeline:pr-open`, plus whatever else dev-loop's own bounce/blocked
    states need (deferred — see below).
  - Both pools stay in the same flat `pipeline:*` namespace (no new
    prefix) — a GitHub Issues list view still reads as exactly two badges
    per row, stage + status, that always make sense together.
- **An open PR is not, by itself, grounds for `pipeline:merged`**: stage
  stays `pipeline:dev` for the life of an open PR; only the status label
  changes, to `pipeline:pr-open`, applied at the existing PR-open moment
  (today's `statusNames.prOpen` Jira transition — no new trigger, just
  also labels it). `pipeline:merged` is reached *only* by dev-loop's
  startup reconciliation pass (below) confirming a real merge via
  `gh pr view --json state,mergedAt` — never inferred from anything short
  of a confirmed merge. This makes "PR open, not yet merged" a real,
  visible state instead of being indistinguishable from either
  `pipeline:dev` (not started) or `pipeline:merged` (actually done).
- Stage-label swap points are tied to transitions that already exist
  today: `pipeline:research` applied at claim (today's atomic status
  transition); swapped to `pipeline:dev` at the point the epic would move
  to `readyEpic` today — this swap is now the actual trigger dev-loop
  polls for; swapped to `pipeline:merged` only via the reconciliation
  pass, clearing `pipeline:pr-open` at the same moment.
- **Who performs the `pipeline:research`→`pipeline:dev` swap is an exact
  1:1 carry-over of today's `Config.autoPromoteLabel` semantics**
  (`src/loop-runner.ts:178`) — a distinct, unrelated mechanism, not to be
  conflated with the new stage/status labels. Default: research-loop
  never swaps the label itself on a passing verdict — the ticket sits at
  `pipeline:research` until the user manually swaps it to `pipeline:dev`,
  after reviewing both the Jira ticket and the mirrored GitHub Issue.
  Only when `autoPromoteLabel` is present on the ticket does research-loop
  perform the swap automatically — identical to today's "move the epic
  automatically" behavior, just acting on a label instead of an epic. This
  preserves the human-in-the-middle default for two reasons: dev-loop is a
  separate local process that still has to be started by hand regardless
  of label state, and the option to read GitHub-mirrored comments before
  signing off only holds if the label swap itself defaults to manual.

**Routing rule** (Jira vs. GitHub content split):
- Jira-worthy, and *only* these: a blocking ambiguity needing a human
  product decision, a scope call, an explicit confirmation request, or a
  passing-verdict pointer. No per-comment judgment call beyond this list.
- GitHub-only: recon findings, devil's-advocate attack findings, verifier
  results, working/interpretation notes, bounce evidence detail — anything
  in-the-weeds/engineering-shaped. Still concise, allowed to be technical.
- Any comment that does reach Jira must @-mention the assignee — a new
  requirement, no such convention exists today. Needs a config field for
  who to mention, sourced the same way `JIRA_ASSIGNEE_ACCOUNT_ID`/
  `assigneeAccountIdFromEnv` already works in `src/jira-client.ts`, not a
  new secret-shaped env var.

**Proposed model**:
- Jira: ticket stays put; comments trimmed to the routing rule above. The
  existing fixed-title convention is kept but its content shrinks to a
  short pointer once dev-loop migrates ("see GitHub issue #123 for full
  evidence") plus an @-mention. Ticket *status* transitions (`claimStatus`,
  `statusNames.bounced/prOpen`) are untouched by this proposal.
- GitHub Issues: one Issue per Jira ticket, created early (sketch: during
  `ticket-refine`'s existing Step 0/intake, right after claim — exact step
  needs its own design pass). Title convention: `<JIRA-KEY>: <ticket
  summary>`. Body mirrors the Jira ticket's must-know fields at creation
  time; recon/attack/verify/working content posted as comments per the
  routing rule. Cross-link is a plain URL in a comment on both sides — the
  Atlassian MCP toolset has no structured remote-link-creation tool
  (`createIssueLink` only links two Jira issues to each other;
  `getJiraIssueRemoteIssueLinks` is read-only), so this is a real tooling
  constraint, not an oversight.
- Per-project config: each project already has its own
  `pipeline.<project>.config.json`; adding a `github.repo` field per
  project file is how `catalog-ui-management` and `catalog-ui-public` each
  get their own target repo — no new mapping structure needed. Sketch
  (research-loop's config; dev-loop's mirrors it with `pipeline:dev` as
  its own `triggerLabel`):
  ```json
  "jira": {
    "triggerLabel": "pipeline:research",
    "readyLabel": "pipeline:dev",
    "mentionAccountId": "<jira-account-id-for-@mentions>"
  },
  "github": {
    "repo": "org/repo",
    "stageLabels": { "research": "pipeline:research", "dev": "pipeline:dev", "merged": "pipeline:merged" },
    "researchStatusLabels": { "blocked": "pipeline:blocked", "bounced": "pipeline:bounced", "needsProductInput": "pipeline:needs-product-input" },
    "devStatusLabels": { "prOpen": "pipeline:pr-open" }
  }
  ```
  `researchStatusLabels`/`devStatusLabels` are two separate pools, not one
  flat `statusLabels` map, so a future reader doesn't have to guess which
  statuses are valid for which stage. Explicitly distinct from
  `autoPromoteLabel` — do not conflate.
- Code-level enforcement, two separate hooks in two separate phases: (a) a
  `PreToolUse` hook on `mcp__atlassian__addCommentToJiraIssue` that rejects
  a comment violating the routing rule (size, shape, missing @-mention) —
  only matters once Jira content is actually being trimmed; (b) a
  `PreToolUse` hook on the new GitHub write surface that hard-denies via
  `containsSecret()`/`redactSecrets()` (`src/core/redact.ts`, already wired into
  the existing Jira/Confluence hook) before any write reaches GitHub — a
  mandatory launch blocker, no fast-follow, since GitHub carries real
  ticket/codebase content from day one it's introduced. Both modeled on
  dev-loop's `.claude/hooks/block-secret-comments.sh` (fail-closed
  contract: stdin-only data handling, distinct non-1 exit codes so a crash
  isn't mistaken for a clean check) — the GitHub hook also needs
  dev-loop's `Bash`-command-text matching style (whole-word checks on `gh`,
  `pr`, `create|edit`) adapted, since `gh`/octokit calls aren't a named MCP
  tool the way Jira calls are.
- **Status sync on merge is a startup-time reconciliation pass, not a new
  poller, webhook, or process** — nothing else in this design actually
  performs the `pipeline:dev`→`pipeline:merged` swap or the GitHub Issue
  close; GitHub's `Closes #<issue>` convention auto-closes the Issue on
  merge (real, native behavior), but nothing relabels it and nothing on
  the Jira side reacts to a GitHub merge event at all. Fix: dev-loop, at
  the top of its existing loop iteration (before each poll cycle, not a
  separately-scheduled job), runs a small reconcile step — its own
  lightweight, cheap-tier-model skill the main loop agent invokes, since
  this is a bounded mechanical check, not reasoning-heavy work — that
  finds tickets/Issues at stage `pipeline:dev` with status
  `pipeline:pr-open`, checks each one's real merge state via `gh pr view
  <n> --json state,mergedAt` (dev-loop already shells out to `gh` for PR
  creation — no new tool, no new credential), and for any that merged
  since the last cycle: swaps stage to `pipeline:merged` on both Jira and
  the GitHub Issue (clearing `pipeline:pr-open`), and explicitly closes
  the GitHub Issue (needed because a merge that happened while dev-loop
  was offline can't assume the auto-close already ran). This mirrors the
  pattern of reconciling state at a natural checkpoint rather than adding
  a continuously-running watcher — no GitHub Actions workflow, no
  standalone cron job. Needs its own idempotency guard: re-running it on a
  ticket already at `pipeline:merged` must be a safe no-op, not a
  duplicate swap or a re-close error on an already-closed Issue.

**Phased rollout** — three phases, not combined into one change:
- **Phase 0 (Jira-only, both repos, no GitHub involved yet) — DONE, see
  CHANGELOG.md.** Replaced epic-parent polling with label polling in both
  research-loop and dev-loop together — research-loop's `src/jql.ts`
  templates changed from `parent in ({epics})` to a `pipeline:research`
  label match; dev-loop's poll JQL changed from `parent = {epic} AND
  status = "In Progress"` to a `pipeline:dev` label match. Without this,
  once research-loop's approval step stopped moving the epic, dev-loop's
  existing trigger would never fire again — there's no "later" for
  dev-loop's trigger, so both repos moved together. The claim step was
  unchanged; the "approval" step (previously: move epic to `readyEpic`,
  gated by `autoPromoteLabel`) became the `pipeline:research`→
  `pipeline:dev` label swap, governed by the exact same manual-default/
  `autoPromoteLabel`-gated-automatic rule, and that swap is now the real
  handoff mechanism between the two repos. TDD'd in both repos; epics
  remain in Jira for board/PM use only, read by neither loop.
- **Phase 1 (research-loop creates/mirrors GitHub, dual-write) — DONE, see
  CHANGELOG.md.** Jira keeps getting the full `Refined Spec` comment
  unchanged — dev-loop keeps reading it as its work order, untouched (only
  its trigger changed in phase 0). research-loop also creates/mirrors the
  GitHub Issue and posts full recon/attack/verify detail there per the
  routing rule. The GitHub secret-redaction hook landed as a prerequisite
  gate before any of this content shipped, per the plan. dev-loop's
  startup-time merge-reconciliation pass (once a GitHub Issue exists per
  ticket, moving both a Jira label and a GitHub Issue to
  `pipeline:merged`) did not land in this phase and remains open — see
  below.
- **Phase 2 (Jira decluttered — dev-loop migrated)**: once dev-loop's
  `ticket-to-pr` is changed to read its work order from the GitHub Issue
  instead of the Jira comment, the Jira `Refined Spec` comment shrinks to
  a pointer + @-mention, and the Jira-comment-shape hook goes live. This
  is the point Jira actually becomes clean. Requires its own dev-loop-side
  design/sign-off round — a bigger, riskier change than phase 0's
  mechanical trigger swap, correctly deferred.

**Architecture touchpoints**: `src/jql.ts`, `src/loop-runner.ts`,
`docs/config.md`'s `epicLinkField` section (research-loop) and dev-loop's
equivalent poll-JQL/config files — phase 0's actual replacement surface,
in both repos. `src/types.ts` `Config` needs a new `github` block plus
`jira.triggerLabel`/`readyLabel`/`mentionAccountId`. `JiraClient`'s
injected-interface shape is worth mirroring for a new `GitHubClient`;
`test/jira-client.test.ts`'s `vi.stubGlobal("fetch", fetchMock)` pattern
is the concrete TDD starting point, per CLAUDE.md's "TDD, strictly, for
this repo's own code" rule. GitHub Issues has no atomic-claim primitive
the way a Jira status transition does — a label add is not race-safe —
but this only matters once something polls GitHub directly (dev-loop in
phase 2); flagged as its own design pass then. `.claude/skills/
ticket-refine/SKILL.md` is the only place that writes Jira comments today
and where the routing-rule/@-mention logic and label swaps get
implemented. GitHub Issue creation needs an idempotency check (does an
issue for this Jira key already exist) before creating, to avoid
duplicates from the same class of poll-loop race the `postRunDelaySec` fix
addressed. Cross-repo coordination today is "through Jira ticket state"
(per README.md) — phase 0 changes *how* that happens (label instead of
epic-move) but not *that* it happens through Jira; phase 2 is the first
design pressure to move the coordination substrate itself to GitHub.

**Not yet scoped / explicitly deferred**: PR lifecycle edge cases (PR
closed without merge — the reconciliation pass only handles
`merged=true`, so a closed-without-merge PR leaves a ticket stuck at
`pipeline:dev`/`pipeline:pr-open` indefinitely; PR replaced by a new one;
multiple branches mapping to the same Jira key/GitHub Issue); Jira
parent/child subtasks mapping to one vs. many GitHub Issues; GitHub's
concurrency-safe claim mechanism (needed once dev-loop polls GitHub
directly in phase 2); exact content/thresholds for the Jira-comment-shape
hook; whether dev-loop reads/writes the same Issue or gets its own linked
Issue in phase 2; whether dev-loop needs status labels of its own beyond
`pipeline:pr-open` (`devStatusLabels` in the config sketch above is
deliberately left open for this — dev-loop's `SKILL.md`/verdict
categories haven't been checked for a 1:1 fit); dev-loop's startup-time
merge-reconciliation pass itself (Phase 1's own description called for it,
but it targets dev-loop, not research-loop, and did not land as part of
this plan).

**Resolved by this plan** (design decisions the doc above had left open,
now settled): (a) GitHub Issue creation happens in `main.ts`'s composition
root, right after claim — not inside `ticket-refine`'s own Step 0/intake
turn — so the skill can assume the mirrored Issue already exists by the
time it runs; (b) the cross-link format is exactly the plain URL in a
comment on both sides already sketched above — no structured remote-link
tool was added, since none was needed beyond what the doc already
specified.

**2026-09-16 addendum: open question, not a decision — GitHub labels as a
machine-checkable bounce/status signal, separate-concerns label vocabulary**

**Status: nothing below is decided.** This addendum exists only because
this doc is where undecided pipeline ideas get written down before
they're designed — per this file's own header, it's "a holding pen," read
by no running code (confirmed: only `CHANGELOG.md`-landed phases are
cited from `.claude/skills/ticket-refine/SKILL.md`; this addendum is not).
Nothing here should be treated as scope, and nothing here should be
built without a separate, explicit go-ahead.

Two concrete motivations surfaced in conversation, refining the earlier
"not sure yet" answer:
- **Bounce/status legibility for agents.** If a ticket gets bounced, a
  label is something an agent can check with one cheap read (`labels
  contains X`); today that same information only lives in Jira comment
  text or a GitHub Issue comment thread, which requires reading and
  interpreting prose to recover a fact a label could carry directly. This
  is a real, specific gap — `ticket-refine`'s own bounce categories
  (`.claude/skills/ticket-refine/SKILL.md`'s `outcome: "bounced"` +
  category) exist today only as verdict.json fields and a Jira comment
  title convention (`Ticket-Refine Bounce — <category>`), not as anything
  label-shaped on either system.
- **Separation-of-concerns label vocabulary.** If the pipeline keeps Jira
  = project management and GitHub = code/dev (the split Phase 2 above
  already assumes for *content*), it may follow that each system's labels
  shouldn't need to mirror each other 1:1 either — Jira's labels could
  stay coarse/PM-shaped (stage only: `pipeline:research`/`pipeline:dev`),
  while GitHub's labels carry the finer-grained, dev-shaped state
  (bounce category, blocked reason, PR status) that only engineering
  needs to check. This is a different shape than the original entry's
  "same label vocabulary on both systems" sketch above — worth treating
  as a live alternative, not an amendment to that sketch, until one is
  actually chosen.

Separately, whether GitHub also becomes the *poll target* (which system
each loop actually queries for pickup) is a distinct, larger question
that was raised in conversation but not settled — it goes beyond what
Phase 2 above scoped (Phase 2 only moves work-order *content* to GitHub,
never proposed moving the *trigger*). The two ideas are related but not
the same: agents reading a bounce label off GitHub for legibility doesn't
by itself require GitHub to be the poll target — research-loop could
write a bounce-category label to the mirrored Issue for cheap
machine-checkability while still polling Jira for pickup, same as Phase 1
already writes rich content to GitHub without polling it. Both remain
open.

**What "GitHub as poll target" would actually require, beyond what's
built today** (kept for whichever direction is eventually chosen):
- Real GitHub read/poll logic in both loops. Today only research-loop
  *writes* to the mirrored Issue (Phase 1) — there is zero label-read or
  poll logic against GitHub anywhere in either repo. Confirmed live: the
  mirrored Issue for TARS-1462 (`fandango/webtarsthree#428`) has zero
  labels, and nothing in `GitHubClient`/`main.ts` in either repo ever
  writes one. Moving the poll target to GitHub is new build work in both
  repos, not a redirect of an existing call.
- An atomic claim mechanism on GitHub. Already flagged above under
  "Architecture touchpoints": "GitHub Issues has no atomic-claim primitive
  the way a Jira status transition does — a label add is not race-safe."
  research-loop's claim today is a Jira status transition specifically
  because it's atomic; polling GitHub doesn't remove the need for *some*
  atomic claim on pickup. This needs its own design — e.g. GitHub's issue
  `assignee` field as a claim primitive, or keeping claim on Jira while
  polling stage on GitHub (a split that reintroduces the same
  dual-source-of-truth race the "keep both `pipeline:*` labels on one
  ticket" idea was rejected for elsewhere in this session — two
  independently-writable signals for the same state is the failure mode
  to avoid, whichever system ends up authoritative).
- An actual cost comparison, not an assumption. The original entry above
  already named this as unscoped ("shift...work from Jira MCP tool calls
  to `gh` CLI calls...may have a meaningfully different cost profile —
  worth comparing before committing to a specific design"). No data has
  been gathered in either direction.

**Overengineering flag**: motivation is still "not sure" — the
atomic-claim gap and the missing read/poll logic above are real build
work in both repos, not polish, so this shouldn't be started on a hunch.
If cost turns out to be the deciding factor, that's cheap to measure
*before* any design work: compare a batch of real Jira MCP tool calls
against equivalent `gh` CLI calls for the same read (e.g. "is this ticket
still open, what labels does it carry") against a handful of real
tickets. That measurement can settle or kill the motivation question for
under an hour of work, well before committing to the atomic-claim design
above.

**Not yet scoped**: which loop(s) would poll GitHub (research-loop,
dev-loop, or both — today's design has each polling Jira independently);
whether `pollJql.{refine,dev}` gets replaced outright or kept as a Jira
fallback; what happens to `repoLabel`'s disambiguation role (today ANDed
into Jira JQL so a shared Jira project like MC doesn't leak
`catalog-ui-public` tickets into `catalog-ui-management`'s poll) if the
poll moves to GitHub, where the equivalent constraint is "which repo's
Issues" — likely trivial since Issues already live in the target repo,
but not verified; whether this conflicts with or subsumes the still-open
Phase 2 question of "whether dev-loop reads/writes the same Issue or gets
its own linked Issue."

**Conclusion (2026-09-16): not doing this now.** Checked what the
bounce/status-legibility motivation was actually asking for, against what
exists today:

- `failure_category` is already a closed 11-value enum
  (`src/types.ts:14-25`), not prose, and it already lands in two
  machine-readable places: every bounced `RunLogLine` in
  `runs/<project>.jsonl` (`loop-runner.ts:208` — structured JSON, not
  comment text), and a fixed, greppable Jira comment title convention
  (`Ticket-Refine Bounce — <failure_category>`, `SKILL.md:543`).
- GitHub itself can obviously do this (`gh issue edit --add-label`, `gh
  label create` — real, existing `gh` CLI commands). The gap is narrower
  than "GitHub can't do this": this repo's own `GitHubClient` interface
  (`src/github-client.ts`) has no method that calls them yet — only
  `createIssue`/`findIssueByJiraKey` exist today. Adding one would be a
  small, mechanical wrapper (same shape as the existing `createIssue`
  method), not new capability from GitHub's side — the actual cost isn't
  "can this be built," it's whether it's worth building for a value that
  already has two structured homes, one of which (`runs.jsonl`) is more
  granular than a label vocabulary would realistically be.
- A GitHub label only earns its cost if some consumer can reach the
  GitHub repo but *not* Jira comments or `runs.jsonl` — no such consumer
  exists today. dev-loop reads its work order from Jira (Phase 2), not
  from mirrored-Issue state.

Given that, adding either the bounce label or the GitHub-as-poll-target
change now is doing new build work (label-write call at minimum; real
read/poll logic and an atomic-claim redesign for the larger change) to
solve a problem that's already solved elsewhere. That's the
overengineering line named above.

**Reopen this if**: a concrete consumer shows up that can only see the
GitHub repo — e.g. a GitHub-only agent, a dev-loop change that stops
reading Jira comments, or an external tool integration that only has
`gh`/GitHub API access. At that point the bounce-label piece is cheap
(one `gh issue edit --add-label` call at bounce time, no new read/poll
infra) and can be scoped on its own, independent of the much larger
poll-target question, which stays open and unstarted regardless.

**Checkpoint (2026-09-16 evening): audit findings — what's actually left
of this whole entry.** Went back through this entry's own "DONE" claims
against real code in both repos (not just the doc's own labels) to answer
"are we actually done with this plan." Findings:

- **Phase 0 and Phase 1 — confirmed genuinely done.** Verified directly:
  no `epicLinkField`/`readyEpic`/epic references anywhere in either
  repo's `src/` or configs; the mirror Issue is created after claim
  (`main.ts:330,353,359`); the routing rule and mandatory @-mention are
  real instructions in `ticket-refine/SKILL.md:497-544`, not just design
  prose; the secret-redaction hooks exist and are wired in
  `.claude/settings.json`. `mentionAccountId` and `github.repo` are real
  fields in every `pipeline.*.config.json` today.
- **One Phase 1 gap, not previously flagged as outstanding**: the
  routing rule names *two* hooks — a secret-redaction hook (built) and a
  separate Jira-comment-*shape* hook enforcing the size/category routing
  rule itself (not built). Only the secret check exists; nothing rejects
  a comment that violates the Jira-vs-GitHub content split.
- **`stageLabels`/`researchStatusLabels`/`devStatusLabels`** (this
  entry's original config sketch) were never added to `Config` in either
  repo — abandoned, not merely unstarted, consistent with the pivot above
  toward "GitHub Issue as context doc" over label-mirroring. Decision
  still open: formally cut this part of the sketch, or leave it marked as
  a live alternative. Not resolved by this checkpoint.
- **Still genuinely open, confirmed by direct grep, not assumed**:
  - GitHub Issue close-on-merge — no `closeIssue` method anywhere in
    either repo, no `Closes #`/`resolves #` convention in
    `push-branch/SKILL.md`'s PR body template.
  - dev-loop's startup-time merge-reconciliation pass — zero
    `reconcil`/`mergedAt`/`gh pr view`/`pipeline:merged` hits in
    dev-loop's `src/`. dev-loop has **no `GitHubClient` at all** — this
    is new infrastructure, not a missing method on an existing class.
  - Phase 2 (dev-loop reading its work order from GitHub instead of the
    Jira comment) — correctly still deferred;
    `ticket-to-pr/SKILL.md:17-27,158-161` still hard-requires the Jira
    `Refined Spec` comment.
  - The other deferred edge cases listed above (PR closed without merge,
    PR replacement, multi-branch/subtask mapping, GitHub atomic claim) —
    all still untouched, zero code or design progress beyond this doc's
    own notes.
- **GitHub's close reason has three values, not two** — confirmed via the
  GitHub UI (`Close as completed` / `Close as not planned` / `Close as
  duplicate`), i.e. `state_reason: "completed" | "not_planned" |
  "duplicate"` on the API. Only `completed` is relevant to close-on-merge;
  `not_planned` is the more correct closure reason for the still-deferred
  "PR closed without merge" edge case (rather than leaving the Issue open
  indefinitely, its current unhandled state) — worth remembering when
  that edge case is eventually designed. `duplicate` isn't relevant to
  anything this pipeline produces.
- **dev-loop writes nothing to the GitHub Issue at all — confirmed, and
  confirmed research-loop's own side is correct.** Live symptom: the
  mirror Issue for TARS-1462
  (`github.com/fandango/webtarsthree/issues/428`) goes silent the moment
  dev-loop picks the ticket up — no bounce detail, no pass/fail info,
  nothing, for any outcome. Checked whether this was a dev-loop-only gap
  or a pipeline-wide one before concluding anything: **research-loop's
  own writes are correct and already verified**, not just designed —
  `SKILL.md:180` routes all GitHub-only content (recon, attack findings,
  working notes, bounce evidence detail) to the mirror Issue via `gh
  issue comment`; `SKILL.md:517-538` has a passing verdict write the full
  refined-spec content to the Issue with only a short pointer + @-mention
  left on Jira; `SKILL.md:554-569` has the Step 7 verifier actively check
  the Issue comment's content and fail a verdict missing it. The gap is
  specifically **dev-loop's side**: zero `GitHubClient`, zero `gh issue`
  calls anywhere in dev-loop's `src/` (re-confirmed by grep) — so once a
  ticket crosses to dev-loop, GitHub Issue context-tracking stops
  entirely, for every outcome, not just bounce. This is the same missing
  capability already named above for close-on-merge (dev-loop's first
  `GitHubClient`), not a separate build — that client needs at minimum
  `addComment` (bounce/pass detail, mirroring research-loop's routing
  rule so Jira stays brief-templated and GitHub carries the full
  reasoning) alongside `closeIssue`.

**What's actually left, in priority order for closing this entry out**:
1. dev-loop's first `GitHubClient` — needs `addComment` (route bounce/PR
   detail to the mirror Issue, same routing rule as research-loop:
   Jira = brief pointer, GitHub = full context) and `closeIssue`
   (`state_reason: "completed"` on merge). One build, two call sites —
   not two separate work items.
2. dev-loop merge-reconciliation pass — the caller for `closeIssue`
   above; also where `addComment`-on-landed would be called from.
3. Jira-comment-shape hook — a real Phase 1 gap, not just a Phase 2 one.
4. Phase 2 itself — correctly the big deferred item, not in scope for a
   quick close-out.
5. The edge-case list above — correctly deferred, no progress expected
   soon.
6. Decision (not code): formally resolve the `stageLabels`/status-label
   question one way or the other instead of leaving it implicitly
   abandoned.

**Aside, resolved 2026-09-17 (tracked in dev-loop's own CHANGELOG.md, not
here — this doc's rule is "not tickets it processes," and this was a
dev-loop pipeline-behavior fix)**: the dev-loop bounce-loop bug (a
bounced ticket re-polling and re-bouncing itself every ~5s) is fixed —
`pollJql.dev` now excludes tickets already at `statusNames.bounced`.

### Size-score enforcement (cross-run growth cap, Scope/Ground mismatch check, replacing checklist items 4/8) + devils-advocate/qa-agent checklist expansion (Part 4)

**Idea**: this entry covers everything that was *cut* from the verifier-
agent size-scoring work to ship a safe MVP first (see `CHANGELOG.md` for
the MVP itself — schema + pure shadow telemetry: `size_trajectory` logged
on every passing run, nothing reads it, items 4/8 of the Definition-of-
ready checklist untouched). None of the below is built. All of it requires
its own design pass and its own adversarial review before landing — do not
build any of it off this entry's sketch alone.

**Why cut from the MVP**: a full spec covering all of this was drafted
(`docs/research-part3-4-spec-draft.md` (repo root), two revisions) and put through
two full rounds of 3-reviewer adversarial review. Both rounds found
critical, non-converging issues — most importantly, that every version
kept bundling genuinely-inert telemetry changes together with live,
verdict-affecting enforcement changes while claiming the whole thing was
"pure telemetry" (the growth cap and the Scope/Ground mismatch check are
both verdict-affecting; shipping them under a shadow-mode banner that says
"the score affects nothing" is a real contradiction, confirmed
independently by two different reviewer seats across both rounds). Rather
than attempt a third patch-the-holes revision, scope was cut to an MVP
that changes zero behavior (by construction, no reviewer could find a
contradiction in something that doesn't affect any decision), with
everything that *acts* on the score deferred here. See
`docs/research-part3-4-spec-draft.md` (repo root) for the full rejected spec and the
specific findings, if resuming this work later.

**Deferred items**:

1. **Cross-run growth cap**: a ticket that keeps getting re-refined
   (re-pickup after bounce or human comment) and keeps growing in scope
   across runs should eventually be force-bounced `too_large` rather than
   cycling indefinitely. Not yet scoped: what a genuine hard cap looks
   like (every revision drafted so far left runs 1-3 fully uncapped, had
   no defined behavior past run 4, and never caught a ticket that's
   "stable but oversized" with low per-run growth — flagged as not
   actually a cap, independently, by both rounds of review); whether
   "4th run" or "≥4th run" is the trigger; how `reset-project` should
   interact with it (does resetting a project's run history also reset
   the cap counter — almost certainly yes, but not verified against
   `docs/reset.md`'s actual delete list).
2. **Scope/Ground mismatch check**: give `verifier-agent` Ground's own
   recon findings (file/subsystem list) alongside the synthesized draft,
   so it can catch Scope's self-reported file/subsystem count
   undercounting what Ground actually touched — a plausibility check on
   the size-score inputs themselves, not just the score. Not yet scoped:
   how big a mismatch triggers what (bounce vs. advisory note); this was
   flagged as only solving the egregious-undercount case, not subtler
   self-grading — the self-grading problem (the score's own dimensions 2/3
   are built from Scope's self-reported counts) is not actually fixed by
   this check, only narrowed. Needs a harder look at whether the score
   should source file/subsystem counts from something other than Scope's
   own self-report before this is worth building.
3. **Replacing checklist items 4 (qualitative size bound) and 8 (flat
   ~10-AC threshold) with the score as a gate**: once enough shadow-mode
   `size_trajectory` data exists across real runs (see the Checkpoint
   report below), decide whether the mechanical score is actually a
   better signal than the two checks it would replace, and if so, design
   the actual gate (what score range bounces `too_large`, how it degrades
   gracefully for the first N tickets before enough history exists to
   trust it). This is the whole reason the MVP computes and logs the
   score without acting on it — a Checkpoint report reading the
   accumulated shadow data is the dependency for this item, not a
   calendar date.
4. **Part 4 — devils-advocate-agent angles 5-6 and qa-agent items 6-9**:
   new checklist items for failure classes caught only by post-merge
   GitHub Copilot review on real tickets TARS-1554/1565 (unbounded
   memory/canvas allocation, PNG alpha-channel loss, a flaky
   origin/master-dependent test, unmemoized re-renders, missing
   `role="alert"`, two responsive-breakpoint bugs). Needs: a full rewrite
   of `devils-advocate-agent.md`'s "four angles" framing (its own text and
   Output section are written as "four angles," not just missing two new
   bullets — a straight append doesn't fit without contradicting the
   file's own "don't hunt for a fifth angle" instruction); `qa-agent.md`
   (dev-loop) renumbered items 6-9 with item 9 scoped to layout/CSS diffs
   only (not every diff); and a held-out eval against real historical
   tickets to calibrate false-positive rate before trusting the new
   checks live — not yet scoped: a real, enforceable cost ceiling for
   that eval (both drafted revisions had an unenforceable one — checked
   only between tickets, not per-ticket, and Agent-tool calls don't report
   cost the way `claude -p --output-format json` does, so no real
   measurement source was ever named) and a genuine dry-run guarantee (the
   subagents are defined with "Tools: All tools" — invoking them directly
   to bypass the host skill's orchestration doesn't by itself prevent a
   live write without an explicit tool restriction).
5. **`runs/<project>.jsonl` / `.pipeline/<slug>/runs/` retention policy**:
   both grow unboundedly today (append-only, gitignored, never pruned).
   Flagged in the first review round and never addressed in either spec
   revision. Not yet scoped: age-based vs. count-based retention, whether
   `.pipeline/` scratch dirs need the same treatment as `runs/`'s audit
   log, and whether this is really specific to the size-score work at all
   (it predates it and would be worth fixing independently either way).

### Research test-design fixes (ticket-refine), from bounce criteria v2

**Idea**: research spent self-heal cycles on its own test design on
TARS-1440 and TARS-1495. Add a check that each named test can actually
fail on current code (not only that it is named), and fold in the
TARS-1495 rules. Deferred out of
`docs/superpowers/specs/2026-11-20-bounce-criteria-v2-design.md` (scope
decision 4). See also "Test-spec rigor for stateful ACs" below.

### Test-spec rigor for stateful ACs (ticket-refine)

**Idea**: for ACs on stateful components, have Synthesize build a
trigger-by-trigger matrix: list every trigger that changes or clears the
state, and require one named test per trigger, walked one cell at a time
as the final self-heal check (an empty cell is a defect). Related ideas:
move the test-assertion rules a human supplied after a bounce into the
skill text, and when only test-spec defects remain with the product
design settled, resume Synthesize from the existing `draft-spec.md`
instead of bouncing. Any change here should add a check or remove waste,
never relax a gate: accuracy first, slower is fine.

**Why**: `TARS-1495` bounced `spec_ambiguous` four times; the last two
were test-spec defects (the self-heal cap ran out before they were all
found), and `TARS-1440` hit the same cap earlier. It landed `ready` after
a human gave it a discrimination principle plus rules A-E (Jira comment
1051952), then a trigger matrix, resume-from-draft and 2 extra cycles
(comment 1052014). Not vetted: that is one ticket, the human's comment
spelled out the matrix shape, and the bounce counts come from the runs
log `detail` fields only. Look into it properly when picking this up.

### Startup check: the Atlassian tools the skills rely on exist

**Idea**: at startup, list the connected Atlassian MCP server's tools and
refuse to poll when one the role relies on is missing under both names.
Today a rename only shows up mid-run as a permission denial or a confused
bounce.

**Why**: TARS-1640's eval (2026-11-17). The host connector had moved to
Atlassian's `/v2/mcp`, research's comment tool was denied, and dev bounced
`spec_ambiguous`. The allowlist now names both versions, and a text guard
pins the skills' name table. A live tool list would catch the *next*
rename. `claude mcp get` shows the server URL but not its tools, so this
needs an MCP `tools/list` call, or a cheap `claude -p` probe like
`npm run sbx:smoke` does.

### Settings drift check (code reads a setting `.envrc.example` lacks)

**Idea**: before a dev run, the loop compares the settings the target repo's
code reads (`process.env.X`, `import.meta.env.X`) with the names in
`.envrc.example`, and bounces `env_setup` naming any that are missing. The
robot works on a fake env built only from `.envrc.example`
(`src/core/fake-env.ts`), so a missing name means the app or a test runs
without it. Today the robot bounces when it notices; a mechanical check
would catch it every time.

**Why not yet (2026-11-17)**: webtarsthree's `.envrc.example` already
drifts from real `.envrc` files (some names only in one, some only in the
other), so the check would bounce every ticket. **Fix webtarsthree's
`.envrc.example` first**, then add the check.

### sbx adds real INT keys on the way out

**Idea**: for the few settings that are real INT API keys sent as an HTTP
header, let sbx's proxy inject them per request (as it does the GitHub
token), so the robot can run against INT services while still never holding
the key. Header-shaped keys only; anything the app needs in memory stays
fake.

### Typed settings list plus vault refs (webtarsthree team idea)

**Idea**: replace the hand-kept `.envrc.example` with a typed schema in the
target repo (`@t3-oss/env-core`, `envalid` or `zod`), which is the one list
of settings, their types and their safe defaults. The real values become
vault references (`op run`, Doppler, dotenvx) instead of plaintext in
`.envrc`. dev-loop's fake env and the drift check would then read the
schema. This is for the webtarsthree team to decide.

### GitHub Issue + Projects board as pipeline state owner (Jira = product/planning only)

**Idea**: move pipeline execution state out of Jira and into GitHub. Jira
keeps the product/project side (the ticket, priority, description, fix
version, visibility for non-engineers). The mirror GitHub Issue owns
execution state (refining, bounced, awaiting approval, executing, PR open,
merged), shown as lanes on a GitHub Projects v2 board
(`fandango` org project 27, stock kanban template: Backlog / Ready /
In progress / In review / Done). Jira gets only coarse milestone
write-backs (refined, PR open, deployed) so it never goes stale. Builds on
the settled plan in `~/Desktop/pipeline-label-simplification.md` (one Jira
`pipeline` label, Issue as state owner, build phase 0 = create the 18
GitHub labels).

**Why**: Jira workflow transitions have required fields/screens/permissions
that break unattended runs; the Issue, branch and PR can't disagree when
state lives beside the code; GitHub Actions can drive lanes with no
pipeline code (PR opened -> In review, merged -> Done); Issue timelines
give an audit trail. A single-select Status also can't hold two states at
once, unlike stacked labels.

**Open points (not vetted)**: the stock lanes have none for bounced /
blocked / abandoned, so add Status options or keep a label/field for them.
One writer per fact: decide which system owns each field and make the
other read-only. Projects v2 items are separate from Issues (adding one is
a GraphQL call; moves need project/item/field/option ids). Reset and
re-refine paths (`reset-project`, "never re-refine") would need to read
state from the Issue. `gh` needs the `project` scope (done for
JustinChan-fd). Suggested order: labels first, board as a read-mostly view
that follows them, then move `src/` state reads/writes one transition at a
time (TDD). dev-loop has a matching entry in its own
`docs/future-enhancements.md`.

## Dev phase

Ideas for the pipeline itself (not tickets it processes) that are worth
doing but not yet drafted into a change. This is a holding pen: write down
the idea and the evidence behind it, then leave it for later. When one is
implemented, move its entry to `CHANGELOG.md` (if present) and delete it
from here.

### GitHub Issue + Projects board as pipeline state owner (Jira = product/planning only)

**Idea**: move pipeline execution state out of Jira and into GitHub. Jira
keeps the product/project side (the ticket, priority, description, fix
version, visibility for non-engineers). The mirror GitHub Issue owns
execution state (refining, bounced, awaiting approval, executing, PR open,
merged), shown as lanes on a GitHub Projects v2 board
(`fandango` org project 27, stock kanban template: Backlog / Ready /
In progress / In review / Done). Jira gets only coarse milestone
write-backs (refined, PR open, deployed) so it never goes stale. Builds on
the settled plan in `~/Desktop/pipeline-label-simplification.md` (one Jira
`pipeline` label, Issue as state owner, build phase 0 = create the 18
GitHub labels).

**Why**: Jira workflow transitions have required fields/screens/permissions
that break unattended runs; the Issue, branch and PR can't disagree when
state lives beside the code; GitHub Actions can drive lanes with no
pipeline code (PR opened -> In review, merged -> Done); Issue timelines
give an audit trail. A single-select Status also can't hold two states at
once, unlike stacked labels.

**Open points (not vetted)**: the stock lanes have none for bounced /
blocked / abandoned, so add Status options or keep a label/field for them.
One writer per fact: decide which system owns each field and make the
other read-only. Projects v2 items are separate from Issues (adding one is
a GraphQL call; moves need project/item/field/option ids). Reset and
re-refine paths (`reset-project`, "never re-refine") would need to read
state from the Issue. `gh` needs the `project` scope (done for
JustinChan-fd). Suggested order: labels first, board as a read-mostly view
that follows them, then move `src/` state reads/writes one transition at a
time (TDD). research-loop has the matching entry in its own
`docs/future-enhancements.md`.

**dev-loop specifics**: dev-loop is the executor, so the relevant
transitions are executing -> PR open -> merged and the poll step. Its
`loopKind: "dev"` poll has no atomic claim today; a board Status move (or
Issue assignee/label) could serve as the claim, which also helps the
N-instances-per-project idea tracked in research-loop's doc.

## Both phases

### Already-merged check before either phase starts

**Idea**: before research or dev starts, search git and GitHub for the
ticket key; a merged PR stops the run with a clear message. **Evidence**:
repeat runs on TARS-1465, TARS-1473 and TARS-1487, whose work had already
merged. Deferred out of bounce criteria v2 (scope decision 4).

### UI snapshots against the mockup

**Idea**: compare the running UI with a mockup screenshot (QA, or a
research check of "what exists today"). **Blocker**: login and auth on the
target apps; the robot cannot get past the login to reach the screens.
Until then, bounce criteria v2's QA note naming the POC element is how a
person checks visual ACs. **Evidence**: 4 of the 6 fixes on catalog PR #237
were items the POC showed but no AC covered.


### Run watcher: what is left after the POC

The local, read-only page (`npm run dashboard`, design
`docs/superpowers/specs/2026-11-20-run-watcher-design.md`) replaced the
planned `npm run status` terminal view. It covers live runs, history,
per-run logs and a timeline. Still to do, each on its own when wanted:

- **Batch view with data.** Today it is only the empty state. It needs a
  batch file written by the future batch orchestrator (v2 design §8): the
  tickets, what each depends on, and each one's base branch. The page then
  lays them out in tiers, as the mockup's Future: batch scenario shows.
- **Parked tickets at a glance.** A parked run shows as a Parked card, but
  "currently parked" (the ticket's latest record) and what was refused (the
  `parked.denied` list and allow hint) aren't summarized. `npm run
  sandbox:approvals` still owns that.
- **Live cost.** A live card says "Cost: when it ends", because
  `usage.json` is written only at the end.
- **GitHub issue link.** Nothing on disk records the mirror Issue's
  number; the loop could write it to the run dir when it finds or creates
  it, and the page would link it.
- **Subagent filter.** Possible only if the skills name the subagent in
  their progress lines (some do, not reliably).

Sandbox CPU and memory stay in sbx's own dashboard (`npm run
sbx:dashboard`).

**Raised**: 2026-11-12 (as the monitoring view); POC built 2026-11-21.

### Run watcher: collapsed finished cards

**Idea**: once there are many finished runs, show finished cards collapsed
to one line (key, status, where it ended, when), expanding on click. The
user decided on 2026-11-20 to keep every card fully expanded for the POC
and to defer this.

**Raised**: 2026-11-20, in the dashboard design session.
