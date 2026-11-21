# Bounce criteria v2: draft for review

Status: APPROVED 2026-11-20. Plan: docs/superpowers/plans/2026-11-20-bounce-criteria-v2.md. Written from four read-only reviews: the log numbers, an audit of all 28 research bounces, the rules as written today, and an MC-1435 case study.

## Why

The v1 size rule is "the work fits the small/medium bound", plus "more than about 10 behaviour ACs means consider a split" (ticket-refine SKILL.md:592, 603-611; verifier-agent.md:45-67). That was a fine first step, but the AC count is the only number the rules give, so agents fall back on it.

What happened:

- **The too_large bounces were rarely right.** There were 3 to 4 too_large bounces out of 94 research runs, and only TARS-1554 was really too big: dev cost $17.68 over 79 minutes, above the p90.
  - MC-1435 bounced as XL after 86 seconds with no grounding phase. Once trimmed, dev landed it for $1.73 in 8.5 minutes.
  - TARS-1389 was really a choice between two designs, not a size problem.
  - The second TARS-1554 bounce re-bounced a scope you had already ruled on.
- **AC count is a weak predictor.** Its rank correlation with cost is 0.49. Lines changed correlate at 0.62 with cost and 0.78 with time. Research cost correlates at 0.72 with dev cost. The expensive tail comes from QA churn on async or stateful work (TARS-1399, TARS-1490), not from AC count.
- **Big is not the same as expensive.** MC-1435 touched 29 files and about 2,500 lines for $1.73. Cost per ticket also dropped sharply in November with the new model and v2, so any thresholds have to come from recent history, not a fixed number.
- **Most real bounces are spec_ambiguous.** There were 23, and they were mostly good. A person could act on them in one pass.
- **Attachments are a hole.** Four of the six fixes you made on PR #237 were things the POC showed but no AC covered: "Show every offer", the tile layout, the logo border, and the even tags. The spec said "The mockup shows intent; where it differs from this spec, this spec wins." Dev trusts the ticket, and QA checks against the ACs, so nothing caught the gap.

## Goals

1. Research bounces as too_large only for something a person really has to decide about size: the ticket holds several separately shippable things, or it carries a real risk of running past the project's dev limits.
2. The agent gets the facts it needs to judge size: the dev limits, recent landed costs, and similar past tickets. The loop writes these, not the agent.
3. Everything an attachment shows becomes an AC, or is listed as out of scope by name. Nothing gets dropped silently.
4. The loop checks the verdict against these rules and refuses a verdict that skips them.

Not goals:

- A formula that decides bounces. The agent still judges.
- Changing dev's "trust the ticket" stance.
- Fitting thresholds on today's small sample.

## The new criteria (the agent judges)

### too_large, redefined

Bounce too_large only after grounding, and only when one of these holds:

- **A. More than one deliverable.** The ticket holds two or more changes that could each merge alone and add value. The bounce must include a drafted split where each part is a workable ticket.
- **B. Real risk to the limits.** Judged against `size-context.json` (below): the grounded plan looks like the landed tickets that came near or past the project's p90 cost or time, or near the per-run or per-ticket caps. The bounce must name the comparison tickets and the risk factors. Risk factors include:
  - new infrastructure with nothing to reuse;
  - async, race-prone or stateful UI;
  - more than one service or repo;
  - a planned change well above the size where cost climbs in the stats (about 21 or more files today).

AC count alone is never evidence for too_large. The agent may cut ACs that only repeat behaviour the code already has; that's refining, not a bounce.

### Other categories

- **A choice between designs inside one deliverable is spec_ambiguous, not too_large.** The bounce lays out the options as A and B.
- **A scope ruling from a person is final.** Once a steering comment rules on scope ("accept as scoped", or picking ticket A), size is a note for that ticket, never a bounce.
- **Mockup variants have to be named.** When a mockup offers variants (A, B, C) and the ticket doesn't say which one, that's a spec_ambiguous question. The agent doesn't quietly take the mockup's default.

### Attachments become ACs

1. **Inventory every design attachment** (mockup HTML, PNG, POC). List each visible element and interaction: expanders, toggles, tables, layout rows, borders, states.
2. **Map each inventory item** to an AC, or to an "Out of scope: X (shown in the mockup)" line. The blanket "spec wins" clause goes. Each place the spec differs from the mockup is stated with its reason.
3. **Layout ACs say where things sit**, citing the mockup's CSS or structure, not only what's there.
4. **New controls name the repo's own component**, for example `components/shadcn/select.tsx`, or explicitly allow a native one.
5. **The verifier gets the attachments and checks coverage.** This becomes item 9 on its checklist.
6. **QA notes name the POC element** for each visual AC, so a person checking knows what to compare against.

## What the loop does (tested TypeScript)

