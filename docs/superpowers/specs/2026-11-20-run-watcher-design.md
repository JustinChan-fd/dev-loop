# Run watcher: a local, read-only live dashboard for dev-loop

Status: **POC build approved 2026-11-20; merge pending user review.** Built
overnight on `feat/run-watcher` (off main at `4a59aaa`). Plan:
[2026-11-20-run-watcher](../plans/2026-11-20-run-watcher.md). The
interactive mockup is the visual source of truth:
[2026-11-20-run-watcher-mockup.html](2026-11-20-run-watcher-mockup.html)
(its Scenario, Width and Theme switches and its demo data are mockup only).

## Calls made overnight

No human was available. Every call below is the builder's; each can be
overridden in review. Nothing here changes *what* is built, so no question
stopped the build.

1. **Data root: `--root=<dir>`** (default: this checkout's root), as in
   `npm run stats`. It is where `runs/v2`, `.pipeline/v2` and the
   `pipeline.*.config.json` files are read from. It exists so the
   dashboard can watch another checkout (it was checked against a
   read-only copy of the real logs this way).
2. **Project name vs. slug.** `--project=<name>` takes the config name
   (`pipeline.<name>.config.json`, as `npm run loop` does). The v2 paths use
   the slug from `targetRepo.url` (`repoSlugFromUrl`), so `--project=eval`
   watches `dev-loop-eval-sandbox`. With no `--project`, every config except
   `pipeline.loop.config.json` is watched.
3. **Step lists are read from the skills.** Each SKILL.md declares its
   `progress.jsonl` phase names in one line (`"phase": "triage|interpret|…"`).
   The server reads that line from `.claude/skills/<skill>/SKILL.md` at
   start. When it can't, it uses a fallback copy of today's lists. Any phase
   a run logs that isn't in the list is added after it, in the order seen.
   Dev's real list is `intake, plan, red, green, verify, pr`, not the
   mockup's `intake, red, green, qa, pr`.
4. **Where a finished run ended** is the `phase` of its last
   `progress.jsonl` line, not the record's `phase_reached`. Research maps its
   8 steps onto the shared 6-value enum (`ground` → `plan`), so
   `phase_reached` can't name the step. The server reads each finished run's
   progress file once and caches it by size and mtime (a finished file never
   changes), and sends only the end step and the line count. The lines go to
   the page only when Show log is opened. When the file is gone, the end
   step is `phase_reached` if that is one of the steps, and the card says the
   log is gone.
5. **What counts as a run.** A run is one phase entry in `runs/v2` (one
   phase on one ticket), plus a `parked` record's refused run (outcome
   Parked, from `parked.run_dir`). Records with no phase and no park
   (`skipped-blocked`, `claim-error`, `handoff-*`, `interrupted`,
   `resume-dropped`, `blocked-attempts`, `unparked`) are not runs and don't
   get a card.
6. **Live runs.** A run is live when a `sessions/<name>.lock` names it in
   `inFlight` and the lock's pid is alive (`isProcessAlive` from
   `src/core/session.ts`, which only sends signal 0). A lock with a dead pid
   is shown as a warning line ("dev-1's lock names TARS-1 dev, but its
   process is gone; the loop records it on its next start"), never as a
   running card. A run that is both live and in the log shows once, as
   finished.
7. **Lock parsing** lives in `src/dashboard/` (it reuses `TICKET_KEY`,
   `SESSION_ID` and `isProcessAlive`), because `session.ts`'s own parser is
   private and the loop's code stays unchanged.
8. **Cost so far** for a live run reads "not yet": `usage.json` is written
   only when the run ends. **Commit** is left out: no structured field holds
   the commit SHA (it is only in free-text notes).
9. **Jira link:** `JIRA_BASE_URL` from the environment of the dashboard
   process, when set. The `dashboard` script doesn't load the env file, so
   the Jira token never enters the dashboard process. Without it, the key is
   plain text.
10. **GitHub issue link: left out.** No file on disk records the mirror
    Issue's number (the loop looks it up with `gh issue list` each run;
    it only shows up in free-text notes). The PR link comes from the phase
    entry's `pr`, and only an `https://github.com/` URL is linked.
11. **Watching.** `fs.watch` is set on `runs/v2`, each watched project's
    `sessions/` dir and each live run dir, not recursively on all of
    `.pipeline/v2`, because `.pipeline/v2/<project>/repo` can be a full
    clone with `node_modules`. The 2-second poll covers everything else (a
    new run dir always shows up through its lock first). A snapshot is
    pushed over SSE only when it changed.
12. **Quiet** (5 minutes with no progress line) is computed by the server,
    so a run turns quiet on the next poll. The page ticks only the clocks
    ("6:32 elapsed", "3m ago") itself, once a second.
