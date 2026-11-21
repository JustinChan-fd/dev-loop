---
name: ticket-refine
description: Refine a raw Jira ticket into a Sonnet-executor-ready spec for ticket-to-pr. The skeptic role (spec section 5.0/5.1) - treats the raw ticket as a claim to be verified, grounds it against the codebase, attacks its own assumptions, and only then writes the refined ticket.
---

# ticket-refine

## Arguments

`$ARGUMENTS` — exactly `<TICKET> run-dir=<RUN_DIR> repo-dir=<REPO_DIR>`,
e.g. `TARS-1301 run-dir=<abs path ending in /TARS-1301/research-20261111T010203Z> repo-dir=<abs checkout path>`.
All three are required. The loop runner builds this line (see "Invocation"
below); never derive any of the three yourself.

- `<TICKET>` — the Jira ticket key.
- `run-dir=` — this run's directory (`RUN_DIR` below).
- `repo-dir=` — the target repo checkout this run grounds against
  (`REPO_DIR` below).

## Role: the skeptic

Per spec section 5.0, this skill is the pipeline's deliberate bottleneck —
doubt is expensive (this runs at a higher tier, with codebase recon and
adversarial subagent fan-out), so it is spent exactly once per ticket,
upstream of the human review gate. Once a ticket crosses Review → Ready,
its contents stop being questioned; all the questioning happens here.

Treat the raw ticket as **a claim to be verified**, not an instruction to
execute. Your job is to either produce a ticket a literal-minded Sonnet-tier
implementer (`ticket-to-pr`) can execute without asking a single question,
or to bounce it with concrete evidence of why it isn't ready.

## Setup: idempotent re-refinement

**Atlassian tool names.** Your Jira tools may come from either version of
Atlassian's MCP server, and some tools have a different name on each. Use
whichever of each pair you have (both are allowed):

| Job | Older server | Newer server (`/v2/mcp`) |
|---|---|---|
| Post a Jira comment | `addCommentToJiraIssue` | `addOrEditJiraIssueComment` |
| Read a ticket's comments | `getJiraIssue` (fields incl. `comment`) | `listJiraIssueComments` (pages every comment; the newer `getJiraIssue` shows at most 20 and may show none) |
| Read a Confluence page | `getConfluencePage` | `getConfluenceContent` |
| Search Confluence | `searchConfluenceUsingCql` | `searchConfluence` |

Where the newer server has `listJiraIssueComments`, use it to read
comments: never conclude a ticket has no comments from `getJiraIssue`
alone.

**Always check first**: does this ticket already have a research-loop
Jira comment (title starts with `✅ research-loop -` or `❌ research-loop
-`) or an equivalent GitHub Issue comment (first line starts with `##
✅ research-loop -` or `## ❌ research-loop -`)? Either is evidence of a
prior pass — match on the leading icon + `research-loop -` prefix, not
the old fixed strings (`Refined Spec — ready for ticket-to-pr`,
`Ticket-Refine Bounce — <category>`) that this convention replaces; this
skill no longer writes those. Comments on an Issue closed as `NOT_PLANNED`
never count as a prior pass (see Step 0.5). Two cases:

- **First pickup** (no such comment exists): proceed through Steps 0–7
  below as a fresh refinement. The ticket's description is never touched —
  it's the stakeholder's original and stays exactly as written, permanently.
