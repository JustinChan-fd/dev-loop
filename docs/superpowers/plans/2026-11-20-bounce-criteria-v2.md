# Bounce Criteria v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Research bounces `too_large` only on grounded evidence (more than one deliverable, or a real risk to the dev limits judged against loop-written history), every design attachment becomes an AC or a named out-of-scope line, and the loop refuses research verdicts that skip either rule.

**Architecture:** The loop gains three mechanical pieces in tested TypeScript: diff stats recorded when dev lands (`diff_stats` on the dev PhaseEntry, read from `gh pr view`), a `size-context.json` written into every research RUN_DIR (`src/core/size-context.ts`), and a research verdict check (`src/roles/research/verdict-checks.ts`) run in `runResearchPhase` before the loop acts on the verdict. The judgment stays with the agent, and the skill and agent text tell it how to use the new facts and which fields to write.

**Tech Stack:** TypeScript (Node, `--experimental-strip-types` style `.ts` imports), vitest, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-11-20-bounce-criteria-v2-design.md`

## Global Constraints

- The pillar: agents judge, and the loop does the mechanics in plain TypeScript with tests. The loop never decides size. It only supplies facts and checks that the verdict has the required parts.
- Parsers never throw. A malformed new verdict field is dropped at the parse boundary, like `size_trajectory`. Only the two checks in Task 3 turn a verdict into an error or a bounce.
- Run logs stay append-only. The backfill writes a sidecar file and never rewrites `runs/**/*.jsonl`.
- "Plain loop unchanged": a project with no history gets `size-context.json` with empty stats plus its limits. A ticket with no attachments skips the coverage check entirely.
- Read `docs/skills.md` before editing `.claude/skills/*/SKILL.md` or `.claude/agents/*.md`. Read `docs/config.md` before touching `src/core/config.ts`, `src/core/types.ts`'s `Config`, or `pipeline.*.config.json`.
- `npm test`, `npm run test:hooks` and `npx tsc --noEmit` are green at the end of every task.
- Commit only on `feat/bounce-criteria-v2` and never use `--no-verify`. Never push without asking.
- Never read real env files. Never touch target repos.
- Spec values:
  - the coverage warn period is **5** ready verdicts on tickets with attachments (config value);
  - the file-count risk factor is "about 21 or more files";
  - a too_large verdict without grounding is refused from day one;
  - an unreadable attachment means a `blocked` bounce.

## Decisions this plan makes (my calls; the spec leaves them open)

1. **Diff stats come from GitHub, not local git:** `gh pr view <url> --json changedFiles,additions,deletions`. Dev's worktree may already be gone, and in a host-push run the commits were rebased. The PR is the fact.
2. **Backfill goes to a sidecar,** `runs/<generation>/<project>.diff-stats.json`, keyed by PR URL. `size-context.ts` merges it with the per-entry `diff_stats`.
3. **History window:** the 30 most recent landed tickets across the v1 and v2 dev logs, ordered by the landed run's `ended`. Per ticket, cost and minutes are the **sum of all its dev phase runs** (what the per-ticket cap sees). Median and p90 use nearest-rank.
4. **Grounding check:** progress.jsonl must have a line with `"phase":"ground"` and `"event":"phase_end"`.
5. **Unreadable attachment on a ready verdict:** the loop itself bounces `blocked`, naming the manifest lines, with a Jira comment. This is a fact from `attachments.json` and needs no judgment, so a rerun wouldn't help. It is enforced from day one, with no warn period, because the decision is the user's own.
6. **Coverage warn counter:** the count of earlier research phase entries with `verdict_check: "coverage_warned"` in the project's v2 log. Config key `roles.research.attachmentCoverageWarnRuns`, optional, default 5, integer ≥ 0.
7. **Size estimate on every run:** a new optional verdict field `size_estimate` (`S|M|L|XL`), written at Step 4 on every outcome. `size_trajectory` stays as it is.

## Review Focus

1. **A ticket with only non-design attachments,** such as a JSON response sample: coverage still requires an entry for every fetched file. Expected: the skill text lets the entry be `{ "attachment": "x.json", "kind": "data", "mapped_to": ["AC3"] }`, so nobody inventories a JSON file as UI. Test: `verdict-checks` accepts a `data` entry with ACs mapped.
2. **The manifest itself failed to list** (`error` set, `attachments: []`). Expected: treated as unreadable, so a ready verdict becomes a `blocked` bounce. It must not count as "no attachments". Test in Task 3.
3. **progress.jsonl missing or with garbage lines** on a too_large bounce. Expected: missing means no grounding, so the verdict is refused, and bad lines are skipped without a throw. Test in Task 3.
4. **A dev run that landed with `pr: null`,** or `gh` failing. Expected: no `diff_stats`, the entry is still recorded, the phase never throws, and the failure is logged. Test in Task 1.
5. **A filename in `attachment_coverage` that differs in case or path** from the manifest. Expected: match on the manifest `filename` exactly, and also accept the basename of `path`. Test in Task 3.

---

### Task 1: Diff stats when dev lands, plus backfill script

**Files:**
- Create: `src/core/diff-stats.ts`, `test/core/diff-stats.test.ts`, `scripts/backfill-diff-stats.mjs`
- Modify: `src/core/iteration-log.ts` (PhaseEntry), `src/roles/dev/phase.ts`, `src/worker/cycle-steps.ts:273-290`, `src/worker/context.ts` (WorkerDeps), `src/main.ts` (wiring), `test/roles/dev/phase.test.ts`

**Interfaces:**
- Produces:
  - `export interface DiffStats { files: number; additions: number; deletions: number }`
  - `export type PrDiffStatsFn = (prUrl: string) => Promise<DiffStats | null>`
  - `export function parsePrDiffStats(raw: string): DiffStats | null`
  - `export function realPrDiffStats(exec?: ExecGhFn): PrDiffStatsFn`
  - `PhaseEntry.diff_stats?: DiffStats`
  - `DevPhaseDeps.prDiffStats?: PrDiffStatsFn`
  - `WorkerDeps.prDiffStats?: PrDiffStatsFn`
  - `export function diffStatsSidecarPath(logPath: string): string`, which turns `…/x.jsonl` into `…/x.diff-stats.json`

- [ ] **Step 1: Write the failing tests**
  - `test/core/diff-stats.test.ts`:
    - `parsePrDiffStats('{"changedFiles":29,"additions":2400,"deletions":110}')` returns `{files:29, additions:2400, deletions:110}`;
    - malformed JSON returns `null`;
    - a missing field or a negative number returns `null`;
    - `realPrDiffStats(exec)` calls exec with `["pr","view",url,"--json","changedFiles,additions,deletions"]`;
    - an exec that throws makes it return `null`, never throw;
    - `diffStatsSidecarPath("runs/v2/webtarsthree.jsonl")` returns `"runs/v2/webtarsthree.diff-stats.json"`.
  - `test/roles/dev/phase.test.ts`:
    - "landed run records diff_stats from the PR": with `prDiffStats` returning `{files:3,additions:40,deletions:2}`, the entry has `diff_stats` equal to that, and the fn was called with the PR URL;
    - "a bounced run never asks for diff stats";
    - "prDiffStats returning null leaves no diff_stats and still lands";
    - "prDiffStats throwing leaves no diff_stats, still lands, and adds nothing to jira_sync_error".

- [ ] **Step 2: Run them to verify they fail**

  Run: `npx vitest run test/core/diff-stats.test.ts test/roles/dev/phase.test.ts`

  Expected: FAIL. The module can't be found, and `diff_stats` is undefined.

- [ ] **Step 3: Implement**
  - Write `diff-stats.ts`.
  - In `runDevPhase`, after the outcome handling, when `verdict.outcome === "landed" && verdict.pr`, call `deps.prDiffStats` inside a try/catch that swallows errors, and spread `diff_stats` into the returned entry.
  - Thread `prDiffStats` through `WorkerDeps` and `runPhase`.
  - In `main.ts`, wire `prDiffStats: realPrDiffStats()`.

- [ ] **Step 4: Write `scripts/backfill-diff-stats.mjs`**
  - Usage: `node scripts/backfill-diff-stats.mjs --project=<slug> [--dry-run]`.
  - It reads `runs/v1/dev/<slug>.jsonl` and `runs/v2/<slug>.jsonl`.
  - It collects the PR URLs of landed dev runs that have no `diff_stats`.
  - For each URL, it runs `gh pr view <url> --json changedFiles,additions,deletions`.
  - It merges the results into each generation's sidecar, `{ "<prUrl>": {files, additions, deletions} }`, keeping existing keys.
  - It writes only the sidecar files.
  - `--dry-run` prints the count and writes nothing.
  - The header comment states that it never rewrites the logs.
  - It is a one-off, so it gets no vitest test. It reuses the same parsing rules: inline a 10-line copy and add a comment pointing to `parsePrDiffStats`, because `.mjs` can't import the `.ts` without the loader. Ledger that ruling.

- [ ] **Step 5: Run the full gate**

  Run: `npm test && npm run test:hooks && npx tsc --noEmit`

  Expected: all green.

- [ ] **Step 6: Commit**: `feat(dev): record a landed PR's diff stats on the phase entry (+ one-off backfill)`

---

### Task 2: `size-context.json` for research

**Files:**
- Create: `src/core/size-context.ts`, `test/core/size-context.test.ts`
- Modify: `src/worker/skill-runner.ts` (deps + write next to project.json), `test/worker/skill-runner.test.ts`, `src/main.ts`, `src/core/types.ts` (`size_estimate`, `ac_count` on Verdict), `src/core/verdict.ts` (sanitize both), `src/core/iteration-log.ts` (PhaseEntry `size_estimate?`, `ac_count?`), `src/roles/research/phase.ts` (carry both through), `test/core/verdict.test.ts`, `test/roles/research/phase.test.ts`

**Interfaces:**
- Consumes: `DiffStats` and `diffStatsSidecarPath` from Task 1; `IterationRecord`/`PhaseEntry` and `readIterations`; the v1 `RunLogLine` (`src/core/types.ts`) via `readRunLog` (`src/core/runs-log.ts`); `resolveV1RunsLog`.
- Produces:
  ```ts
  export const SIZE_CONTEXT_WINDOW = 30;
  export interface SizeContextTicket {
    ticket: string; landed: string; cost_usd: number; minutes: number; dev_runs: number;
    qa_loops: number | null; files: number | null; additions: number | null; deletions: number | null;
    research_estimate: TShirtSize | null; ac_count: number | null;
  }
  export interface SizeContext {
    generated: string;
    limits: { dev_max_cost_per_run_usd: number; dev_run_timeout_min: number; max_cost_per_ticket_usd: number };
    window: number;
    stats: { tickets: number; cost_usd: { median: number; p90: number } | null; minutes: { median: number; p90: number } | null };
    tickets: SizeContextTicket[];  // newest first
  }
  export interface DevRunFact { ticket: string; started: string; ended: string; outcome: string; cost_usd: number; verify_loops: number | null; pr: string | null; diff_stats: DiffStats | null }
  export interface ResearchFact { ticket: string; ended: string; size_estimate: TShirtSize | null; ac_count: number | null }
  export function buildSizeContext(i: { devRuns: DevRunFact[]; research: ResearchFact[]; sidecar: Record<string, DiffStats>; config: Config; now: Date; window?: number }): SizeContext
  export function nearestRank(sorted: number[], p: number): number
  export async function loadSizeContext(slug: string, config: Config, now: Date, root?: string): Promise<SizeContext>
  ```
  - `SkillRunnerDeps.sizeContext?: () => Promise<SizeContext>`
  - `Verdict.size_estimate?: TShirtSize` and `Verdict.ac_count?: number`
  - PhaseEntry carries both.

- [ ] **Step 1: Write the failing tests** (`test/core/size-context.test.ts`)
  - "no history gives empty stats plus the limits": with `devRuns: []` against the fixture config, the result `toEqual` `{ generated: now.toISOString(), limits: {dev_max_cost_per_run_usd: 20, dev_run_timeout_min: 75, max_cost_per_ticket_usd: <fixture>}, window: 30, stats: {tickets: 0, cost_usd: null, minutes: null}, tickets: [] }`.
  - "sums every dev run of a landed ticket": an error run ($2, 10 min) then a landed run ($3, 20 min) on T-1 gives `cost_usd: 5, minutes: 30, dev_runs: 2, qa_loops` from the landed run.
  - "a ticket with no landed dev run is left out".
  - "keeps only the newest `window` tickets, newest first": 3 tickets with `window: 2` keeps the 2 latest by landed `ended`.
  - "diff stats come from the entry, else the sidecar by PR URL, else null".
  - "research estimate is the latest research fact for that ticket".
  - "median and p90 by nearest rank": `nearestRank([1,2,3,4,5,6,7,8,9,10], 0.5) === 5` and `nearestRank([...], 0.9) === 9`. Stats over costs [1..10] give `{median: 5, p90: 9}`.
  - "minutes are rounded to one decimal".

  In `test/core/verdict.test.ts`:
  - `size_estimate: "M"` is kept, `"XXL"` is dropped, and the outcome stays `ready`;
  - `ac_count: 7` is kept, while `-1`, `"7"` and `1.5` are dropped.

  In `test/roles/research/phase.test.ts`:
  - a bounced verdict with `size_estimate: "L"` gives an entry with `size_estimate: "L"`.

  In `test/worker/skill-runner.test.ts`:
  - "writes RUN_DIR/size-context.json for research only, before the spawn": with `sizeContext` returning a fixed object, the research run dir has the file `toEqual` that object, and a dev run has no file;
  - "a sizeContext that throws is logged and the run still spawns".

- [ ] **Step 2: Run them to verify they fail**

  Run: `npx vitest run test/core/size-context.test.ts test/core/verdict.test.ts test/roles/research/phase.test.ts test/worker/skill-runner.test.ts`

  Expected: FAIL. The module is missing, and the new fields are absent.

- [ ] **Step 3: Implement**
  - `buildSizeContext` is pure.
  - `loadSizeContext` reads the v2 log, the v1 dev log (when `resolveV1RunsLog("dev", slug)` finds one) and both sidecars, missing ones counting as `{}`. It maps them to `DevRunFact` and `ResearchFact`; v1 research lines have no `size_estimate`, so they use `size_trajectory?.step4_tshirt ?? null`. It never throws: on any read error it returns `buildSizeContext` with empty inputs.
  - `limits` comes from `config.roles.dev.ceilings` and `config.ceilings.maxCostPerTicketUsd`.
  - Sanitize `size_estimate` and `ac_count` in `parseVerdict` as optional telemetry (`ac_count` is a non-negative integer).
  - In `makeRunSkill`, when `role === "research" && deps.sizeContext`, write `size-context.json` right after `project.json` inside a try/catch that calls `logError`.
  - In `main.ts`, wire `sizeContext: () => loadSizeContext(slug, config, new Date())`.

- [ ] **Step 4: Run the full gate**

  Run: `npm test && npm run test:hooks && npx tsc --noEmit`

  Expected: green.

- [ ] **Step 5: Commit**: `feat(research): write RUN_DIR/size-context.json from landed dev history; log size_estimate on every run`

---

### Task 3: Research verdict checks

**Files:**
- Create: `src/roles/research/verdict-checks.ts`, `test/roles/research/verdict-checks.test.ts`
- Modify: `src/core/types.ts` (`SizeEvidence`, `AttachmentCoverageEntry` on Verdict; config key), `src/core/verdict.ts` (sanitize the shapes), `src/core/config.ts` (validate `roles.research.attachmentCoverageWarnRuns`), `src/core/iteration-log.ts` (PhaseEntry `size_evidence?`, `verdict_check?`), `src/roles/research/phase.ts`, `src/worker/cycle-steps.ts`, `test/roles/research/phase.test.ts`, `test/core/config.test.ts`, `test/core/verdict.test.ts`

**Interfaces:**
- Consumes: `AttachmentManifest` (`src/core/attachments.ts`) and `ctx.records`.
- Produces:
  ```ts
  export interface SizeEvidence { criterion: "A" | "B"; comparison_tickets: string[]; risk_factors: string[]; split?: string[] }
  export interface AttachmentCoverageEntry { attachment: string; kind: "design" | "data" | "other"; mapped_to: string[]; out_of_scope: string[] }
  // Verdict: size_evidence?: SizeEvidence; attachment_coverage?: AttachmentCoverageEntry[]
  export type VerdictCheck = "too_large_ungrounded" | "too_large_no_evidence" | "coverage_missing" | "coverage_warned" | "attachment_unreadable";
  export interface ResearchFacts { progressRaw: string | null; manifest: AttachmentManifest | null; coverageWarnsSoFar: number; coverageWarnRuns: number }
  export type CheckResult =
    | { action: "accept"; check?: "coverage_warned"; note?: string }
    | { action: "refuse"; check: VerdictCheck; detail: string }       // -> agent_error
    | { action: "bounce_blocked"; check: "attachment_unreadable"; detail: string };
  export function checkResearchVerdict(v: Verdict, facts: ResearchFacts): CheckResult
  export function groundCompleted(progressRaw: string | null): boolean
  export function readResearchFacts(runDir: string, coverageWarnsSoFar: number, coverageWarnRuns: number): Promise<ResearchFacts>
  // ResearchPhaseDeps: coverageWarnsSoFar: number; coverageWarnRuns: number; readFacts?: (runDir) => Promise<ResearchFacts>
  // PhaseEntry: size_evidence?: SizeEvidence; verdict_check?: VerdictCheck
  // Config.roles.research.attachmentCoverageWarnRuns?: number   (default 5, integer >= 0)
  ```

- [ ] **Step 1: Write the failing tests** (`test/roles/research/verdict-checks.test.ts`)
  - "too_large without a ground phase_end is refused": `{outcome:"bounced", failure_category:"too_large"}` with progress holding only triage lines gives `{action:"refuse", check:"too_large_ungrounded"}`, and the detail mentions `ground`.
  - "too_large with grounding but no size_evidence is refused" gives `too_large_no_evidence`.
  - "too_large criterion A needs a split of 2+ parts": a split of length 1 is refused as `too_large_no_evidence`.
  - "too_large criterion B needs at least one comparison ticket and one risk factor".
  - "too_large grounded with evidence is accepted".
  - "missing progress.jsonl counts as ungrounded"; "garbage lines are skipped, not thrown": `groundCompleted("not json\n{\"phase\":\"ground\",\"event\":\"phase_end\"}")` is `true`.
  - "ready with a skipped attachment bounces blocked, naming it": the manifest entry `{filename:"build.zip", status:"skipped", reason:"type .zip is not fetched"}` gives `{action:"bounce_blocked"}`, and the detail contains `build.zip` and `type .zip is not fetched`.
  - "ready when the manifest failed to list bounces blocked" (Review Focus 2).
  - "ready with no fetched attachments needs no coverage": accepted with no `check`.
  - "ready with fetched attachments and no coverage warns while under the warn count": with `coverageWarnsSoFar: 4, coverageWarnRuns: 5`, the result is `{action:"accept", check:"coverage_warned"}`.
  - "…and is refused once the count is reached": with `coverageWarnsSoFar: 5`, the result is `{action:"refuse", check:"coverage_missing"}`, and the detail names the uncovered file.
  - "coverage must name every fetched attachment": two fetched files, one covered, gives `coverage_missing` (or the warn result), naming the missing one.
  - "coverage matches by filename or path basename" (Review Focus 5).
  - "a data attachment entry with mapped_to counts" (Review Focus 1).
  - "an entry with neither mapped_to nor out_of_scope does not count".
  - "bounced verdicts other than too_large and error verdicts are accepted untouched".
  - "coverageWarnRuns 0 refuses from the first run".

  In `test/roles/research/phase.test.ts`:
  - "a refused verdict becomes an agent_error entry with verdict_check and no Jira transition": `outcome:"error"`, `failure_category:"agent_error"`, the detail starts `"loop refused the verdict: "`, and `transitionStatus` is not called.
  - "bounce_blocked moves the ticket to bounced and comments the manifest lines": `outcome:"bounced"`, `failure_category:"blocked"`, `transitionStatus` called with the bounced status, and `addComment` called once.
  - "coverage_warned lands and records verdict_check".
  - "an accepted too_large bounce records size_evidence".

  In `test/core/config.test.ts`:
  - `attachmentCoverageWarnRuns` absent is valid;
  - `0` and `5` are valid;
  - `-1`, `1.5` and `"5"` are rejected with a message naming the key.

  In `test/core/verdict.test.ts`:
  - a malformed `size_evidence` or `attachment_coverage` is dropped and doesn't flip the outcome. Absent evidence is what the check then refuses.

- [ ] **Step 2: Run them to verify they fail**

  Run: `npx vitest run test/roles/research test/core/config.test.ts test/core/verdict.test.ts`

  Expected: FAIL. The module is missing, and the config key is rejected as unknown.

- [ ] **Step 3: Implement**
  - Write `verdict-checks.ts`. Check order: errors and non-too_large bounces pass, then the too_large checks, then for `ready`: unreadable attachments (skipped, failed, or a manifest `error`) first, then coverage.
  - `readResearchFacts` reads `progress.jsonl` and `attachments.json`, using null on ENOENT or bad JSON, and never throws.
  - In `runResearchPhase`, after parsing, run the check. On `refuse`, replace the verdict with `agentErrorVerdict("loop refused the verdict: " + detail)`, keeping the measured cost. On `bounce_blocked`, set `outcome` to `bounced`, `failure_category` to `blocked` and `detail` to the check detail, and post one Jira comment (a plain ADF paragraph: "Research bounced: blocked. An attachment could not be read: <detail>. Fix the attachment (type/size/access) and re-label; the ticket text does not need rewriting.") before the transition. Comment and transition errors go to `jira_sync_error`.
  - In `cycle-steps.ts`, compute `coverageWarnsSoFar` as the number of research phase entries in `ctx.records` with `verdict_check === "coverage_warned"`, and `coverageWarnRuns` as `config.roles.research.attachmentCoverageWarnRuns ?? 5`.
  - Add the key to the `keys(research, …)` optional list in `config.ts` and validate it as an integer ≥ 0. Add the field to the example configs' docs only, not to the `pipeline.*.config.json` files, since the default applies.

- [ ] **Step 4: Run the full gate**

  Run: `npm test && npm run test:hooks && npx tsc --noEmit`

  Expected: green.

- [ ] **Step 5: Commit**: `feat(research): the loop checks too_large grounding/evidence and attachment coverage before acting on a verdict`

---

### Task 4: Skill and agent text

**Files:**
- Modify: `.claude/skills/ticket-refine/SKILL.md`, `.claude/agents/verifier-agent.md`, `.claude/agents/qa-agent.md`
- Read first: `docs/skills.md`

**Interfaces:**
- Consumes: the verdict field names from Tasks 2 and 3 (`size_estimate`, `ac_count`, `size_evidence`, `attachment_coverage`) and the file `RUN_DIR/size-context.json` (shape from Task 2).

- [ ] **Step 1: ticket-refine SKILL.md**
  - **Ticket attachments** paragraph (around line 146):
    - any `skipped` or `failed` entry, or a manifest `error`, is a `blocked` bounce naming the file and the reason (and the loop enforces it);
    - at Triage, inventory every design attachment.
  - **New subsection, "Attachment inventory"** (Step 2 Ground):
    - inventory depth by kind, per spec Decision 3: a new component or screen lists everything plus layout; a change to an existing one lists the delta against the current component, read during grounding; styling gets one line plus a QA note;
    - mockup variants not chosen by the ticket are `spec_ambiguous`.
  - **Step 4, rewritten:**
    - runs after Ground;
    - reads `RUN_DIR/size-context.json`;
    - too_large only on criterion A (two or more separately mergeable deliverables, with a drafted split) or B (a real risk to the limits: name the comparison tickets from size-context and the risk factors from the spec list, including "about 21 or more files");
    - AC count alone is never evidence;
    - trimming ACs that restate existing behaviour is refining, not bouncing;
    - a design choice inside one deliverable is `spec_ambiguous` with options A and B;
    - a person's scope ruling in a steering comment is final;
    - write `size_estimate` every run, replacing the `step4_tshirt` progress note with the verdict field and keeping the note too, for history.
  - **Step 6 Synthesize:**
    - map each inventory item to an AC or an "Out of scope: X (shown in the mockup)" line;
    - delete any blanket "the spec wins" wording;
    - layout ACs say where things sit;
    - new controls name the repo component or explicitly allow a native one;
    - QA notes name the POC element.
  - **Definition of ready:**
    - item 4 becomes "size per Step 4 criteria A/B";
    - item 8's last sentence becomes "AC count is a note for Step 4, never a too_large signal on its own";
    - add item 9, "every fetched attachment is in `attachment_coverage`".
  - **verdict.json schema:** add `size_estimate`, `ac_count`, `size_evidence` (required on too_large) and `attachment_coverage` (required on ready when attachments were fetched), with one example each, and a sentence saying the loop refuses a verdict missing them.

- [ ] **Step 2: verifier-agent.md**
  - It reads `RUN_DIR/attachments.json` and the fetched design files, alongside draft-spec.md.
  - Item 4 refers to criteria A/B, not a feel for size.
  - Item 8 drops the "more than roughly 10 is a too_large signal" sentence.
  - New item 9, attachment coverage: every inventory item maps to an AC or to a named out-of-scope line, and there is no blanket "spec wins". A gap fails the check.

- [ ] **Step 3: qa-agent.md** (around line 75)
  - For a visual AC, findings name the POC element the AC came from.
  - QA notes say what to compare against.

- [ ] **Step 4: Check the text against the code**

  Run: `grep -n "size_evidence\|attachment_coverage\|size_estimate\|size-context.json" .claude/skills/ticket-refine/SKILL.md .claude/agents/verifier-agent.md && grep -n "spec wins\|this spec wins" .claude/skills/ticket-refine/SKILL.md`

  Expected: the first grep hits in both files, and the second grep returns nothing.

- [ ] **Step 5: Run the full gate**

  Run: `npm test && npm run test:hooks`

  Expected: green. Hook tests may lint the skill files.

- [ ] **Step 6: Commit**: `docs(research): too_large criteria A/B, attachment inventory and coverage in ticket-refine, verifier and qa-agent`

---

### Task 5: Docs, guide, CHANGELOG

**Files:**
- Modify: `docs/skills.md` (definition-of-ready, size telemetry, verdict contract), `docs/logging.md` (`diff_stats`, `size_estimate`, `size_evidence`, `verdict_check`, the sidecar, `size-context.json` in the run dir layout), `docs/config.md` (`attachmentCoverageWarnRuns`), `docs/guide/how-dev-loop-works.html` (the research steps in the `DATA` block: "size against recent history", "attachments → ACs"), `docs/future-enhancements.md` (UI snapshots, the already-merged check, the research test-design fixes, each with the spec's evidence), `CHANGELOG.md` (`[core]`, `[research]` and `[dev]` bullets, plus the pillar check below as the bends note), the spec status line ("APPROVED, implemented by plans/2026-11-20-bounce-criteria-v2.md")

- [ ] **Step 1: Write the docs.**

- [ ] **Step 2: Check them**

  Run: `grep -c "attachmentCoverageWarnRuns" docs/config.md && grep -c "diff_stats" docs/logging.md && grep -n "snapshot" docs/future-enhancements.md`

  Expected: each grep finds something.

- [ ] **Step 3: Pillar check** (CLAUDE.md). For each task, mark each pillar as breaks, bends or fine.
  - **Expected bend:** the loop turning a ready verdict into a `blocked` bounce in Task 3 is a loop-made outcome. It's acceptable because it acts only on the attachment manifest the loop wrote itself. Record it in the CHANGELOG.
  - **"Plain loop unchanged":** confirm that a project with no history and no attachments sees one extra file and no behaviour change.

- [ ] **Step 4: Run the full gate**

  Run: `npm test && npm run test:hooks && npx tsc --noEmit`

  Expected: green.

- [ ] **Step 5: Commit**: `docs: bounce criteria v2 (skills, logging, config, guide, changelog, future enhancements)`

---

## After the plan (the user, not the executor)

- Run `node scripts/backfill-diff-stats.mjs --project=webtarsthree --dry-run`, then for real. It calls `gh` against the target repo, read-only.
- The first live research runs on attachment-bearing MC tickets will show whether the `coverage_warned` count climbs or the agent writes the map.