1. **Write `RUN_DIR/size-context.json` for research**, next to `project.json` in `makeRunSkill` (`src/worker/skill-runner.ts`). New file: `src/core/size-context.ts`. It contains:
   - the dev role's per-run limits (cost and minutes) and the per-ticket cap from the project config;
   - recent landed dev runs for the project: median and p90 of cost and minutes. A window of recent runs keeps the model change from skewing the numbers;
   - per landed ticket: cost, minutes, QA loops, files and lines changed, research's size estimate, and AC count if recorded;
   - research's estimate next to the actual cost for recent tickets.
2. **Record files and lines changed when dev lands**, in the phase entry (`src/core/iteration-log.ts`). The loop already has git. This feeds item 1 from then on. The older webtarsthree history can be backfilled once, with a script.
3. **Check the research verdict** (`src/core/verdict.ts`, `src/roles/research/phase.ts`). The loop refuses the verdict and logs an agent error rather than acting on it when:
   - a too_large verdict has no ground phase in progress.jsonl, or has no `size_evidence` (whether it's criterion A or B, the comparison tickets, the risk factors);
   - a ready verdict lacks `attachment_coverage` with an entry for every fetched attachment.
4. **Log the size estimate on bounced runs too**, not only passing ones, so estimate against actual can be compared.
5. *(Later, not this change.)* **Check whether the work is already merged before either phase starts**, by searching git and GitHub for the ticket key. A merged PR stops the run with a clear message. This would have saved the repeat runs on TARS-1465, TARS-1473 and TARS-1487.

## Skill and agent text to change

- `ticket-refine` SKILL.md:
  - Rewrite Step 4: size after Ground, using `size-context.json`, criteria A and B.
  - Definition-of-ready items 4 and 8: AC count becomes a note only.
  - Add the attachment inventory step: read at Triage, map at Synthesize.
  - Add the rule that a scope ruling is final.
  - Add the design-choice and mockup-variant rules.
  - Add the new verdict fields.
- `verifier-agent.md`: it gets the attachments; add item 9 (coverage); remove the AC-count advisory.
- `qa-agent.md`: QA notes name the POC element for visual ACs.
- `docs/skills.md`, `docs/logging.md`, the guide page, and the CHANGELOG.

## Decisions

1. **An unreadable attachment is a bounce.** (Yours.) An attachment on a ticket is a resource the ask rests on. If the loop lists one as `skipped` or `failed`, research bounces and names the file and the reason from `attachments.json`. It never guesses around it.
   - My call on the category: `blocked`. Step 5 already defines `blocked` as "can't proceed however well it's specified (missing access)". It also tells you to fix the input, not rewrite the ticket.
2. **How strict the verdict checks are.** (My call; you weren't sure.)
   - **A too_large bounce with no grounding: refused from the start.** It's rare, cheap to detect, and exactly the MC-1435 failure. The refusal is an agent error, so the ticket runs again.
   - **A ready verdict with no attachment coverage: warn first.** For the first 5 ready verdicts on a ticket that has attachments, the loop logs a warning and still accepts the verdict. After that it refuses. This lets us check that the skill text gets the agent writing the map before a missing map costs a run.
   - The count of 5 is a config value.
3. **The attachment inventory depends on what the ticket builds.** (Yours, made concrete.)
   - **New component or screen:** every element and interaction the mockup shows, plus its layout structure, becomes an AC or a named out-of-scope line.
   - **A change to something that exists:** only the difference between the mockup and today's UI. Research reads the current component during grounding and lists what the mockup adds, removes or moves. Unchanged parts need nothing.
   - **Pure styling** (colours, exact spacing) on either kind is one line, "visual styling follows the mockup", backed by a QA note that names the elements.
4. **Scope:** as proposed. (Yours.)
   - **This change:** criteria A and B, `size-context.json`, diff stats, the verdict checks, the attachment inventory.
   - **Later:** the already-merged check (item 5 under "What the loop does" moves out of this change), and the research test-design fixes.

## Not in this change: UI snapshots

There's no way yet to compare the running UI with a mockup screenshot. The blocker is login and auth on the target apps. That's its own piece of work, and it goes in `docs/future-enhancements.md`. Until then, the QA note naming the POC element is how a person checks visual ACs.

## Pillar check (so far)

- **Agents judge:** fine. The agent still makes the size call; the loop only supplies the facts and checks the verdict has the required parts.
- **The loop does the mechanics:** fine. The stats, diff stats and verdict checks are plain TypeScript with tests.
- **The handoff is a contract:** stronger. The verdict gains required evidence fields, and the loop refuses one that's missing them.
- **A bounce beats a guess:** fine. Too_large becomes rarer, but ambiguity still bounces, and the attachment coverage rule means fewer silent guesses.
- **Plain loop unchanged:** to be checked. `size-context.json` is extra input, and a project with no history gets empty stats plus its limits.
- **TDD:** applies to all the TypeScript work.
