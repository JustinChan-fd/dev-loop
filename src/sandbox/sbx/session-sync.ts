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
const firstLine = (e: unknown): string => lines(e instanceof Error ? e.message : String(e))[0] ?? "unknown error";

export async function syncSandboxBranches(a: SyncArgs): Promise<BranchSync[]> {
  const run = async (...args: string[]): Promise<string> => (await a.git(args, a.repo)).trim();
  const ok = async (...args: string[]): Promise<boolean> => run(...args).then(() => true, () => false);
  const remote = `sandbox-${a.name}`;
  await run("fetch", "--quiet", "--no-tags", remote);

  const remoteRefs = lines(await run("for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`))
    .map((r) => r.slice(`refs/remotes/${remote}/`.length))
    .filter((b) => b !== "HEAD");
  const main = await run("rev-parse", "--verify", `${a.defaultBranch}^{commit}`);
  const out: BranchSync[] = [];

  for (const branch of remoteRefs) {
    const tip = await run("rev-parse", "--verify", `refs/remotes/${remote}/${branch}^{commit}`);
    if (await ok("merge-base", "--is-ancestor", tip, main)) continue; // nothing new
    const empty = { commits: 0, adds: 0, dels: 0, files: 0, hits: [] as string[] };
    if (!isSafeBranchName(branch)) {
      out.push({ branch: "(unsafe name)", status: "failed", ...empty, detail: `unsafe branch name ${JSON.stringify(branch)}; read it with git log ${remote} --all` });
      continue;
    }

    const base = await run("merge-base", tip, main);
    const shas = lines(await run("rev-list", "--reverse", `${base}..${tip}`));
    const numstat = lines(await run("diff", "--numstat", "--no-renames", base, tip));
    const files = numstat.map((l) => l.split("\t").slice(2).join("\t"));
    const n = (s: string): number => (/^\d+$/.test(s) ? Number(s) : 0);
    const stats = {
      commits: shas.length,
      adds: numstat.reduce((t, l) => t + n(l.split("\t")[0]), 0),
      dels: numstat.reduce((t, l) => t + n(l.split("\t")[1]), 0),
      files: files.length,
      hits: protectedHits(files, a.protectedPaths),
    };
    const row = (status: BranchSync["status"], detail?: string): BranchSync => ({ branch, status, ...stats, ...(detail ? { detail } : {}) });

    if (branch === a.defaultBranch) {
      out.push(row("exists", `commits on ${branch} in the sandbox; your ${branch} was not moved (read them: git log ${branch}..${remote}/${branch})`));
      continue;
    }
    const marker = `refs/dl-sync/${a.name}/${branch}`;
    if (await ok("rev-parse", "--verify", "-q", `refs/heads/${branch}`)) {
      const synced = await run("rev-parse", "--verify", "-q", marker).catch(() => "");
      out.push(synced === tip ? row("synced") : row("exists", `a local ${branch} already exists; not moved (compare: git diff ${branch} ${remote}/${branch})`));
      continue;
    }
    if (lines(await run("rev-list", "--merges", `${base}..${tip}`)).length > 0) {
      out.push(row("failed", "has a merge commit; refusing to rewrite (rebase it in the sandbox)"));
      continue;
    }
    if (stats.hits.length > 0 && !a.allowProtected) {
      out.push(row("protected"));
      continue;
    }

    const tmp = mkdtempSync(join(tmpdir(), "dl-sync-"));
    try {
      let parent = base;
      for (const sha of shas) {
        const tree = await run("rev-parse", `${sha}^{tree}`);
        const msgFile = join(tmp, "msg");
        writeFileSync(msgFile, await a.git(["log", "-1", "--format=%B", sha], a.repo));
        parent = await run("commit-tree", "-S", tree, "-p", parent, "-F", msgFile);
      }
      if ((await run("rev-parse", `${parent}^{tree}`)) !== (await run("rev-parse", `${tip}^{tree}`))) throw new Error("tree changed while signing");
      const bad = lines(await run("log", "--format=%H %G?", `${base}..${parent}`)).find((l) => !l.endsWith(" G"));
      if (bad) throw new Error(`${bad.split(" ")[0]} signature is ${bad.split(" ")[1]}, expected G`);
      // Create-only: the empty old value makes update-ref fail if the branch appeared meanwhile.
      await run("update-ref", `refs/heads/${branch}`, parent, "");
      await run("update-ref", marker, tip);
      out.push(row("synced"));
    } catch (e) {
      out.push(row("failed", `signing failed: ${firstLine(e)}`));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return out;
}
