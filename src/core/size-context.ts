// The facts research needs for a size call (bounce criteria v2), written by
// the loop to RUN_DIR/size-context.json before every research spawn: the dev
// limits, and what recent landed tickets actually cost. The agent judges;
// this file only counts. Pure builder plus a loader that never throws (any
// read problem means empty history, and the limits are still there).

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Config, TShirtSize } from "./types.ts";
import type { DiffStats } from "./diff-stats.ts";
import { diffStatsSidecarPath } from "./diff-stats.ts";
import { resolveV1RunsLog } from "./iteration-log.ts";
import { resolveRepoPath, v2RunsLog } from "./paths.ts";

export const SIZE_CONTEXT_WINDOW = 30;

export interface SizeContextTicket {
  ticket: string;
  /** `ended` of the landed dev run. */
  landed: string;
  /** Summed over every dev run of the ticket (what the per-ticket cap sees). */
  cost_usd: number;
  minutes: number;
  dev_runs: number;
  /** verify_loops of the landed run. */
  qa_loops: number | null;
  files: number | null;
  additions: number | null;
  deletions: number | null;
  research_estimate: TShirtSize | null;
  ac_count: number | null;
}

export interface SizeContext {
  generated: string;
  limits: { dev_max_cost_per_run_usd: number; dev_run_timeout_min: number; max_cost_per_ticket_usd: number };
  window: number;
  stats: { tickets: number; cost_usd: { median: number; p90: number } | null; minutes: { median: number; p90: number } | null };
  /** Newest first. */
  tickets: SizeContextTicket[];
}

export interface DevRunFact {
  ticket: string;
  started: string;
  ended: string;
  outcome: string;
  cost_usd: number;
  verify_loops: number | null;
  pr: string | null;
  diff_stats: DiffStats | null;
}

export interface ResearchFact {
  ticket: string;
  ended: string;
  size_estimate: TShirtSize | null;
  ac_count: number | null;
}

/** Nearest-rank percentile of an ascending array (p in (0, 1]). */
export function nearestRank(sorted: number[], p: number): number {
  const i = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[i - 1]!;
}

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;
const minutesOf = (r: DevRunFact): number => {
  const ms = Date.parse(r.ended) - Date.parse(r.started);
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : 0;
};

function spread(xs: number[]): { median: number; p90: number } | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { median: nearestRank(s, 0.5), p90: nearestRank(s, 0.9) };
}

export function buildSizeContext(i: {
  devRuns: DevRunFact[];
  research: ResearchFact[];
  sidecar: Record<string, DiffStats>;
  config: Config;
  now: Date;
  window?: number;
}): SizeContext {
  const window = i.window ?? SIZE_CONTEXT_WINDOW;
  const byTicket = new Map<string, DevRunFact[]>();
  for (const r of i.devRuns) byTicket.set(r.ticket, [...(byTicket.get(r.ticket) ?? []), r]);

  const latestResearch = new Map<string, ResearchFact>();
  for (const f of i.research) {
    const prev = latestResearch.get(f.ticket);
    if (!prev || f.ended >= prev.ended) latestResearch.set(f.ticket, f);
  }

  const tickets: SizeContextTicket[] = [];
  for (const [ticket, runs] of byTicket) {
    const landed = runs.filter((r) => r.outcome === "landed").sort((a, b) => a.ended.localeCompare(b.ended)).at(-1);
    if (!landed) continue;
    const diff = landed.diff_stats ?? (landed.pr ? i.sidecar[landed.pr] : undefined) ?? null;
    const rf = latestResearch.get(ticket);
    tickets.push({
      ticket,
      landed: landed.ended,
      cost_usd: round(runs.reduce((a, r) => a + r.cost_usd, 0), 2),
      minutes: round(runs.reduce((a, r) => a + minutesOf(r), 0), 1),
      dev_runs: runs.length,
      qa_loops: landed.verify_loops,
      files: diff?.files ?? null,
      additions: diff?.additions ?? null,
      deletions: diff?.deletions ?? null,
      research_estimate: rf?.size_estimate ?? null,
      ac_count: rf?.ac_count ?? null,
    });
  }
  tickets.sort((a, b) => b.landed.localeCompare(a.landed));
  const kept = tickets.slice(0, window);

  return {
    generated: i.now.toISOString(),
    limits: {
      dev_max_cost_per_run_usd: i.config.roles.dev.ceilings.maxCostPerRunUsd,
      dev_run_timeout_min: i.config.roles.dev.ceilings.runTimeoutMin,
      max_cost_per_ticket_usd: i.config.ceilings.maxCostPerTicketUsd,
    },
    window,
    stats: { tickets: kept.length, cost_usd: spread(kept.map((t) => t.cost_usd)), minutes: spread(kept.map((t) => t.minutes)) },
    tickets: kept,
  };
}

