// One-off: record the size of PRs that landed before dev entries carried
// `diff_stats`. Reads runs/v1/dev/<project>.jsonl and runs/v2/<project>.jsonl,
// asks GitHub (`gh pr view <url> --json changedFiles,additions,deletions`,
// read-only) for every landed dev PR that has no diff_stats, and merges the
// answers into a sidecar next to each log: <log>.diff-stats.json, keyed by
// PR URL. NEVER rewrites the logs (they stay append-only).
// src/core/size-context.ts reads the sidecars.
//
//   node scripts/backfill-diff-stats.mjs --project=<slug> [--dry-run] [--root=<dir>]

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
if (!args.project) { console.error("usage: --project=<slug> [--dry-run] [--root=<dir>]"); process.exit(2); }
const root = args.root ?? join(dirname(fileURLToPath(import.meta.url)), "..");

// Same rules as parsePrDiffStats in src/core/diff-stats.ts (a .mjs can't import the .ts).
const count = (v) => Number.isInteger(v) && v >= 0;
function parse(raw) {
  try {
    const o = JSON.parse(raw);
    if (!o || !count(o.changedFiles) || !count(o.additions) || !count(o.deletions)) return null;
    return { files: o.changedFiles, additions: o.additions, deletions: o.deletions };
  } catch { return null; }
}

async function lines(path) {
  try { return (await readFile(path, "utf8")).split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); }
  catch { return []; }
}

const logs = [
  { path: join(root, "runs/v1/dev", `${args.project}.jsonl`), devEntries: (r) => [r] },
  { path: join(root, "runs/v2", `${args.project}.jsonl`), devEntries: (r) => (r.phases ?? []).filter((p) => p.role === "dev") },
];

for (const log of logs) {
  const sidecar = log.path.replace(/\.jsonl$/, "") + ".diff-stats.json";
  let have = {};
  try { have = JSON.parse(await readFile(sidecar, "utf8")); } catch { /* none yet */ }
  const urls = new Set();
  for (const r of await lines(log.path)) for (const e of log.devEntries(r)) {
    if (e.outcome === "landed" && typeof e.pr === "string" && e.pr && !e.diff_stats && !have[e.pr]) urls.add(e.pr);
  }
  console.log(`${log.path}: ${urls.size} PR(s) to read`);
  if (args["dry-run"] || urls.size === 0) continue;
  let got = 0;
  for (const url of urls) {
    try {
      const { stdout } = await run("gh", ["pr", "view", url, "--json", "changedFiles,additions,deletions"]);
      const s = parse(stdout);
      if (s) { have[url] = s; got++; } else console.error(`  ${url}: unreadable answer`);
    } catch (e) { console.error(`  ${url}: ${String(e.message ?? e).split("\n")[0]}`); }
  }
  await writeFile(sidecar, JSON.stringify(have, null, 2) + "\n");
  console.log(`  wrote ${got} to ${sidecar}`);
}
