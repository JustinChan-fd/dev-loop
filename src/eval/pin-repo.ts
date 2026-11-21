// Pins the target repo for a fixture run (eval fixtures): the loop, on the
// host, makes a detached worktree at the fixture's commit and passes it to the
// skill as ground-dir=. A missing commit gets one fetch, then a hard error:
// never a fallback to HEAD, or the fixture would silently grade a different
// codebase. remove() never throws (it runs in a finally).

import { isAbsolute } from "node:path";

/** `git <args>` in the repo (args may start with -C <dir>); resolves stdout, rejects on a non-zero exit. */
export type PinGit = (args: string[]) => Promise<string>;

export interface Pinned {
  dir: string;
  /** The full 40-char sha HEAD is at. */
  sha: string;
  remove: () => Promise<void>;
}

const SHA = /^[0-9a-f]{7,40}$/;

export async function pinWorktree(o: { repoDir: string; dir: string; sha: string; git: PinGit }): Promise<Pinned> {
  if (!SHA.test(o.sha)) throw new Error(`pin: sha ${JSON.stringify(o.sha)} must be 7 to 40 lowercase hex characters`);
  if (!isAbsolute(o.dir) || !isAbsolute(o.repoDir)) throw new Error("pin: repoDir and dir must be absolute");
  const ref = `${o.sha}^{commit}`;
  const has = () => o.git(["cat-file", "-e", ref]).then(() => true, () => false);
  if (!(await has())) {
    await o.git(["fetch", "origin"]).catch(() => "");
    if (!(await has())) throw new Error(`pin: commit ${o.sha} is not in ${o.repoDir} after one fetch; check repo.json (never falling back to HEAD)`);
  }
  const full = (await o.git(["rev-parse", "--verify", ref])).trim();
  const remove = async () => {
    await o.git(["worktree", "remove", "--force", o.dir]).catch(() => "");
  };
  await o.git(["worktree", "add", "--detach", o.dir, full]);
  const head = (await o.git(["-C", o.dir, "rev-parse", "HEAD"]).catch(() => "")).trim();
  if (head !== full) {
    await remove();
    throw new Error(`pin: the worktree's HEAD is ${head || "(unreadable)"}, not ${full}`);
  }
  return { dir: o.dir, sha: full, remove };
}