// ---- loading from the run logs ----

type Obj = Record<string, unknown>;
const TSHIRTS: readonly string[] = ["S", "M", "L", "XL"];
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const tshirt = (v: unknown): TShirtSize | null => (typeof v === "string" && TSHIRTS.includes(v) ? (v as TShirtSize) : null);
const diffOf = (v: unknown): DiffStats | null => {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Obj;
  const f = intOrNull(o.files), a = intOrNull(o.additions), d = intOrNull(o.deletions);
  return f === null || a === null || d === null ? null : { files: f, additions: a, deletions: d };
};

async function jsonl(path: string): Promise<Obj[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Obj[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v === "object" && v !== null && typeof (v as Obj).ticket === "string") out.push(v as Obj);
    } catch {
      /* skip a bad line */
    }
  }
  return out;
}

async function sidecarOf(logPath: string): Promise<Record<string, DiffStats>> {
  try {
    const v: unknown = JSON.parse(await readFile(diffStatsSidecarPath(logPath), "utf8"));
    if (typeof v !== "object" || v === null) return {};
    const out: Record<string, DiffStats> = {};
    for (const [k, s] of Object.entries(v as Obj)) {
      const d = diffOf(s);
      if (d) out[k] = d;
    }
    return out;
  } catch {
    return {};
  }
}

const devFact = (ticket: string, e: Obj): DevRunFact => ({
  ticket,
  started: str(e.started),
  ended: str(e.ended),
  outcome: str(e.outcome),
  cost_usd: num(e.cost_usd),
  verify_loops: intOrNull(e.verify_loops),
  pr: typeof e.pr === "string" && e.pr ? e.pr : null,
  diff_stats: diffOf(e.diff_stats),
});

const researchFact = (ticket: string, e: Obj): ResearchFact => ({
  ticket,
  ended: str(e.ended),
  size_estimate: tshirt(e.size_estimate) ?? tshirt((e.size_trajectory as Obj | undefined)?.step4_tshirt),
  ac_count: intOrNull(e.ac_count),
});

/** Reads the v2 log, the v1 dev and research logs and the diff-stats sidecars. Never throws. */
export async function loadSizeContext(slug: string, config: Config, now: Date, root?: string): Promise<SizeContext> {
  const abs = (p: string) => (isAbsolute(p) ? p : root ? join(root, p) : resolveRepoPath(p));
  const devRuns: DevRunFact[] = [];
  const research: ResearchFact[] = [];
  let sidecar: Record<string, DiffStats> = {};
  try {
    const v2 = abs(v2RunsLog(slug));
    for (const r of await jsonl(v2)) {
      const phases = Array.isArray(r.phases) ? (r.phases as Obj[]) : [];
      for (const p of phases) {
        if (p.role === "dev") devRuns.push(devFact(r.ticket as string, p));
        else if (p.role === "research") research.push(researchFact(r.ticket as string, p));
      }
    }
    sidecar = { ...(await sidecarOf(v2)) };
    const v1Dev = await resolveV1RunsLog("dev", slug, root);
    if (v1Dev) {
      for (const l of await jsonl(v1Dev.path)) devRuns.push(devFact(l.ticket as string, l));
      sidecar = { ...(await sidecarOf(v1Dev.path)), ...sidecar };
    }
    const v1Research = await resolveV1RunsLog("research", slug, root);
    if (v1Research) for (const l of await jsonl(v1Research.path)) research.push(researchFact(l.ticket as string, l));
  } catch {
    return buildSizeContext({ devRuns: [], research: [], sidecar: {}, config, now });
  }
  return buildSizeContext({ devRuns, research, sidecar, config, now });
}
