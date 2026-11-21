import { describe, expect, it } from "vitest";
import { pinWorktree, type PinGit } from "../../src/eval/pin-repo.ts";

const FULL = "3be2731f" + "0".repeat(32);

/** A scripted git: `have` is whether the commit exists (after `fetched` it may appear). */
function fakeGit(o: { have?: boolean; afterFetch?: boolean; head?: string; addFails?: boolean } = {}) {
  const calls: string[][] = [];
  let fetched = false;
  const git: PinGit = async (args) => {
    calls.push(args);
    const exists = o.have || (fetched && o.afterFetch);
    if (args[0] === "-C" && args.slice(2).join(" ") === "rev-parse HEAD") return `${o.head ?? FULL}\n`;
    if (args[0] === "cat-file") {
      if (!exists) throw new Error("fatal: Not a valid object name");
      return "";
    }
    if (args[0] === "fetch") {
      fetched = true;
      return "";
    }
    if (args[0] === "rev-parse") return `${FULL}\n`;
    if (args[0] === "worktree" && args[1] === "add") {
      if (o.addFails) throw new Error("worktree add failed");
      return "";
    }
    if (args[0] === "worktree" && args[1] === "remove") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { git, calls };
}

const DIR = "/abs/repo/.claude/worktrees/FX-1-20261121T010203Z-ground";

describe("pinWorktree", () => {
  it("present commit: no fetch, detached worktree at the full sha, HEAD checked", async () => {
    const { git, calls } = fakeGit({ have: true });
    const pin = await pinWorktree({ repoDir: "/abs/repo", dir: DIR, sha: "3be2731f", git });
    expect(pin.sha).toBe(FULL);
    expect(calls.some((c) => c[0] === "fetch")).toBe(false);
    expect(calls).toContainEqual(["worktree", "add", "--detach", DIR, FULL]);
    expect(calls).toContainEqual(["-C", DIR, "rev-parse", "HEAD"]);
  });

  it("missing commit: one fetch, then it is used", async () => {
    const { git, calls } = fakeGit({ afterFetch: true });
    await pinWorktree({ repoDir: "/abs/repo", dir: DIR, sha: "3be2731f", git });
    expect(calls.filter((c) => c[0] === "fetch")).toEqual([["fetch", "origin"]]);
  });

  it("still missing after the fetch: a hard error naming the sha, never HEAD", async () => {
    const { git, calls } = fakeGit({});
    await expect(pinWorktree({ repoDir: "/abs/repo", dir: DIR, sha: "3be2731f", git })).rejects.toThrow(/3be2731f.*not in.*after one fetch/);
    expect(calls.some((c) => c[0] === "worktree")).toBe(false);
  });

  it("HEAD not at the sha: removes the worktree and errors", async () => {
    const { git, calls } = fakeGit({ have: true, head: "f".repeat(40) });
    await expect(pinWorktree({ repoDir: "/abs/repo", dir: DIR, sha: "3be2731f", git })).rejects.toThrow(/HEAD/);
    expect(calls).toContainEqual(["worktree", "remove", "--force", DIR]);
  });

  it("remove() runs worktree remove --force and never throws", async () => {
    const { git, calls } = fakeGit({ have: true });
    const pin = await pinWorktree({ repoDir: "/abs/repo", dir: DIR, sha: "3be2731f", git });
    await pin.remove();
    expect(calls.at(-1)).toEqual(["worktree", "remove", "--force", DIR]);
    const failing: PinGit = async (a) => {
      if (a[0] === "worktree" && a[1] === "remove") throw new Error("gone");
      return git(a);
    };
    const pin2 = await pinWorktree({ repoDir: "/abs/repo", dir: DIR, sha: "3be2731f", git: failing });
    await expect(pin2.remove()).resolves.toBeUndefined();
  });

  it("refuses a bad sha or a relative dir before calling git", async () => {
    const { git, calls } = fakeGit({ have: true });
    await expect(pinWorktree({ repoDir: "/abs/repo", dir: DIR, sha: "HEAD", git })).rejects.toThrow(/sha/);
    await expect(pinWorktree({ repoDir: "/abs/repo", dir: "rel", sha: "3be2731f", git })).rejects.toThrow(/absolute/);
    expect(calls).toEqual([]);
  });
});