13. **Show log** asks the server for one run by its run dir. The server
    answers only for a run dir in its current snapshot (an allowlist), so
    the endpoint can't read any other file. Lines are grouped by step on
    the server (`groupLog`).
14. **Fonts.** The page asks for Atkinson Hyperlegible Next and Mono by
    name and falls back to system fonts. It doesn't load Google Fonts, so
    the page makes no outside request.
15. **Host check.** Besides binding to 127.0.0.1, the server answers only
    requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`, so a
    web page can't reach it through DNS rebinding.
16. **Read-only is tested.** A structure test fails if any file in
    `src/dashboard/` calls a write, rename, delete or mkdir function, spawns a
    process, or calls `fetch`.
17. **Batch view**: the empty state only ("Batch runs will show here …"),
    since no batch file exists yet.
18. **Timeline Window** keeps the mockup's 1 hour, 4 hours and 24 hours,
    default 1 hour. With one worker running occasionally, an empty window is
    common; the empty state says to try a longer one.

## Builder checks (answered against the code, 2026-11-21)

- **Step lists.** Declared in each skill's progress-line format:
  `ticket-refine` SKILL.md "triage|interpret|ground|attack|scope|blocked-check|synthesize|verify";
  `ticket-to-pr` SKILL.md "intake|plan|red|green|verify|pr". There is no
  `qa` step (QA runs inside `verify`). Real runs skip steps (MC-1435's dev
  run logged intake, red, green, pr), and research often writes several
  `phase_end` lines in the same second, so a step can be "done" without a
  `phase_start`. See calls 3 and 4.
- **Jira site URL.** Only in the `JIRA_BASE_URL` env var
  (`src/core/jira-client.ts` `loadJiraCredentials`), loaded from the env
  file by the loop's npm script. It is not in any config or run file. See
  call 9.
- **GitHub issue number.** Not on disk. `main.ts` `ensureMirrorIssue` and
  ticket-refine Step 0.5 find it with `gh issue list` each time; nothing
  writes the number to the record, the run dir or a cache. See call 10.
- **sbx progress.** sbx mounts dev-loop's own folder
  (`sandboxMounts` in `src/worker/skill-runner.ts`: the repo root, plus the
  target repo when outside it), and the run dir is inside it. So a
  sandboxed run's `progress.jsonl` is written to the host run dir as it
  runs, not at the end, and shows live like any other.
- **History depth.** The loop only appends to `runs/v2/<project>.jsonl`; it
  is never rotated or trimmed. Only `npm run reset-project` rewrites it: it
  moves the reset ticket's records to `runs/v2/<project>.reset-archive.jsonl`
  (not shown) and deletes that ticket's run dirs. So "All time" means every
  v2 run not reset away, and a record whose run dir is gone (a partial reset
  or a hand-cleaned dir) shows "log gone" with the record's detail.
- **Subagent filter.** Not built (deferred, as decided).

## Intent

The user wants to watch the loop work in real time: which tickets are
running, which step each is on, and what has finished, bounced, errored,
stopped or parked, with enough context to see *where* a run broke. It is
**display only**. It never triggers, writes, moves Jira, or touches a lock.

It has to be useful today, when one worker runs one ticket at a time, and
still make sense once batch/stack mode lands (v2 design §8) and several
workers run at once.

## Goals

- Show live runs updating as each `progress.jsonl` line is written, with no
  manual refresh.
- Make every finished run say where along its steps it ended and how.
- Let the user expand any run to read its full log, line by line, grouped
  by step.
- Work docked in a corner of the screen (about 480px wide minimum) and full
  screen.
- Filter by project, phase (research or dev), worker and outcome.
- Cover **all v2 runs, not only recent ones**: a time filter on the Runs view
  (default: last 12 hours) reaches back through the full history.
- Link each run to its Jira ticket, its GitHub issue and, once there is one,
  its PR.

## Non-goals

- Collapsed finished cards. Cards stay fully expanded for now; collapsing
  them when there are many is deferred to later (add it to
  `docs/future-enhancements.md`).
- **v2 only.** It reads `.pipeline/v2/` and `runs/v2/` and nothing else.
  The pre-2.0.0 `v1` trees (`.pipeline/v1/`, `runs/v1/`) are out of scope:
  no reader, no toggle, no merged history. "All time" means all of v2.
- No controls: no start, stop, retry, reset or Jira/GitHub writes. (Possible
  later, as a separate design.)
- No remote access. It binds to `127.0.0.1` only.
- No sandbox CPU or memory charts. sbx's own dashboard covers that.
- No new dependencies.

## Anti-goals (a failure even if it works)

- The loop or a skill changes its behavior to suit the dashboard, beyond
  writing a file the loop owns (the batch file below).
- It shows a bounce as a failure. A bounce with evidence is a correct
  outcome, so it gets its own calm indigo, never red.
- It guesses at state. When a file is missing or unreadable, it says so.

## Constraints

- Pillar: agents judge, the loop does the mechanics. The dashboard is pure
  mechanics: plain TypeScript, tested, read-only.
- Repo rules: TDD for `src/` (`npm test`, `npm run test:hooks`,
  `npx tsc --noEmit` green before and after). Update
  `docs/guide/how-dev-loop-works.html` in the same change (it adds a new
  command and changes "what runs where"). Add a CHANGELOG entry tagged
  `[core]`. Use `--key=value` flags.
- Narrow (about 480px) is the smallest width it is designed for.

## Approaches considered

1. **Local web page served by a small Node server (picked).** The server
   watches the files and pushes changes to the browser over Server-Sent
   Events. It has the most room for live state, history and drilling into a
   log, and needs no dependencies.
2. **Terminal view** (like `npm run sbx:dashboard`). Quick to glance at, but
   cramped for history and per-run logs. `docs/future-enhancements.md`
   ("Monitoring view…") planned this first; this design supersedes that
   order.
3. **A static page that rebuilds every few seconds.** Simpler, but lags and
   can't push updates.

## What it reads (v2 only; all exist today unless marked)

| Source | Gives |
|---|---|
| `.pipeline/v2/<project>/sessions/*.lock` | Live workers: pid and the in-flight record (`runDir`, `since`). A live lock means a running worker; stale ones are renamed `.lock.stale-*` by the loop. |
| `<runDir>/progress.jsonl` | Live step events: `{ts, phase, event, detail}` with `phase_start`, `phase_end`, `note`, `result`. |
| `<runDir>/verdict.json`, `usage.json` | Final result and cost of a phase. |
| `runs/v2/<project>.jsonl` | Finished records with `phases[]` (`role`, `outcome`, `phase_reached`, `cost_usd`, `detail`, `pr`, `run_dir`, timestamps). |
| `pipeline.<project>.config.json` | `github.repo` for issue and PR links. |
| **Batch file (not built)** | Batch tickets, what each depends on, and base branches. Written by the future batch orchestrator, not by the dashboard. |

Path helpers live in `src/core/paths.ts`, and lock parsing in
`src/core/session.ts`. Reuse them rather than re-deriving paths.

## The design (as decided in the mockup)

**Command.** `npm run dashboard [--project=<name>] [--port=<n>]`. With no
`--project` it shows all projects that have a `pipeline.*.config.json`.
Prints the local URL.

**Shell.** A header with "Run watcher" and a view switch: **Runs**,
**Timeline**, **Batch**. Below it:
- a filter bar: Project, Phase, Worker, Show (Runs: last 12 hours, the
  default; last 24 hours; last 7 days; last 30 days; all time), Group (Runs
  and Timeline), and Window (Timeline: 1h, 4h, 24h). On narrow widths it folds behind a
  "Filters" button.
- the **legend**, at the top of every view, not the bottom: Running, Quiet,
  Landed, Bounced, Error, Stopped, Parked, plus Not reached in Runs. Batch
  uses its own states.
- a **counts row** (running, landed with total cost, bounced or parked,
  failed). Clicking a count filters to it; clicking again clears it. The counts cover
  only the chosen range (Show in Runs, Window in Timeline), with a line
  saying so ("Counts for last 12 hours").

Filter state is kept in the URL hash, so a bookmark restores the view.

**Runs view.** Two sections, Running then Finished (newest first). Each run
is a full-width card, stacked at every width.

**History.** Running always shows every live run, whatever the range. Finished
shows only runs that ended inside the Show range (default last 12 hours), so
a long history doesn't bury today. With Group set to None, Finished is
broken up by day ("Today", "Yesterday", "Wed, Nov 18"), each header giving
the run count and cost for that day. It shows 20 cards at a time with a
"Show 20 more" button. Below the list, a line says how many older runs are
hidden and offers the next range up ("17 older runs not shown. Show last
24 hours"). The empty state names the range ("No finished runs in the last
12 hours"). The range is kept in the URL hash. "Finished" times past a day
read "3d ago" or "2w ago". Top to bottom:
1. Status icon, the ticket key (large, links to Jira), and a colored status
   pill ("Running green", "Quiet at green", "Landed", "Error at red",
   "Bounced at intake"). On the right: "6:32 elapsed" or "22m ago finished".
2. Pills with icons, left-aligned with the rest of the card: phase (Dev or
   Research), project (folder icon) and worker (robot icon).
3. **Step bar**, every step labeled. Done steps get a ✓. The current step is
   filled (and hatched amber when quiet). On a finished run, the step it
   ended on is filled in the outcome's color with its mark (✕ error,
   ↩ bounced, ■ stopped, Ⅱ parked), and steps it never reached are dashed.
   Research has 8 steps, so its bar wraps to two rows at narrow widths.
4. Latest message in a shaded box, up to two lines. When quiet, the box is
   amber and starts "No update for 7m."
5. Key/value facts. Running: Step, Started, Last update (amber when stale),
   Cost so far. Finished: Ended at, Took, Finished, Cost, Commit.
6. Below a divider: link pills (Jira, Issue #N, PR #N) and a **Show log**
   button with the line count. Clicking the card itself does nothing; only
   the button opens the log.

The **expanded log** groups lines by step. Each group shows the step, how
long it took and how it ended ("red 4m, error here"), then every line in
full with its time. After that come "Not reached: …" and the
progress-file path.

**Status shapes and colors.** Shape and color both carry status, so it reads
without color: spinner running, dashed clock quiet, check landed, return
arrow bounced, diamond error, square stopped, two bars parked. Quiet means a
live run with no new progress line for 5 minutes (the loop may be signing,
pushing or fetching, which writes no progress lines today).

**Timeline view.** All three directions are built, with a Direction switch
(the user's choice: being able to toggle is the point). The chosen direction
is kept in the URL hash with the other filters. Default: By run.
- **By run**: one lane per run on a time axis, newest on top. This is the
  original layout the user liked. Group by worker is available here too.
- **By worker**: one lane per worker, showing overlap and idle time.
- **Activity**: a vertical, time-stamped stream of every progress line,
  newest first, in 15-minute blocks.

Clicking a bar opens that run's grouped log. The counts row and the legend
apply to all three directions.

**Batch view.** Empty today, with a line explaining what it will show. With
a batch running it shows the batch name and a progress bar, then the
tickets in dependency tiers ("Starts first", "Starts after step 1", …).
Each ticket is a card with its state (waiting, running, PR open, merged,
bounced, blocked), base branch ("on MC-1646") and links. A worker list sits
below. States come from facts: a live lock means running, a PR in the log
or verdict means PR open, and a bounced dependency makes its dependents
blocked.

**Look.** Atkinson Hyperlegible Next and Mono, tabular numbers, light and
dark themes, and motion only on live things (turned off by reduced-motion).
The mockup's CSS tokens can be lifted as-is.

## Calls I made (the user can override)

- Server in `src/dashboard/` (TypeScript run directly by node, like
  `src/main.ts`), with the page as one HTML file it serves. No build step.
- Parsing is pure functions with vitest tests: lock → live run, progress
  lines → current step and quiet state, runs-log record → finished runs,
  and step grouping for the log. The server is a thin shell over them.
- Updates use `fs.watch` on the `.pipeline/v2` and `runs/v2` trees and push
  to the page over SSE. A 2-second poll covers platforms where watching
  misses events.
- History is read from `runs/v2/<project>.jsonl` in full (it is small:
  one line per ticket run). Range filtering happens in the page. A finished
  run's log is read from its `run_dir` only when Show log is opened, not
  up front, so all-time history stays cheap. When that progress file is
  gone (a reset or a cleaned run dir), the log says so and shows the
  runs-log record instead. Archive files (`*.reset-archive.jsonl`) are left
  out.

## Left to the builder (answered above, under Builder checks)

- **Step lists.** The mockup assumes research = triage, interpret, ground,
  attack, scope, blocked-check, synthesize, verify, and dev = intake, red,
  green, qa, pr. The real MC-1435 progress file has no `qa` line. Find where
  each skill declares its steps and read them from there; don't hardcode.
- **Jira site URL.** Find where the loop keeps the Jira base URL (env or
  config) for the ticket link.
- **GitHub issue number.** Each ticket has a mirror GitHub issue. Find where
  the loop records its number (the runs log, the run dir or the GitHub
  client lookup). If it isn't on disk, leave the issue link out rather than
  calling GitHub from the dashboard.
- **sbx runs.** Confirm a sandboxed run's `progress.jsonl` lands on the host
  run dir while it runs, not only at the end.
- **History depth.** Confirm `runs/v2/*.jsonl` is never rotated or
  trimmed, so "All time" really means all time. Confirm what
  `npm run reset-project` removes (run dirs, runs-log lines) so the
  "log is gone" case is handled.
- **Subagent filter.** Not built. It would work only if skills name the
  subagent in their progress lines.

## Decided: where it's built

On `feat/run-watcher`, off main after `feat/bounce-criteria-v2` merged
(main `4a59aaa`), in its own worktree.
