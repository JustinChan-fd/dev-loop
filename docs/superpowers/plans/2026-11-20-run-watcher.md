# Run watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run dashboard` serves a local, read-only, live page of every v2 run (Runs, Timeline, Batch views) from `runs/v2` and `.pipeline/v2`.

**Architecture:** Pure functions in `src/dashboard/model.ts` turn log records, lock bodies and progress lines into `Run` objects and a `Snapshot`. `src/dashboard/read.ts` is the only file that touches the disk (reads only). `src/dashboard/server.ts` is a thin `node:http` shell: page, `/snapshot`, `/events` (SSE), `/log`. `src/dashboard/page.html` renders with the mockup's CSS and render functions, minus its demo data and chrome.

**Tech Stack:** Node 24 (TypeScript run directly, type stripping), `node:http`, `node:fs`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-20-run-watcher-design.md` (read its "Calls made overnight" first).

## Global Constraints

- v2 only: `runs/v2/<slug>.jsonl` (never `*.reset-archive.jsonl`) and `.pipeline/v2/<slug>/...`. Never v1.
- Read-only: no write, rename, delete, mkdir, spawn or fetch in `src/dashboard/`. No Jira or GitHub calls.
- Bind `127.0.0.1`; default port `4317`; flags `--project=<name>`, `--port=<n>`, `--root=<dir>` (`--key=value`, `parseFlags`).
- Quiet after `5` minutes with no progress line. Pages of `20`. Show range: 12h (default), 24h, 7d, 30d, all time. Window: 1h (default), 4h, 24h.
- A bounce is indigo (`--bounced`), never red. Follow the system theme only. No demo data, no demo chrome.
- Don't re-render while a `<select>` is focused.
- No new deps; the only `package.json` change is the `dashboard` script.

## Review Focus

1. A partial last line in `progress.jsonl` or the runs log while the loop is appending: skipped, never a crash. (Task 1 test.)
2. A `run_dir` in a record that is absolute or escapes `.pipeline/v2` (hand-edited log): ignored, never read. (Task 2 test.)
3. `/log?run=` with a path not in the snapshot (`../../.env`): 404, nothing read. (Task 3 test.)
4. A lock whose pid is dead, or a corrupt lock: a warning, never a running card. (Task 1/2 tests.)
5. A project config with no `runs/v2` file or no `sessions/` dir yet: empty, no error. (Task 2 test.)

---

### Task 1: Pure model (`src/dashboard/model.ts`)

**Files:** Create `src/dashboard/model.ts`; Test `test/dashboard/model.test.ts`.

**Produces:**
- `parseJsonl(raw: string): unknown[]` – skips blank and unparseable lines.
- `parseProgress(raw: string): ProgressLine[]` – `{ts, phase, event, detail}` with string fields only.
- `stepListFromSkill(md: string): string[] | null` – the first `"phase": "a|b|c"` in a SKILL.md.
- `FALLBACK_STEPS: Record<Role, string[]>` – research 8 steps, dev `intake, plan, red, green, verify, pr`.
- `stepsFor(declared: string[], seen: string[]): string[]` – declared, then unseen-in-declared in order seen.
- `parseLockBody(raw: string): { pid: number; started: number; inFlight: InFlight | null } | null`.
- `parseRunDir(rel: string): { project, session, ticket, phase: Role, runId } | null`.
- `runsFromRecords(project, records: unknown[]): FinishedSeed[]` – one per phase entry, plus parked records.
- `buildRun(seed, progress: ProgressLine[] | null, steps, now): Run` and `buildLiveRun(...)`.
- `stepStates(steps, at, status): StepState[]`.
- `groupLog(lines, endTs): LogGroup[]`.
- `activityLines(runs, linesById, now, windowMs)`.
- `QUIET_MS = 300000`.

- [ ] Step 1: tests for each function (synthetic data): tolerant parsing; MC-1435-shaped dev run without `qa`; research ended step comes from the last progress phase, not `phase_reached`; landed = all done; bounced at `ground` = done/ended/skip; parked record becomes a Parked run; phase-less records produce nothing; live quiet after 5 min; unknown phase appended to steps; lock parse rejects corrupt bodies.
- [ ] Step 2: run, expect FAIL (module missing). Commit RED.
- [ ] Step 3: implement. Step 4: run, PASS. Commit GREEN.

### Task 2: Disk reader (`src/dashboard/read.ts`)

**Files:** Create `src/dashboard/read.ts`; Test `test/dashboard/read.test.ts` (tmp dirs).

**Consumes:** Task 1. `v2RunsLog`, `v2SessionsDir`, `PROJECT_SLUG` (`src/core/paths.ts`), `repoSlugFromUrl`, `listAvailableProjects` (`src/core/config.ts`), `isProcessAlive` (`src/core/session.ts`).

**Produces:**
- `loadProjects(root, only?: string): Promise<{ projects: ProjectInfo[]; warnings: string[] }>`.
- `safeRunDir(root, rel): string | null` – absolute path under `<root>/.pipeline/v2/`, else null.
- `readSnapshot(opts: { root, projects, steps, now, isAlive, cache? }): Promise<Snapshot>`.
- `readRunLog(snapshot, root, runId): Promise<RunLog | null>` – null when runId is not in the snapshot.
- `liveDirs(snapshot, root): string[]` – dirs to `fs.watch`.

- [ ] Step 1: tests: two projects; `--project` resolves name to slug; reset-archive ignored; `.lock.stale-*`/`.lock.adopted-*` ignored; dead pid → warning, no live run; live run deduped when also finished; escaping `run_dir` ignored; missing run dir → `logGone`; missing log/sessions → empty; `readRunLog` refuses a run id outside the snapshot.
- [ ] Step 2: FAIL, commit RED. Step 3: implement. Step 4: PASS, commit GREEN.

### Task 3: Server and page (`src/dashboard/server.ts`, `src/dashboard/page.html`)

**Files:** Create both; Test `test/dashboard/server.test.ts`; Modify `package.json` (one script), `test/structure.test.ts` (read-only check).

**Produces:** `parseDashboardArgs(argv)`, `startDashboard({ root, project?, port, host?, pollMs? }): Promise<{ url, close() }>`; CLI main when run directly.

- [ ] Step 1: tests: `GET /` is HTML with no demo data (`your-site.atlassian.net`, `const REPO`, `const ISSUE`, `Pause demo`, `fonts.googleapis`); `/snapshot` JSON; `/events` first message is the snapshot; a new record appended to the log reaches an open SSE stream; `/log` 404 for an unknown run; wrong `Host` → 403; non-GET → 405; flags parse (`--port=abc` refused). Structure test: no write/spawn/fetch in `src/dashboard/`; `dashboard` script is `node src/dashboard/server.ts`.
- [ ] Step 2: FAIL, commit RED. Step 3: implement server; page lifts the mockup CSS and render functions (card, track, detail, legend, counts, timeline x3, batch empty state). Step 4: PASS; run against the real read-only logs and curl the endpoints. Commit GREEN.

### Task 4: Docs

README "Watching runs (dashboard)" + remove "Not yet built"; guide `DATA` companion entry and its render; CHANGELOG `[core]` entry with pillar check; future-enhancements: replace "Monitoring view…" and add "Collapsed finished cards". Commit.
