// The run watcher's only disk access, and it only reads: project configs,
// runs/v2/<slug>.jsonl, .pipeline/v2/<slug>/sessions/*.lock and each run's
// progress.jsonl. It never writes, renames, deletes or creates anything, and
// never touches Jira or GitHub. Spec:
// docs/superpowers/specs/2026-11-20-run-watcher-design.md.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { listAvailableProjects, repoSlugFromUrl } from "../core/config.ts";
import { PROJECT_SLUG, SESSION_ID, v2RunsLog, v2SessionsDir } from "../core/paths.ts";
import type { Role } from "../core/types.ts";
import {
  activityFrom,
  buildFinishedRun,
  buildLiveRun,
  FALLBACK_STEPS,
  groupLog,
  parseJsonl,
  parseLockBody,
  parseProgress,
  parseRunDir,
  SKILL_OF,
  seedsFromRecords,
  stepListFromSkill,
  type ActivityLine,
  type LogGroup,
  type ProgressLine,
  type Run,
} from "./model.ts";

/** How far back the Activity stream reaches (the longest Timeline window). */
export const ACTIVITY_MS = 24 * 60 * 60_000;

export interface ProjectInfo {
  /** The config name (`pipeline.<name>.config.json`), what --project takes. */
  name: string;
  /** The v2 path segment (from targetRepo.url). */
  slug: string;
  /** github.repo, "owner/name", or null. */
  repo: string | null;
}

export interface Worker {
  project: string;
  session: string;
  ticket: string | null;
  phase: Role | null;
}

export interface Snapshot {
  /** Epoch ms the snapshot was read at. */
  now: number;
  projects: ProjectInfo[];
  /** Live runs (newest start first), then finished runs (newest end first). */
  runs: Run[];
  workers: Worker[];
  warnings: string[];
  activity: ActivityLine[];
  jiraBase: string | null;
}

export interface RunLog {
  id: string;
  /** Repo-relative progress file path. */
  path: string;
  gone: boolean;
  groups: LogGroup[];
}

/** progress.jsonl contents, keyed by absolute path, reused while size and mtime are unchanged. */
export type ProgressCache = Map<string, { size: number; mtimeMs: number; lines: ProgressLine[] }>;

export interface SnapshotOptions {
  root: string;
  projects: ProjectInfo[];
  steps: Record<Role, string[]>;
  now: number;
  isAlive: (pid: number, started: number) => boolean;
  jiraBase: string | null;
  cache?: ProgressCache;
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return null;
    throw e;
  }
}

const GH_REPO = /^[\w.-]+\/[\w.-]+$/;

/** Every project config under `root` (minus pipeline.loop), or just `only`. Throws on an unknown `only`. */
export async function loadProjects(root: string, only?: string): Promise<{ projects: ProjectInfo[]; warnings: string[] }> {
  const names = await listAvailableProjects(root);
  if (only !== undefined && !names.includes(only)) {
    throw new Error(`--project=${only}: no pipeline.${only}.config.json. Available projects: ${names.join(", ") || "(none found)"}`);
  }
  const projects: ProjectInfo[] = [];
  const warnings: string[] = [];
  for (const name of only !== undefined ? [only] : names) {
    const file = `pipeline.${name}.config.json`;
    try {
      const cfg = JSON.parse((await readText(join(root, file))) ?? "null") as { targetRepo?: { url?: unknown }; github?: { repo?: unknown } } | null;
      const url = cfg?.targetRepo?.url;
      if (typeof url !== "string") throw new Error("no targetRepo.url");
      const slug = repoSlugFromUrl(url);
      if (!PROJECT_SLUG.test(slug)) throw new Error(`slug ${JSON.stringify(slug)} is not a project slug`);
      if (projects.some((p) => p.slug === slug)) continue;
      const repo = typeof cfg?.github?.repo === "string" && GH_REPO.test(cfg.github.repo) ? cfg.github.repo : null;
      projects.push({ name, slug, repo });
    } catch (e) {
      warnings.push(`${file} can't be read (${(e as Error).message}); its runs are not shown`);
    }
  }
  return { projects, warnings };
}

/** Each role's steps as its SKILL.md declares them, else FALLBACK_STEPS. */
export async function readStepLists(root: string): Promise<Record<Role, string[]>> {
  const out = { ...FALLBACK_STEPS };
  for (const role of ["research", "dev"] as const) {
    const md = await readText(join(root, ".claude/skills", SKILL_OF[role], "SKILL.md"));
    out[role] = (md !== null && stepListFromSkill(md)) || FALLBACK_STEPS[role];
  }
  return out;
}

/** The Jira site for ticket links: an https JIRA_BASE_URL, without a trailing slash; else null. */
export function jiraBaseFrom(v: string | undefined): string | null {
  if (!v || !/^https:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(v)) return null;
  return v.replace(/\/+$/, "");
}

