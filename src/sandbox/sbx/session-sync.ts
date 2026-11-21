// claude:sbx:sync — bring a dev-loop session sandbox's branches back as
// signed local branches. Mechanical, in plain TypeScript, with tests against
// real git (the pillar). Never pushes, never checks out, never moves an
// existing branch.
//
// The sandbox (sbx --clone) is reachable as the `sandbox-<name>` git remote.
// For each branch there with new commits:
//   1. refuse unsafe names (they are printed into commands), merges, and main;
//   2. list protected files it touches; stop there unless --allow-protected;
//   3. rebuild each commit with `git commit-tree -S` (the host's key, the
//      host's identity, the same tree and message), no worktree and no hooks;
//   4. check the trees match and every new commit is signed (G), then create
//      the local branch (create-only: an existing branch is never moved).
// refs/dl-sync/<name>/<branch> remembers the sandbox tip that was synced, so a
// second run reports it instead of failing.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitFn } from "../../worker/host-sign.ts";
import { isSafeBranchName, protectedHits, type BranchSync } from "./session.ts";

export interface SyncArgs {
  repo: string;
  name: string;
  protectedPaths: string[];
  allowProtected: boolean;
  git: GitFn;
  defaultBranch: string;
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
const firstLine = (e: unknown): string => lines(e instanceof Error ? e.message : String(e))[0] ?? "unknown error";

export async function syncSandboxBranches(a: SyncArgs): Promise<BranchSync[]> {
  const run = async (...args: string[]): Promise<string> => (await a.git(args, a.repo)).trim();
  const raw = (...args: string[]): Promise<string> => a.git(args, a.repo);
  const ok = async (...args: string[]): Promise<boolean> => run(...args).then(() => true, () => false);
  const remote = `sandbox-${a.name}`;
  await run("fetch", "--quiet", "--no-tags", remote);

  const remoteRefs = lines(await run("for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`))
    .map((r) => r.slice(`refs/remotes/${remote}/`.length))
    .filter((b) => b !== "HEAD");
  await run("rev-parse", "--verify", `${a.defaultBranch}^{commit}`);
  // Everything the host already has (never the sandbox's own remote refs).
  const HOST_REFS = ["--branches", "--tags", "--remotes=origin"];
  // Every local ref, case-folded: the Mac's disk is case-insensitive, so `MAIN` is `main`
  // once written as a loose ref, even when `main` itself only lives in packed-refs.
  const localRefs = async (): Promise<Map<string, string>> =>
    new Map(lines(await run("for-each-ref", "--format=%(refname)")).map((r) => [r.toLowerCase(), r]));
  const out: BranchSync[] = [];
  const empty = { commits: 0, adds: 0, dels: 0, files: 0, hits: [] as string[] };
  // Names in the sandbox (Linux) that differ only in case land on one ref file here,
  // so the fetched ref may hold either. Refuse every such name rather than guess.
  const advertised = lines(await run("ls-remote", "--heads", remote)).map((l) => l.split(/\s+/)[1]?.replace(/^refs\/heads\//, "") ?? "");
  const byFold = new Map<string, number>();
  for (const n of advertised) byFold.set(n.toLowerCase(), (byFold.get(n.toLowerCase()) ?? 0) + 1);
  const clashing = new Set([...byFold].filter(([, c]) => c > 1).map(([k]) => k));
  for (const k of clashing) {
    const names = advertised.filter((n) => n.toLowerCase() === k);
    out.push({ branch: names.every(isSafeBranchName) ? names.join(" / ") : "(unsafe name)", status: "failed", ...empty, detail: "branch names differ only in case (one file on this Mac's disk); rename in the sandbox" });
  }

  for (const branch of remoteRefs) {
    if (clashing.has(branch.toLowerCase())) continue;
    try {
      out.push(...(await syncOne(branch)));
    } catch (e) {
      out.push({ branch: isSafeBranchName(branch) ? branch : "(unsafe name)", status: "failed", ...empty, detail: firstLine(e) });
    }
  }
  return out;

  async function sandboxCopy(branch: string, tip: string): Promise<BranchSync | undefined> {
    const same = (await localRefs()).get(`refs/heads/${branch}`.toLowerCase());
    if (!same || !isSafeBranchName(branch)) return undefined;
    const local = same.slice("refs/heads/".length);
    // What DWIM leaves behind: the local branch's upstream is this sandbox's remote.
    const upstream = await run("config", "--get", `branch.${local}.remote`).catch(() => "");
    if (upstream !== remote) return undefined;
    const signedTip = await run("rev-parse", "--verify", "-q", `refs/dl-sync/${a.name}/${branch}-signed`).catch(() => "");
    if (signedTip && (await run("rev-parse", same)) === signedTip) return undefined;
    // The sandbox's commits it carries: not on any other host branch, tag or origin.
    const carried = lines(await run("rev-list", tip, "--not", `--exclude=${local}`, "--branches", "--tags", "--remotes=origin")).length;
    return {
      branch, status: "failed", ...empty,
      detail: `your local ${local} tracks ${remote} and holds ${plural(carried, "sandbox commit")} unsigned and never checked (made by git checkout or git worktree add); remove it (git branch -D ${local}, and its worktree) and rerun`,
    };
  }

  async function syncOne(branch: string): Promise<BranchSync[]> {
    const tip = await run("rev-parse", "--verify", `refs/remotes/${remote}/${branch}^{commit}`);
    // A local branch made straight from the sandbox remote (git checkout / worktree add
    // pick it when the name is unique) holds the sandbox's unsigned commits and hides them
    // from the "new" count below. Report it; never move or delete it.
    const dwim = await sandboxCopy(branch, tip);
    if (dwim) return [dwim];
    // "New" means not reachable from anything the host already has: its branches, tags and
    // origin. A sandbox branch cut from your unmerged feat/x carries only its own commits.
    const shas = lines(await run("rev-list", "--reverse", "--topo-order", tip, "--not", ...HOST_REFS));
    if (shas.length === 0) return []; // nothing new
    if (!isSafeBranchName(branch)) {
      return [{ branch: "(unsafe name)", status: "failed", ...empty, detail: `unsafe branch name ${JSON.stringify(branch)}; read it with git log ${remote} --all` }];
    }
    // The host commit the new ones grew from: the first new commit's only parent.
    const parents = (await run("rev-list", "--parents", "-n", "1", shas[0])).split(" ").slice(1);
    if (parents.length === 0) return [{ branch, status: "failed", ...empty, detail: `no history in common with your branches; not synced` }];
    if (parents.length > 1) return [{ branch, status: "failed", ...empty, detail: "has a merge commit; refusing to rewrite (rebase it in the sandbox)" }];
    const base = parents[0];
    // A linear run: every new commit's parent is the one before it (else a merge or a side branch).
    const chain = lines(await run("rev-list", "--reverse", `${base}..${tip}`));
    if (chain.join() !== shas.join() || lines(await run("rev-list", "--merges", tip, "--not", ...HOST_REFS)).length > 0) {
      return [{ branch, status: "failed", ...empty, detail: "has a merge commit or a side branch; refusing to rewrite (rebase it in the sandbox)" }];
    }
    // -z: raw paths (git C-quotes non-ASCII and special characters otherwise).
    const z = (await raw("diff", "--numstat", "-z", "--no-renames", base, tip)).split("\0").filter(Boolean);
    const numstat = z.map((rec) => rec.split("\t"));
    const files = numstat.map((f) => f.slice(2).join("\t"));
    // Every path any commit touched, not only the net diff: a change then revert still gets signed.
    const touched = [...new Set((await raw("log", "--format=", "--name-only", "-z", "--no-renames", `${base}..${tip}`)).split("\0").map((x) => x.replace(/^\n+/, "")).filter(Boolean))];
    const n = (x: string | undefined): number => (x && /^\d+$/.test(x) ? Number(x) : 0);
    const stats = {
      commits: shas.length,
      adds: numstat.reduce((t, f) => t + n(f[0]), 0),
      dels: numstat.reduce((t, f) => t + n(f[1]), 0),
      files: files.length,
      hits: protectedHits(touched, a.protectedPaths),
    };
    const row = (status: BranchSync["status"], detail?: string): BranchSync[] => [{ branch, status, ...stats, ...(detail ? { detail } : {}), base }];

    if (branch.toLowerCase() === a.defaultBranch.toLowerCase()) {
      return row("exists", `commits on ${branch} in the sandbox; your ${a.defaultBranch} was not moved (read them: git log ${a.defaultBranch}..${remote}/${branch})`);
    }
    // Never a name that already means something to git here (origin/main, a tag, a remote).
    const remotes = lines(await run("remote")).map((r) => r.toLowerCase());
    if (remotes.includes(branch.split("/")[0].toLowerCase())) return row("failed", `name starts with the remote "${branch.split("/")[0]}"; would shadow it`);
    const refs = await localRefs();
    const marker = `refs/dl-sync/${a.name}/${branch}`;
    const same = refs.get(`refs/heads/${branch}`.toLowerCase());
    if (same) {
      const synced = await run("rev-parse", "--verify", "-q", marker).catch(() => "");
      const local = await run("rev-parse", same);
      const signedTip = await run("rev-parse", "--verify", "-q", `${marker}-signed`).catch(() => "");
      return synced === tip && same === `refs/heads/${branch}` && local === signedTip
        ? row("synced")
        : row("exists", `a local ${same.slice("refs/heads/".length)} already exists; not moved (compare: git log -p ${same.slice("refs/heads/".length)}..${remote}/${branch})`);
    }
    for (const [low, real] of refs) {
      if (low.startsWith("refs/tags/") && low.slice("refs/tags/".length) === branch.toLowerCase()) return row("failed", `a tag ${real.slice(10)} has this name; would shadow it`);
      if (low.startsWith("refs/heads/") && (low.startsWith(`refs/heads/${branch.toLowerCase()}/`) || `refs/heads/${branch.toLowerCase()}`.startsWith(`${low}/`))) {
        return row("failed", `clashes with the local branch ${real.slice(11)}`);
      }
    }
    if (lines(await run("rev-list", "--merges", `${base}..${tip}`)).length > 0) {
      return row("failed", "has a merge commit; refusing to rewrite (rebase it in the sandbox)");
    }
    if (stats.hits.length > 0 && !a.allowProtected) return row("protected");

    const tmp = mkdtempSync(join(tmpdir(), "dl-sync-"));
    try {
      let parent = base;
      for (const sha of shas) {
        const tree = await run("rev-parse", `${sha}^{tree}`);
        const msgFile = join(tmp, "msg");
        // Your identity signs it; the trailer keeps where it came from.
        const msg = (await raw("log", "-1", "--format=%B", sha)).replace(/\s+$/, "");
        writeFileSync(msgFile, `${msg}\n\nSandbox-Commit: ${a.name} ${sha}\n`);
        parent = await run("commit-tree", "-S", tree, "-p", parent, "-F", msgFile);
      }
      if ((await run("rev-parse", `${parent}^{tree}`)) !== (await run("rev-parse", `${tip}^{tree}`))) throw new Error("tree changed while signing");
      const bad = lines(await run("log", "--format=%H %G?", `${base}..${parent}`)).find((l) => !l.endsWith(" G"));
      if (bad) throw new Error(`${bad.split(" ")[0]} signature is ${bad.split(" ")[1]}, expected G`);
      // Re-check just before writing (case-folded), then create-only.
      if ((await localRefs()).has(`refs/heads/${branch}`.toLowerCase())) return row("exists", `a local ${branch} appeared while syncing; not moved`);
      await run("update-ref", `refs/heads/${branch}`, parent, "");
      await run("update-ref", marker, tip);
      await run("update-ref", `${marker}-signed`, parent);
      return row("synced");
    } catch (e) {
      return row("failed", `signing failed: ${firstLine(e)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