- **Re-pickup after human comments** (ticket status was reset to `To Do`
  with a steering comment added, still carrying the research trigger label
  (`roles.research.triggerLabel` in the project config) —
  research-loop's intake and spec-review territory is one combined label
  state, not two, so there's no label to swap between at this point): read
  the human's comment(s) as steering input, and **revise** the existing
  refinement rather than starting over from scratch. Re-run only the steps
  the comment calls into question (e.g. if the human flagged an incorrect
  fault-domain call, redo Step 0's fault-domain determination and Step 6's
  synthesis; you don't need to redo Step 2's codebase grounding if it
  wasn't disputed).

**This match is for reading prior context only — it is never a write/edit
target.** Use it to find the most-recently-created matching comment (by
creation time, not position in the thread) and read it as the current
state to revise from. Both Jira and GitHub sort comment threads by
*creation* time, not edit time — editing an old comment in place leaves it
sitting at its original position in the thread while newer human replies
and steering comments land below it, so a reader (or `ticket-to-pr`) sees
stale-looking content sitting above what is actually newer. This produced
a real incident (TARS-1450, 2026-09-19): the pipeline's own state was
internally consistent, but the Jira and GitHub threads *looked* out of
sync because the tracked comment's content kept changing while its
position never moved. See "Ticket content protocol" item 5 and "Bouncing"
below — every re-verify or re-pickup cycle **always posts a brand-new
comment**, never edits an existing one.

## Setup: run directories and progress logging

Same discipline as the dev phase's `ticket-to-pr`, for dashboard parity:

1. **Use the `run-dir=` and `repo-dir=` you were given.** `run-dir` must be
   absolute and contain `/.pipeline/v2/`. If either is missing or
   malformed, write no files and stop with an `agent_error` verdict.
   Never guess a path. (With no usable `RUN_DIR` there is nowhere to write
   `verdict.json`; the loop runner records the missing verdict as
   `agent_error` itself. Post nothing to Jira or GitHub, print the
   always-emitted result line,
   `RESULT: error — missing or malformed run-dir=/repo-dir=`, and stop.)
   `RUN_DIR` = the `run-dir=` value; `REPO_DIR` = the `repo-dir=` value.
   Both are absolute; use them exactly as given.
2. `RUN_ID` = the part of `RUN_DIR`'s last path segment after its first
   `-`. The last segment is `research-<RUN_ID>`, so for
   `.../TARS-1301/research-20261111T010203Z`, `RUN_ID` is
   `20261111T010203Z`. It names this run's worktree (see "Target repo"
   below).
3. `RUN_DIR` already exists (the loop runner creates it). Write only inside
   it — never anywhere else in the dev-loop checkout.
4. Append one JSON line per phase transition to `RUN_DIR/progress.jsonl`:
   ```json
   {"ts": "<ISO-8601 UTC>", "phase": "triage|interpret|ground|attack|scope|blocked-check|synthesize|verify", "event": "phase_start|phase_end|note", "detail": "one line"}
   ```
5. The final event, always emitted regardless of outcome, is
   `"event": "result"` — see "Always-emitted result line" below.

## Target repo (grounding)

The project config is `pipeline.<project>.config.json` at the dev-loop
repo root (this session's working directory). Its `targetRepo` and
`github.repo` keys are the ones this skill reads. `targetRepo` names the
codebase this skill grounds tickets against
(e.g. `pipeline.webtarsthree.config.json` names `git@github.com:fandango/webtarsthree.git`).
`REPO_DIR` (from `repo-dir=`) is that codebase's checkout on this machine:
`targetRepo.path` when the config sets it, otherwise a shared fetch-only
clone the loop runner points you at. Read `targetRepo.url` and
`targetRepo.defaultBranch` from the config; take the checkout's location
only from `REPO_DIR`. This skill never commits — it only reads code (and,
via a dev server, exercises it) to verify or contradict the ticket's
claims. Adding a second project later means adding a second
`pipeline.<project>.config.json` — no code or skill changes.

**Per-run worktree, nested inside `REPO_DIR` itself — never work directly
in a shared checkout.** At the start of Step 2 (Ground) — the only step
that touches the target repo — create an isolated, detached worktree for
this run **inside** `REPO_DIR`'s own directory tree
(`<REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>-ground`, not a sibling
path elsewhere). The loop keeps a **fake env** at
`<REPO_DIR>/.claude/worktrees/.envrc`, built from the target repo's committed
env template (`.envrc.example` by default, e.g. `app/.env.example` for an
app-folder project) with placeholder values, so `direnv exec <worktree>`
loads the fake, never the person's real `<REPO_DIR>/.envrc`. Never read or
create an app folder's real env file (e.g. `app/.env.local`) either.

**Ticket attachments.** The loop downloads the ticket's Jira attachments on
the host before every run into `<RUN_DIR>/attachments/` and lists each one in
`<RUN_DIR>/attachments.json` as `fetched` (with its `path`), `skipped` (with
the `reason`: type or size) or `failed` (with the `error`). Read the manifest
in Triage and read every fetched file the ticket points at (a response
sample, a mockup, a spec) with the Read tool. Never fetch an attachment
yourself (no download tool, no `curl`). An attachment on the ticket is a
resource the ask rests on: any entry that is `skipped` or `failed`, or a
manifest with an `error`, is a **`blocked` bounce** naming the file and the
manifest's reason (fix the input, not the ticket text). The loop enforces
this: a `ready` verdict with an unreadable attachment is turned into that
bounce. Ground what you write against the fetched file: copy field names
and values from it into the refined ticket, so the implementer never needs
the attachment. Design attachments (mockup HTML, PNG, POC) also get the
attachment inventory below.

**The size context.** For research runs the loop writes
`<RUN_DIR>/size-context.json`: the project's dev limits
(`dev_max_cost_per_run_usd`, `dev_run_timeout_min`,
`max_cost_per_ticket_usd`), the median and p90 cost and minutes of the most
recent landed tickets, and per ticket its cost, minutes, QA loops, files and
lines changed, and research's earlier size estimate. Step 4 judges size
against it. Missing or empty `tickets` means no history yet: judge against
the limits alone.

**The project profile.** The loop writes `<RUN_DIR>/project.json`
(`appDir`, `nodeMajor`, `devCommand`, `devUrl`). Read it; never guess them
from the repo. Missing means `appDir` `.`, `devCommand` `npm run dev`,
`devUrl` `http://localhost:3000`. Installs and the dev server run in the
app folder: `direnv exec <worktree>/<appDir> <cmd>`.
Never read `<REPO_DIR>/.envrc` or `<REPO_DIR>/.env` (with any tool),
never copy `.envrc.example` to a `.envrc`, and never point `direnv exec`
at `<REPO_DIR>` itself. If grounding shows the ticket needs a setting
`.envrc.example` lacks, say so in the refined ticket (the implementer adds
it there with a fake value). Never work directly in `REPO_DIR` itself, since a human may `cd`
into it or be mid-inspection of a prior run's worktree at any moment while
this loop runs unattended in the background.

If `REPO_DIR` has no `.git` yet (the shared clone was never made on this
machine), clone it first; otherwise skip straight to the fetch:

```bash
if [ ! -d <REPO_DIR>/.git ]; then
  git clone <targetRepo.url> <REPO_DIR>
fi
git -C <REPO_DIR> fetch origin
git -C <REPO_DIR> worktree add --detach \
  <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>-ground \
  origin/<targetRepo.defaultBranch>
```

`<REPO_DIR>/.claude/worktrees/` is expected to be listed in that repo's
own `.git/info/exclude` (a machine-local, never-committed ignore rule) —
not this skill's job to add, but don't be alarmed that it's untracked and
outside this repo.

Ground, and every `recon-agent` it spawns, reads and executes only inside
the `<REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>-ground` directory just
created — never in `REPO_DIR` itself. See "Cleanup" below for removing
this worktree once Ground (and the rest of the run) concludes.

## Always-emitted result line

Whatever step this run ends at, the last thing this skill does is emit one
line — to stdout, as the final `progress.jsonl` event, and as
`verdict.json`'s `detail` field:

- `RESULT: ready — refined ticket written` (passing verdict)
- `RESULT: bounced (<failure_category>) — <one-line reason with concrete evidence>`
- `RESULT: error — <what went wrong>` (tooling/environment failures only —
  spec problems are always `bounced`)

## The skeptic sequence

### Step 0 — Triage & route

Read the Jira issue type. Select the matching checklist — all checklists
share Steps 1–7 below, but this step's findings feed what "Ground" and
"Attack" specifically look for. Skepticism scales with issue type and how
much information the ticket arrived with.

- **Bug checklist**: reproduce it. **Determine fault domain** — is this
  broken in the target repo's own code, or is a backend service/API not
  returning what its contract promises? Inspect the failing call, the
  service response, the contract. If the fault is upstream: bounce
  `blocked`, naming the owning service, and draft a follow-up ticket for
  that team (see Step 4) rather than pretending the target repo can fix it
  client-side. Then determine: regression window (when did it last work?
  — check git log/blame on the relevant area), severity, affected surface.
- **Tech Story checklist**: verify the ticket's claims about current
  architecture against the actual code. Check dependencies and
  prerequisites. Consider migration/rollout implications. Determine
  whether the story is genuinely one change or a disguised epic.
- **Unknown/other issue types**: run the fullest, most skeptical version of
  the above (treat as if it were a Tech Story with an unclear fault
  domain).

### Step 0.5 — Open/link the GitHub Issue

Before Interpret, find this run's GitHub Issue mirror (`main.ts` already
created or found it right after claiming the ticket, per Phase 1 of
docs/future-enhancements.md's Jira label-trigger design):

```bash
gh issue list --repo <github.repo from pipeline.<project>.config.json> \
  --search 'in:title "<TICKET-KEY>:"' --state all \
  --json number,url,title,state,stateReason
```

This run's Issue is the newest Issue (highest number) that is open or closed
for a reason other than `NOT_PLANNED`. `main.ts` guarantees a fresh Issue exists when the only
matches were closed as not planned. Rename it now that you have the real
ticket summary (read via `getJiraIssue`, same call Interpret would make
anyway — doing it here just moves the read earlier):

```bash
gh issue edit <number> --repo <github.repo> --title "<TICKET-KEY>: <ticket summary>"
```

**Not-planned Issues are prior context only.** For each `NOT_PLANNED` Issue
(left by an earlier run that was reset), read its comments:

```bash
gh issue view <n> --repo <github.repo> --json comments
```

What it holds is what the earlier run found and why it was reset. Treat it
as an unverified claim under the stance's rules, exactly like the raw
ticket: never a spec to copy, and never a reason to treat this run as a
re-pickup (it does not count as "a prior pass" in "Setup: idempotent
re-refinement"). Note it once in `progress.jsonl` (`"phase": "triage",
"event": "note"`, detail `prior attempt #<n> read as context`). Never
rename, comment on, or reopen a not-planned Issue.

Remember this Issue's number/URL for the rest of the run — every comment
this skill posts from Step 1 onward that the routing rule below classifies
as GitHub-only goes to this same Issue via `gh issue comment <number>
--repo <github.repo> --body "..."`, never a new Issue per comment.

If no matching Issue is found at all (the pre-run creation in `main.ts`
failed and was logged, per its own never-throw contract) — proceed anyway,
without a GitHub Issue for this run. Note this once in `progress.jsonl`
(`"phase": "triage", "event": "note"`, detail: "no GitHub Issue found for
this ticket -- proceeding without one") and route what would have been
GitHub-only content into a single Jira working comment instead, for this
run only. Do not fail or bounce the run over a missing mirror Issue — it's
an infrastructure gap, not a spec-readiness problem.

### Step 1 — Interpret

Before restating the ask, exhaust the context Jira itself already has —
don't declare something ambiguous or under-specified until you've checked:

1. **This ticket's own comment thread** (`listJiraIssueComments` where you
   have it, else `getJiraIssue` with `comment` in `fields`; see "Atlassian
   tool names") — read every comment,
   not just the description. A prior discussion may already answer the
   exact question you're about to flag as open.
2. **Linked issues, one hop** — any ticket connected via `relates to` /
   `blocks` / `is blocked by` / `duplicates` on this ticket (its own link
   data, no further traversal from those tickets). Read their
   summary/description/comments too. A linked ticket may contain the
   missing fault-domain call, a prior decision, or evidence this exact
   ambiguity was already resolved elsewhere.

Only after checking both: restate what the ticket is actually asking, in
your own words. If more than one reading is *still* plausible after that
context, enumerate the readings explicitly. An unresolvable ambiguity here
is an immediate bounce (`spec_ambiguous`, listing the readings and noting
what the comment thread/linked tickets did or didn't resolve) — not a coin
flip, not "pick the most likely one and proceed."

**Cheap pre-gate before Ground.** Tickets here vary widely in how much the
reporter wrote — thin tickets are common and are not, by themselves, a
reason to bounce; Ground/Attack below exist specifically to do the
investigation a thin ticket didn't do for itself, and a bounce should
normally come *after* that investigation fails to resolve the gap, with the
investigation's own evidence attached. But before paying for subagent
fan-out, check for the **zero-signal** case — nothing concrete enough for
Ground to even locate code against:
- Bug with no repro steps, no error text, and no named surface (page,
  endpoint, component) — not even a vague one.
- Tech Story / other with no acceptance criteria of any kind and no
  described current-vs-desired behavior.

If (and only if) this ticket is genuinely zero-signal after the comment
thread and linked-issue check above — bounce now, `spec_ambiguous`, detail
naming specifically what's missing (not "ticket is thin," which is
everywhere; the *specific* absence — e.g. "no repro steps, no error
message, no page/endpoint named"). This is a narrow gate: a thin-but-not-
empty ticket ("the export button doesn't work") still has enough of a
surface to Ground against and should proceed. Skip this gate entirely (go
straight to Step 2) once there is *anything* concrete to investigate.

### Step 2 — Ground

This step is pragmatic investigation, not a lookup. Approach it the way a
developer would debug something unclear: form hypotheses, then work through
them with trial and error until one is confirmed or all are exhausted —
don't stop at the first plausible-looking explanation without checking
whether it actually holds.

0. **Currency check, before anything else in this step.** Before forming
   hypotheses or spawning any `recon-agent`, do one cheap, direct check —
   a `Read`/`grep` on the specific file(s)/behavior/test the ticket names,
   not a fan-out — to confirm the ticket's premise is still current. Tickets
   can go stale: the described gap may already be fully closed, or partially
   closed (e.g. a test file the ticket claims doesn't exist actually does,
   but the specific coverage the ticket is really asking for is still
   missing). This exists because the expensive parallel hypothesis machinery
   below is the wrong tool for "does this still need doing at all" — that
   question should be answered by one cheap read, not a multi-hypothesis
   investigation that only discovers the contradiction after paying for it.
   - **Fully resolved** (the described problem/gap no longer exists at
     all — already fixed, file already does what's asked, nothing left to
     do): bounce `spec_contradicted` right here, cheaply, with the specific
     evidence (file, line, what you found vs. what the ticket claims). Do
     not proceed to hypothesis-forming.
   - **Partially stale** (real work still exists, but the ticket's framing
     of it is wrong — e.g. it assumes a file must be created when it
     already exists and the actual gap is extending it, or assumes a
     symptom that's now different from what's actually broken): this is
     not a bounce. Correct your working understanding of the premise (note
     the correction, e.g. "extend the existing file" instead of "create a
     new one") and continue into hypothesis-forming with the corrected
     premise — the work is real, just mis-described; a bounce here would
     just cost a human round-trip for something this skill can fix in the
     same run.
   - **Premise holds**: proceed as normal.
1. **Form hypotheses.** If the cause or the described behavior isn't
   obvious from a first read, write down 2–3 concrete, distinct candidate
   explanations (not "something's wrong in the auth flow" — specific enough
   that confirming or refuting one wouldn't also confirm or refute another).
   If there's genuinely only one plausible explanation, that's fine — this
   is about not stopping at the first guess when there's real ambiguity,
   not manufacturing multiple hypotheses for their own sake.
2. **If any hypothesis needs a live API call to test** (not just reading
   client code — actually seeing what an endpoint returns), start the
   target repo's own dev server *once*, in the worktree created above,
   before spawning any `recon-agent`. Check whether it's already running
   first (e.g. hit its health-check route) — don't start a second instance.
   Start it with the profile's `devCommand` in the app folder
   (`direnv exec <worktree>/<appDir> <devCommand>`, after
   `direnv exec <worktree>/<appDir> npm ci`) and wait for it to be ready at
   the profile's `devUrl` (e.g. `http://localhost:3000` with `/api` proxied
   to a local API server) — this is what you pass to
   each `recon-agent` that needs it. If it fails to start, or starts but
   can't reach whatever upstream services it depends on (e.g. missing local
   credentials in a freshly cloned checkout), live API verification is
   simply unavailable for this run — `recon-agent` reports that plainly
   rather than guessing at a response shape or treating static code-reading
   as equivalent evidence. (Cleanup, including stopping this server, is
   covered once for the whole run — see "Cleanup" below.)
3. **Fan out one `recon-agent` per hypothesis, in parallel** (see
   `.claude/agents/recon-agent.md`) — each spawned to confirm or refute one
   specific hypothesis against the worktree (pass it the absolute
   worktree path, `<REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>-ground`,
   and, if you started one, the running dev server's local URL), not a generic "does the described
   problem exist" pass. Parallel fan-out here is about testing competing
   explanations at once, not increasing scrutiny of a single explanation.
4. Each `recon-agent` should actually try to confirm its hypothesis, not
   just read code and infer: run the existing test suite, write a
   throwaway repro script, or — if the dev server is running — make live,
   read-only calls against its local proxy routes to see what an endpoint
   actually returns (e.g. search for an item to get its id, then call the
   real endpoint with that id to reproduce the reported behavior). See
   `recon-agent.md` for the local-API rules.
5. Collect what each hypothesis's `recon-agent` found. If one is confirmed
   with concrete evidence, that's your grounding. If more than one is
   confirmed, or none is, that's itself a finding — carry it into Attack
   (Step 3) rather than picking one to move forward with.

If the codebase contradicts the ticket's claim (the described behavior
doesn't happen, the referenced file/function doesn't exist, the bug is
already fixed) — bounce `spec_contradicted` with the specific evidence
(file, line, what you found vs. what the ticket claims).

### Attachment inventory (during Ground, for every design attachment)

Read each fetched design attachment in Triage; inventory it here, once you
know what exists in the code. Depth depends on what the ticket builds:

- **A new component or screen:** list every visible element and
  interaction the mockup shows (expanders, toggles, tables, rows, borders,
  states) and its layout structure (what sits beside or under what, from
  the mockup's CSS or markup).
- **A change to something that exists:** read the current component and
  list only the difference: what the mockup adds, removes or moves.
  Unchanged parts need nothing.
- **Pure styling** (colours, exact spacing) on either kind: one line,
  "visual styling follows the mockup", backed by a QA note naming the
  elements.

If the mockup offers variants (A, B, C) and the ticket does not say which,
that is a `spec_ambiguous` question. Never quietly take the mockup's
default. Each inventory item is mapped in Step 6.

### Step 3 — Attack

Spawn a devil's-advocate subagent (see
`.claude/agents/devils-advocate-agent.md`) to try to break the working
assumptions from Steps 0–2: Is this already fixed elsewhere in the
codebase? Is the ask a symptom of a deeper cause the ticket doesn't name?
Are there hidden dependencies, blocked prerequisites, or scope the ticket
didn't mention?

Every assumption that survives this attack gets written into the refined
ticket's `### Overview` **explicitly labeled as an assumption** — the human
gate needs to see what's load-bearing, not have it silently baked in.

### Step 4 — Scope & sequence

Size is judged **after Ground**, on the grounded plan, against
`<RUN_DIR>/size-context.json`. Bounce `too_large` only when one of these
holds (the loop refuses a `too_large` verdict with no `ground` phase_end in
`progress.jsonl` or without `size_evidence`):

- **A. More than one deliverable.** The ticket holds two or more changes
  that could each merge alone and add value. Draft the split: an ordered
  set of follow-up ticket drafts, each workable, with dependencies noted.
  **Do not create these tickets yourself** — Justin approves splits before
  any new ticket is created; the machine proposes, the human authorizes.
  `size_evidence`: `{"criterion": "A", "comparison_tickets": [],
  "risk_factors": [], "split": ["<draft 1 title>", "<draft 2 title>"]}`.
- **B. Real risk to the limits.** The grounded plan looks like the landed
  tickets in `size-context.json` that came near or past the p90 cost or
  minutes, or near `dev_max_cost_per_run_usd` / `dev_run_timeout_min` /
  `max_cost_per_ticket_usd`. Name the comparison tickets and the risk
  factors: new infrastructure with nothing to reuse; async, race-prone or
  stateful UI; more than one service or repo; a planned change well above
  the size where cost climbs (about 21 or more files today).
  `size_evidence`: `{"criterion": "B", "comparison_tickets": ["TARS-1554"],
  "risk_factors": ["async or stateful UI"]}`.

Not too_large:

- **AC count alone is never evidence.** Trim ACs that only repeat
  behaviour the code already has; that is refining, not a bounce.
  Big is not expensive: MC-1435 touched 29 files and landed for $1.73.
- **A choice between designs inside one deliverable is `spec_ambiguous`**,
  with the options laid out as A and B.
- **A person's scope ruling is final.** Once a steering comment rules on
  scope ("accept as scoped", or picking one ticket of a split), size is a
  note for that ticket, never a bounce.

Write `size_estimate` (`S|M|L|XL`) into `verdict.json` on **every** outcome,
and `ac_count` (behaviour ACs in the draft, or in the ticket if you bounce
before Synthesize) when known.

**Shadow-mode size telemetry (pure logging, no behavior change)**: append
one `progress.jsonl` note this step, every run regardless of outcome:
`{"ts": "<ISO-8601 UTC>", "phase": "scope", "event": "note", "detail": "step4_tshirt: <S|M|L|XL>"}`
— a qualitative read of how this ticket's work feels sized (S/M/L/XL), the
same value as the verdict's `size_estimate`.
This note does not affect this step's own `too_large` decision in any
way — it's logged purely so later runs have a trajectory to compare
against. See `docs/skills.md`'s "Shadow-mode size telemetry" section.

### Step 5 — Blocked detection

If the work can't proceed regardless of how well-specified it is (external
dependency, missing access, an upstream decision needed, or the Step 0
fault-domain finding pointed outside the target repo) — bounce `blocked`,
naming the specific blocker.

### Step 6 — Synthesize

Write the refined ticket **to a local draft file, `RUN_DIR/draft-spec.md`
— not to the GitHub Issue.** Per the ticket content protocol (below),
working notes go to the **GitHub Issue** during work (titled `## Working
notes ...`, never `## ✅ research-loop -`), and the full `## ✅
research-loop - <short context>` content is published to that same Issue,
plus the short pointer comment to Jira, exactly once, after Step 7 passes.
The draft file is the single artifact Step 7 verifies and, unchanged, the
single artifact Step 7 publishes. The description is never touched.

**Attachments become ACs.** Map every item of the attachment inventory to
an AC, or to an `Out of scope: <item> (shown in the mockup)` line with its
reason. Never write a blanket clause such as "the mockup shows intent;
where it differs, this spec wins" — each difference is stated on its own.
Layout ACs say where things sit (citing the mockup's CSS or structure),
not only what is there. A new control names the repo's own component (e.g.
`components/shadcn/select.tsx`) or explicitly allows a native one. Each
visual AC's QA note names the mockup/POC element to compare against.
Record the map in `verdict.json`'s `attachment_coverage`: one entry per
fetched attachment (design or not), e.g. `{"attachment": "poc.html",
"kind": "design", "mapped_to": ["AC2", "AC5"], "out_of_scope": ["dark
mode"]}` or `{"attachment": "resp.json", "kind": "data", "mapped_to":
["AC3"], "out_of_scope": []}`. An entry with both lists empty does not
count.

### Step 7 — Verify

Spawn a verifier subagent (see `.claude/agents/verifier-agent.md`) to check
the synthesized ticket against the definition-of-ready checklist below.
Pass it the absolute `RUN_DIR` (so it reads `<RUN_DIR>/draft-spec.md`, and
the attachments and `size-context.json` beside it for checklist items 4
and 9).
This must be a genuinely independent check, not the same reasoning that
produced the ticket rubber-stamping itself.

- If it passes: **publish once.** Post `RUN_DIR/draft-spec.md`, verbatim,
  as the GitHub Issue's full comment, titled `## ✅ research-loop -
  <short context>` (per "Ticket content protocol" item 4), then the Jira
  pointer comment, titled `✅ research-loop - <short context>` (per item
  2) — set `verdict.outcome: "ready"`. Nothing carrying the `✅` title is
  ever posted before this point, so a `✅` comment on the Issue always
  means "passed the verifier as written". The
  ticket stays at `roles.research.triggerLabel`; the loop runner hands a
  passing ticket off to `roles.research.handoffLabel` (the dev phase's
  trigger) itself — this skill just reports the verdict. On this
  passing verifier run, it also reports a `size_trajectory` object
  (`step4_tshirt`, `delta`, `final_score` — see
  `.claude/agents/verifier-agent.md`'s "Size scoring" section); copy that
  object verbatim into `verdict.json`'s `size_trajectory` field (see
  schema below) — pure telemetry, this does not affect the verdict itself.
- If it fails: classify the failure before deciding what to do with it —
  see "Self-heal vs. bounce" below. Never skip this classification and
  bounce by default; a mechanical failure resolved via self-heal is a
  *better* outcome than a bounce, not a fallback.

#### Self-heal vs. bounce

A Verify failure is exactly one of two kinds. Get this classification
wrong in either direction and you either burn a human round-trip on
something the machine could fix itself, or you quietly paper over a real
decision that was supposed to reach the human — so this is a genuine
judgment call, not a formality.

**Mechanical** (self-heal in this same run, do not bounce): the fix has
exactly one correct answer, fully derivable from evidence Ground/Attack
already gathered in this run — no new investigation, no tradeoff, no
stakeholder preference involved. The verifier names the gap; closing it
is transcription, not decision-making. Concrete examples, all drawn from
real runs:

- A mocked dependency has no default return value, and the component
  under test calls it unconditionally — the fix is giving it the
  resolved shape the code already expects (e.g. `clientFetch(...)` is
  called with `.then(...)` right after mount; the fix is
  `mockResolvedValue({...})` with a shape matching what the real
  endpoint returns, not a new decision about what it *should* return).
- An AC's assertion is unreachable because an earlier guard in the same
  code path returns first (e.g. a required-field check runs before the
  behavior under test, so the AC's setup must satisfy that guard too).
- An AC leaves a value implicit that the code path actually branches on,
  making the test's outcome accidental rather than deliberate (give it
  the explicit value already implied by what the AC is trying to prove).
- An AC's own preconditions make its assertion vacuously true (e.g. it
  never reaches the branch it claims to test) — tighten the setup so the
  assertion is actually exercised.

**Judgment-requiring** (bounce as normal, spend no retries on it): the
verifier flags something with more than one defensible resolution, or
requiring information this run doesn't have — a design tradeoff, a
missing stakeholder decision, an architectural choice, anything the
skill's own philosophy (`## Role: the skeptic`) already reserves "for
the human gate, not a machine guess." If you notice yourself justifying
a fix with "I think probably," "the more scalable choice," or picking
between two approaches with real tradeoffs — that is judgment-requiring,
even if it feels small. Bounce it exactly as Steps elsewhere in this
skill already do.

**Mechanics of a self-heal cycle**: fix the specific gap the verifier
named **in `RUN_DIR/draft-spec.md` itself** (edit the affected AC in
place, so the draft always reads as one complete, final spec — never as a
base plus a "corrections" section, and never as a separate GitHub/Jira
comment), nothing else (do not re-open sections that already passed), then
re-run the verifier subagent on the updated draft — a fresh independent
check, not a self-assessment that the fix worked. Cap at **4 cycles** per run. If a
mechanical-looking failure is still unresolved after 4 cycles, stop
self-healing and bounce it as `spec_ambiguous` with all 4 attempts and
findings as evidence — that many unresolved "mechanical" fixes is itself
a signal the classification was wrong, or the ticket has a deeper problem
than any single AC.

Log each self-heal cycle to `progress.jsonl` distinctly from a bounce —
a `"phase": "verify"`, `"event": "note"` line whose `detail` starts with
`"self-heal cycle <n>:"` naming the specific gap and fix, so a run that
took 4 internal cycles is distinguishable at a glance from one that
passed clean on the first attempt. **Self-heal cycles are never posted
to the Issue or Jira** — `progress.jsonl` is their only record. The
published research-loop comment and `verdict.json`'s `detail` should also
note the cycle count in one clause (e.g. "ready — refined ticket written (after 4 fix/re-verify
cycles)") — this is signal for anyone reading the ticket or the run
later, not just internal bookkeeping.

## Cleanup (hard gate, every run)

Before this skill's final result line — regardless of outcome (ready,
bounced at any step, or error):

1. **If you started the target repo's dev server during Ground, stop it.**
   Confirm it's actually stopped (e.g. the port is free), not just that you
   sent a stop signal.
2. **Remove this run's worktree**:
   `git -C <REPO_DIR> worktree remove
   <REPO_DIR>/.claude/worktrees/<TICKET>-<RUN_ID>-ground`. Since this
   skill never commits, there is no "uncommitted work worth keeping"
   exception here (unlike `ticket-to-pr` — see its own Cleanup section) —
   always remove it.

Both apply even if you never reached Ground (nothing to clean up, but check
before assuming so) and even if the run is about to bounce or error out.
This is not conditional on how the run concludes.

## Definition-of-ready checklist (enforced, not vibed)

0. `RUN_DIR/draft-spec.md` follows the official template: `### Overview`,
   `### Acceptance Criteria`, `### Scope` present and populated, and the
   GitHub Issue for this run exists (it is where the draft will be
   published). *After* publishing, re-fetch the posted `## ✅ research-loop
   -` comment and confirm its body matches the draft byte-for-byte, and
   that the Jira `✅ research-loop - <short context>` pointer exists, per
   the ticket content protocol; a mismatch is a publish error, not a
   verifier failure.
1. Problem statement and every acceptance criterion are testable (each AC
   maps to an assertion `ticket-to-pr` could write a test against).
2. Files/modules to touch are enumerated by name — no "relevant files"
   hand-waving.
3. Test expectations stated in TDD-ready form: each AC names the test
   `ticket-to-pr` will write **first** (test name, what it asserts, why it
   must fail on current code), plus which existing suites must stay green.
4. Size judged per Step 4 (after Ground, criteria A or B against
   `size-context.json`); a real too_large bounces with `size_evidence`.
5. No open questions requiring human decision — else bounce
   `spec_ambiguous` listing the questions.
6. Written to the Sonnet-executor standard: no step requires inference or
   judgment to act on. The verifier asks, for each AC: "could a
   literal-minded implementer do this without asking anything?"
7. No raw secret/credential/token/password value anywhere in the draft —
   see Ticket content protocol item 8. Presence/shape references
   (`hasClientSecret: true`, a var name alone) are fine; a raw value is
   not, regardless of which step surfaced it.
8. AC shape. **Behavior ACs** (something a user or caller can observe
   changing) get one AC each, each naming its own test. **Structural /
   invariant ACs** (a file is deleted, a CSS class is removed, a file or
   export is unchanged, an import path moves) are grouped into a single
   AC backed by one mechanical check (a grep/`test -e` assertion or a
   single test that enumerates them) — not one AC and one named test per
   item. AC count is a note for Step 4, never a `too_large` signal on its
   own.
9. Attachment coverage: every fetched attachment is in
   `attachment_coverage`, every design-inventory item maps to an AC or a
   named out-of-scope line, and the draft has no blanket "spec wins"
   clause.

## Ticket content protocol

**This skill never writes to the Jira description field.** Tickets are
authored by many different stakeholders in many different styles;
normalizing or overwriting someone else's ticket into our house format is
bad practice regardless of how good the result is. The original
description stays exactly as written, permanently.

**Routing rule (Phase 1 of docs/future-enhancements.md's Jira label-
trigger design): Jira gets only four kinds of content. Everything else
goes to the GitHub Issue.**

Jira-worthy, and *only* these:
1. A blocking ambiguity that needs a human product decision (the
   `spec_ambiguous` bounce).
2. A scope call (the `too_large` bounce and its drafted split).
3. An explicit confirmation request (something this skill genuinely cannot
   resolve without asking).
4. A passing-verdict pointer: the `✅ research-loop - <short context>`
   comment, now shrunk to a short pointer + evidence summary rather than
   the full write-up (see below).

No per-comment judgment call beyond this list — if content doesn't fit one
of these four categories, it goes to GitHub, full stop.

**No mandatory @-mention.** Earlier revisions of this protocol required
@-mentioning a configured Jira accountId on every Jira comment; confirmed
excessive in practice (real example: TARS-1462's Jira comment,
2026-09-16). Comments no longer @-mention anyone. The now-unused
`jira.mentionAccountId` config field was removed (see `CHANGELOG.md`).

**Comment title convention, both outcomes:**

```
{✅|❌} research-loop - <short context>
```

`✅` = passing/landed verdict, `❌` = bounced. `<short context>` is a
one-line human-readable summary of the ticket's substance — for a bounce,
still make the failure category obvious in plain language (e.g. `❌
research-loop - scope too large, needs split`, not `❌
research-loop - too_large`). This replaces the old fixed titles (`Refined Spec — ready
for ticket-to-pr`, `Ticket-Refine Bounce — <failure_category>`) outright
— no transition period; re-pickup only needs to find *a* matching
comment (per "Setup: idempotent re-refinement" above), not preserve
historically-titled ones.

**Clean issue link, no section manifest.** Where this protocol previously
pointed to the GitHub Issue via `Full Overview / Acceptance Criteria (N
ACs) / Scope write-up: <raw URL>`, use a single clean markdown link
instead:

```
[GitHub Issue](<url>)
```

on both a passing-verdict pointer and a bounce's evidence-pointer.

GitHub-only (posted as a comment on this run's mirror Issue, via `gh issue
comment <number> --repo <github.repo> --body "..."`, per Step 0.5): recon
findings, devil's-advocate attack findings, verifier results, working/
interpretation notes, bounce evidence detail — anything in-the-weeds/
engineering-shaped. Still concise, allowed to be technical (GitHub Issues
is a developer-shaped surface — markdown, code refs, no @-mention
requirement).

1. **All work-in-progress** (interpretation notes, recon findings,
   assumption attacks, iteration updates) flows through **GitHub Issue
   comments** during the run, not Jira — this is the change from the
   pre-Phase-1 behavior, where all of this went to Jira working comments.
   The Jira description is never used as a scratchpad, and never
   rewritten, exactly as before.
2. **On a passing verdict**, write **one Jira comment**, titled `✅
   research-loop - <short context>` (per the convention above), in this
   shape, each part its own paragraph:
   ```
   ✅ research-loop - <short context>

   **Context:** <0-3 sentences max, plain language, what this ticket now
     does. Default to including this; omit it only in the rare case the
     title alone already gives a reader everything they need — that
     should be rare, not the default path.>

   [GitHub Issue](<url>)
   ```
   A passing verdict's comment never has a "Needs decision" section:
   there is nothing for a human to decide, the loop runner hands the
   ticket to dev itself.
   The GitHub Issue itself carries the full `### Overview` / `###
   Acceptance Criteria` / `### Scope` refined spec content as its own
   comment (see item 4 below) — `ticket-to-pr` reads the GitHub Issue as
   its real work order, not this Jira comment; this comment's link is
   what a human clicks through to review the real content. The existing
   secret/credential and absolute-path redaction rules (items 7-8 below)
   apply to this comment's Context text exactly as they
   always have — nothing about this new shape changes what's safe to
   write here.
3. **On a bounce**, write **one Jira comment**, titled `❌ research-loop -
   <short context>` (per the convention above — make the failure category
   obvious in plain language in the title itself, e.g. `❌ research-loop -
   scope too large, needs split`), in the same shape:
   ```
   ❌ research-loop - <short context>

   **Context:** <0-3 sentences max, plain language, what's wrong. Omit
     only in the rare case the title already says it all.>

   **Needs decision:**
   - <one bullet per distinct decision point — a bounce always has at
     least one, never zero. Each bullet names a specific, concrete
     action: "Approve the drafted split: Ticket A — <scope>; Ticket B —
     <scope>," "Decide between reading A: <...> or reading B: <...>,"
     "Confirm this belongs to the Critics service, not Catalog." Never
     collapse multiple distinct decisions into one run-on bullet with
     semicolons standing in for real separation — one bullet per
     decision, full stop.>

   [GitHub Issue](<url>)
   ```
   unless the bounce category is itself one of the four Jira-worthy
   kinds (e.g. `spec_ambiguous` naming the specific ambiguous readings,
   `too_large` naming the scope call and its drafted split) — in that
   case the ambiguity/scope-call/confirmation-request content itself IS
   the Needs-decision content, stated directly as bullets; only
   supporting evidence (grounding detail, attack findings that fed the
   judgment) goes to the linked GitHub Issue, same as before.
4. **The GitHub Issue itself carries the full refined-ticket content** on
   a passing verdict — post the complete `### Overview` / `### Acceptance
   Criteria` / `### Scope` template (identical structure to the old
   full-detail Jira comment) as a GitHub Issue comment, titled in its own
   first line `## ✅ research-loop - <short context>` (GitHub has no
   comment-title field, so this is a markdown heading instead). **This is
   the only comment that ever carries that title for a given cycle, it is
   posted once, after Step 7 passes, and it is complete and final** —
   the body is `RUN_DIR/draft-spec.md` with any self-heal fixes already
   merged in. Never post a "self-heal", "correction" or "addendum" comment
   that amends it; `ticket-to-pr` reads only the newest `## ✅` comment,
   so anything outside it is invisible to the executor. Working notes
   stay titled `## Working notes ...` so they can't match.
5. **On re-pickup** (an existing research-loop-titled Jira comment found,
   or an existing GitHub Issue comment of the equivalent title found —
   see "Setup: idempotent re-refinement" for the exact match rule): read
   the most-recently-created matching comment as prior context, but
   **always post a brand-new comment** with the current cycle's content —
   on both Jira and GitHub independently. On the GitHub Issue, the new
   `## ✅` comment's second line (directly under the title) states, when
   any earlier `## ✅ research-loop -` comment exists on the Issue:
   `Supersedes comments <id>[, <id>...]` — the numeric ids from those
   comments' `#issuecomment-<id>` URLs, oldest first. Omit the line on a
   first pickup (nothing to supersede). Working-notes comments are not
   listed. **Never edit an existing
   comment in place.** This is a hard rule, not a style preference: Jira
   and GitHub both render comment threads in creation-time order, not edit
   order, so an in-place edit leaves the newest actual state pinned at its
   original (often much earlier) position while newer human replies land
   below it — making the two surfaces (and a human skimming either one)
   look out of sync even when the underlying state is correct. Concretely,
   this means: **never pass an existing `commentId` to
   `addCommentToJiraIssue` or `addOrEditJiraIssueComment`** (that parameter updates the named comment in
   place instead of creating a new one — always omit it), never `gh api
   ... -X PATCH` an existing GitHub comment, and never `gh issue comment
   --edit-last`. (`editJiraIssue` itself edits issue *fields*, not
   comments, and stays available for its existing legitimate uses — e.g.
   the Story Points workaround noted in `docs/future-enhancements.md` —
   this prohibition is about the comment-write surface only.) Every one
   of these is prohibited regardless of how "idempotent" it would make
   the thread look — always create.
6. The Step 7 verifier checks `RUN_DIR/draft-spec.md`'s content and
   format (the full Overview/AC/Scope is published to the GitHub Issue,
   not Jira, from that same file) — a refined ticket without these
   sections, or without the GitHub Issue existing at all, is not ready by
   definition.
7. **Never write an absolute filesystem path** into any Jira comment *or*
   GitHub Issue comment — this machine's home directory is an email
   address, so an absolute path leaks PII into either surface equally.
   Refer to files by repo-relative path only.
8. **Never write a raw env var value, `.envrc`/`.env` file content, or any
   credential/token/key/password value into a Jira comment, GitHub Issue
   comment, `progress.jsonl` note, or the always-emitted result line** —
   Ground's worktree loads the loop's fake env, but real values can still
   turn up in logs, fixtures or a misconfigured machine, so treat any value
   as secret (defense in depth). Report presence/shape only, never the raw
   value — this rule now applies to the GitHub write surface exactly as it
   already applied to Jira. **Code-level backstop on both surfaces**: the
   existing `PreToolUse` hook (`.claude/hooks/block-secret-comments.sh`)
   denies a matching Jira/Confluence write; a new, equivalent hook
   (`.claude/hooks/block-github-secret-writes.sh`) denies a matching `gh
   issue create`/`edit`/`comment` Bash call — see `CHANGELOG.md`'s Phase 1
   entry. Neither hook is a replacement for following this rule; each is a
   heuristic backstop that won't catch every shape a secret could take.

## Bouncing (any step)

A bounce is a normal, successful exit — not a crash. On any bounce:

1. Run Cleanup (see above) — it applies regardless of why this run is
   ending; a bounce is not an exception to it.
2. Write **one Jira comment** (never the description), titled `❌
   research-loop - <short context>` (per the convention above, e.g. `❌
   research-loop - blocked, needs a human decision`) — greppable by the
   leading icon + `research-loop -` prefix, no longer by the old fixed
   strings this replaces. Use the Jira comment shape defined in "Ticket
   content protocol" item 3 above (Context + Needs-decision bullets).
   On re-pickup after a bounce, read the most-recently-created matching
   comment (same title convention as a passing verdict) as prior context,
   but **always post a brand-new comment** — never edit the existing one
   in place. See "Setup: idempotent re-refinement" for why this is a hard
   rule, not a style choice.
3. Write `verdict.json` with `outcome: "bounced"`, the step you stopped at
   as `phase_reached` (use the closest match: `triage`→`intake`,
   `interpret`/`ground`/`attack`→`plan`, `scope`/`blocked-check`→`plan`,
   `synthesize`→`red`, `verify`→`verify` — the loop's `PhaseReached` enum
   is shared across both skills, so map onto its nearest equivalent), a
   `failure_category` from the closed enum, and a `detail` string with the
   concrete evidence.
4. Emit the always-emitted result line and stop.

**Closed failure_category enum**: `spec_ambiguous · spec_contradicted ·
blocked · too_large · tests_flaky · env_setup · verify_rejected ·
subagent_stall · merge_conflict · agent_error · killed_ceiling`

This skill will only ever self-report `spec_ambiguous`, `spec_contradicted`,
`too_large`, or `blocked` — the others belong to `ticket-to-pr` or the loop
runner's own failure modes.

## verdict.json schema

Write to `RUN_DIR/verdict.json` (never elsewhere — the loop runner reads it
from this exact path, and only from there):

```json
{
  "outcome": "ready | bounced | error",
  "phase_reached": "intake | plan | red | green | verify | pr",
  "failure_category": null,
  "detail": "the always-emitted result line's content, without the RESULT: prefix",
  "skill_version": "<git SHA of this SKILL.md's commit>",
  "model": "sonnet",
  "cost_usd": 0,
  "tokens": { "in": 0, "out": 0 },
  "log_version": "1.1",
  "size_trajectory": { "step4_tshirt": "S | M | L | XL", "delta": "grew | shrank | unchanged", "final_score": 0 },
  "size_estimate": "S | M | L | XL",
  "ac_count": 0,
  "size_evidence": { "criterion": "A | B", "comparison_tickets": [], "risk_factors": [], "split": [] },
  "attachment_coverage": [{ "attachment": "<filename>", "kind": "design | data | other", "mapped_to": ["AC1"], "out_of_scope": [] }]
}
```

Note: `outcome: "ready"` here is this skill's own success signal; the loop
runner's `RunOutcome` type also has `"landed"` (used by `ticket-to-pr`) —
both map to a passing verdict, `ready` is simply the more accurate word for
what this skill produces (a ticket, not a PR). `cost_usd`/`tokens` are left
as `0`/zeros — the loop runner derives real values from `claude -p
--output-format json`'s own usage report. `log_version` is always
`"1.1"` as of this schema version — the loop runner stamps the same value
onto the `RunLogLine` it derives, regardless of what this field says
(`src/core/types.ts` owns `CURRENT_LOG_VERSION`, not this skill).
`size_trajectory` is only ever included on a passing (`outcome: "ready"`)
verdict, copied verbatim from `verifier-agent`'s report — see
`docs/skills.md`'s "Shadow-mode size telemetry" section. It is pure
telemetry: `src/core/verdict.ts`'s `parseSizeTrajectory` validates it
independently of the rest of this shape, and a malformed value is dropped
before it ever reaches `runs.jsonl` — it can never affect `outcome`.

`size_estimate` goes on every verdict, `ac_count` when known.
`size_evidence` is **required** on a `too_large` bounce and
`attachment_coverage` is **required** on `ready` when `attachments.json`
lists fetched files: the loop (`src/roles/research/verdict-checks.ts`)
refuses a verdict missing them and records the run as `agent_error`, so the
ticket runs again. (For a short warm-up period a missing
`attachment_coverage` is only logged; do not rely on it.)

## Invocation (for the loop runner)

```
claude -p "/ticket-refine <TICKET-KEY> run-dir=<abs RUN_DIR> repo-dir=<abs REPO_DIR>" --model sonnet --permission-mode acceptEdits --output-format json \
  --settings '{"claudeMdExcludes":["<repo root>/CLAUDE.md"]}' --append-system-prompt "<src/roles/research/stance.md>"
```

`src/worker/skill-runner.ts` builds this prompt from validated values only
(`src/core/build-prompt.ts`), creates `RUN_DIR` first, spawns from the
dev-loop repo root, and reads `RUN_DIR/verdict.json` afterwards. The repo
root's `CLAUDE.md` is the dev phase's executor stance, so it is excluded;
this phase's skeptic stance comes from `src/roles/research/stance.md`,
appended to the system prompt.

`--model sonnet` is explicit, not ambient-default. This skill originally ran
on `--model opus` for its own judgment calls (Interpret, synthesizing
Attack's findings, Scope, Synthesize), but in practice the *entire* session
— Triage, Ground's bookkeeping, every intermediate turn — paid Opus pricing
too, since a single continuous `claude -p` session bills every turn at one
model tier, not just the turns that need deep reasoning. That drove real
cost (Cost Tier Mix / Cost Economy) without a corresponding way to scope
Opus to just the four steps that needed it short of a larger re-architecture
(splitting into a Sonnet-tier orchestrator that calls out to Opus only for
specific steps). Switched to Sonnet for the whole session as the simpler
fix; if bounce/synthesis judgment quality visibly degrades on real tickets,
revisit — either back to Opus, or the split-orchestrator design. The
subagents it spawns (`recon-agent`, `devils-advocate-agent`,
`verifier-agent`) each pin their own model in their frontmatter regardless
of this invocation's tier. See `docs/skills.md` for the per-subagent model
rationale.