/** The absolute path of a repo-relative v2 run dir under `root`; null for anything that isn't one. */
export function safeRunDir(root: string, rel: string): string | null {
  return parseRunDir(rel) ? join(root, rel) : null;
}

/** A run dir's progress lines; null when the file (or the run dir) is gone or the path isn't a run dir. */
async function progressOf(root: string, rel: string, cache: ProgressCache | undefined): Promise<ProgressLine[] | null> {
  const dir = safeRunDir(root, rel);
  if (dir === null) return null;
  const path = join(dir, "progress.jsonl");
  let st;
  try {
    st = await stat(path);
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return null;
    throw e;
  }
  const hit = cache?.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.lines;
  const raw = await readText(path);
  if (raw === null) return null;
  const lines = parseProgress(raw);
  cache?.set(path, { size: st.size, mtimeMs: st.mtimeMs, lines });
  return lines;
}

/** Everything the page shows, read fresh (finished progress files come from the cache when unchanged). */
export async function readSnapshot(o: SnapshotOptions): Promise<Snapshot> {
  const live: Run[] = [];
  const finished: Run[] = [];
  const workers: Worker[] = [];
  const warnings: string[] = [];
  const linesById = new Map<string, ProgressLine[]>();

  for (const p of o.projects) {
    // Finished runs: every phase entry (and parked run) in the live log; the reset archive is left out.
    const raw = await readText(join(o.root, v2RunsLog(p.slug)));
    for (const seed of seedsFromRecords(p.slug, raw === null ? [] : parseJsonl(raw))) {
      const lines = await progressOf(o.root, seed.runDir, o.cache);
      if (lines) linesById.set(seed.runDir, lines);
      finished.push(buildFinishedRun(seed, lines, o.steps[seed.phase]));
    }

    // Live runs: a live lock's inFlight. `.lock.stale-*` / `.lock.adopted-*` are the loop's leftovers.
    const sessDir = join(o.root, v2SessionsDir(p.slug));
    let files: string[];
    try {
      files = (await readdir(sessDir)).filter((f) => f.endsWith(".lock") && !f.startsWith(".")).sort();
    } catch (e) {
      if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") continue;
      throw e;
    }
    for (const f of files) {
      const session = f.slice(0, -".lock".length);
      if (!SESSION_ID.test(session)) continue;
      const text = await readText(join(sessDir, f));
      if (text === null) continue; // released between readdir and read
      const lock = parseLockBody(text);
      if (lock === null) {
        warnings.push(`${p.name}: ${f} can't be read; its run, if any, is not shown`);
        continue;
      }
      const flight = lock.inFlight;
      if (!o.isAlive(lock.pid, lock.started)) {
        if (flight) {
          warnings.push(`${p.name}: ${session}'s lock names ${flight.ticket} ${flight.role}, but its process is gone; the loop records it on its next start`);
        }
        continue;
      }
      workers.push({ project: p.slug, session, ticket: flight?.ticket ?? null, phase: flight?.role ?? null });
      if (!flight) continue;
      const parts = parseRunDir(flight.runDir);
      if (!parts || parts.project !== p.slug) {
        warnings.push(`${p.name}: ${session}'s lock names a run dir that isn't a v2 run dir (${flight.runDir})`);
        continue;
      }
      if (finished.some((r) => r.id === flight.runDir)) continue; // already in the log: shown as finished
      const lines = await progressOf(o.root, flight.runDir, o.cache);
      if (lines) linesById.set(flight.runDir, lines);
      live.push(buildLiveRun(p.slug, session, flight, lines, o.steps[flight.role], o.now));
    }
  }

  live.sort((a, b) => b.started - a.started);
  finished.sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0));
  const runs = [...live, ...finished];
  const activity = activityFrom(runs.map((r) => ({ id: r.id, lines: linesById.get(r.id) ?? [] })), o.now - ACTIVITY_MS);
  return { now: o.now, projects: o.projects, runs, workers, warnings, activity, jiraBase: o.jiraBase };
}

/** One run's full log, grouped by step. Null unless `id` is a run in `snap` (the page can't name other files). */
export async function readRunLog(snap: Snapshot, root: string, id: string, now: number): Promise<RunLog | null> {
  const run = snap.runs.find((r) => r.id === id);
  if (!run) return null;
  const lines = await progressOf(root, run.runDir, undefined);
  return { id, path: `${run.runDir}/progress.jsonl`, gone: lines === null, groups: groupLog(lines ?? [], run.ended ?? now) };
}

/** The absolute dirs of the snapshot's live runs (watched for new progress lines). */
export function liveDirs(snap: Snapshot, root: string): string[] {
  return snap.runs.filter((r) => r.live).flatMap((r) => safeRunDir(root, r.runDir) ?? []);
}
