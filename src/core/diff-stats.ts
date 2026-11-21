// A landed PR's size, read from GitHub (the PR is the fact: dev's worktree may
// be gone and a host push rebases the commits). Recorded on the dev
// PhaseEntry as `diff_stats`; size-context.ts feeds it to research. Never
// throws: a failed read is null and the entry is recorded without it.

import { realExecGh, type ExecGhFn } from "./github-client.ts";

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export type PrDiffStatsFn = (prUrl: string) => Promise<DiffStats | null>;

const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** `gh pr view --json changedFiles,additions,deletions` stdout -> DiffStats, or null if anything is off. */
export function parsePrDiffStats(raw: string): DiffStats | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!count(o.changedFiles) || !count(o.additions) || !count(o.deletions)) return null;
  return { files: o.changedFiles, additions: o.additions, deletions: o.deletions };
}

export function realPrDiffStats(exec: ExecGhFn = realExecGh()): PrDiffStatsFn {
  return async (prUrl) => {
    try {
      return parsePrDiffStats(await exec(["pr", "view", prUrl, "--json", "changedFiles,additions,deletions"]));
    } catch {
      return null;
    }
  };
}

/** runs/v2/x.jsonl -> runs/v2/x.diff-stats.json (the one-off backfill's sidecar; logs stay append-only). */
export function diffStatsSidecarPath(logPath: string): string {
  return logPath.replace(/\.jsonl$/, "") + ".diff-stats.json";
}
