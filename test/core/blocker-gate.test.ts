import { describe, it, expect, vi } from "vitest";
import { isBlockerCleared, gateTicket, type BlockerGateDeps } from "../../src/core/blocker-gate.ts";
import { StubJiraClient } from "../../src/core/jira-client.ts";
import type { ExecGhFindMergedPrFn, ExecGhPrViewFn } from "../../src/core/github-client.ts";

const REPO = "org/repo";

function deps(o: Partial<BlockerGateDeps> = {}): BlockerGateDeps {
  return {
    repo: REPO,
    projectKey: "TARS",
    findLandedPrUrl: vi.fn(async () => null),
    execGhPrView: vi.fn<ExecGhPrViewFn>(async () => JSON.stringify({ state: "OPEN", mergedAt: null })),
    execGhFindMergedPr: vi.fn<ExecGhFindMergedPrFn>(async () => null),
    defaultBranch: "main",
    mergedCache: new Map(),
    ...o,
  };
}

const merged = (url: string, baseRefName = "main") => ({ url, mergedAt: "2026-01-01T00:00:00Z", baseRefName });

describe("isBlockerCleared", () => {
  it("merged via search into the default branch -> cleared", async () => {
    const d = deps({ execGhFindMergedPr: vi.fn(async () => merged("https://github.com/org/repo/pull/5")) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(true);
    expect(r.reason).toContain("https://github.com/org/repo/pull/5");
    expect(d.execGhFindMergedPr).toHaveBeenCalledWith("TARS-1", { baseRefName: "main" });
  });

  it("recorded PR closed unmerged but search finds a merged one -> cleared", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/470"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "CLOSED", mergedAt: null })),
      execGhFindMergedPr: vi.fn(async () => merged("https://github.com/org/repo/pull/476")),
    });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(true);
    expect(r.reason).toContain("pull/476");
  });

  it("recorded PR has mergedAt (search finds nothing) -> cleared", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/9"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", baseRefName: "main" })),
    });
    expect((await isBlockerCleared("TARS-1", d)).cleared).toBe(true);
  });

  it("recorded PR URL matching the repo case-insensitively still counts", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/Org/Repo/pull/9"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", baseRefName: "main" })),
    });
    expect((await isBlockerCleared("TARS-1", d)).cleared).toBe(true);
  });

  it("a recorded PR from another repo is ignored even if merged (falls through to the search)", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/other/repo/pull/1"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", baseRefName: "main" })),
    });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toContain("needs a human");
    expect(d.execGhPrView).not.toHaveBeenCalled();
    expect(d.execGhFindMergedPr).toHaveBeenCalled();
  });

  it("a recorded value that is not a PR URL (e.g. starts with -) never reaches gh", async () => {
    const d = deps({ findLandedPrUrl: vi.fn(async () => "--repo=evil/x") });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(d.execGhPrView).not.toHaveBeenCalled();
  });

  it("a recorded PR merged into a non-default base is not cleared", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/9"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", baseRefName: "release/x" })),
    });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toContain("needs a human");
  });

  it("a recorded merged PR with no baseRefName in gh's output is not cleared", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/9"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" })),
    });
    expect((await isBlockerCleared("TARS-1", d)).cleared).toBe(false);
  });

  it("an invalid blocker key is not cleared, gh is not called, and the key is not echoed raw", async () => {
    const d = deps();
    const bad = "TARS-1\nInjected line " + "y".repeat(300);
    const r = await isBlockerCleared(bad, d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toMatch(/^blocker ".*" check failed: invalid key$/);
    expect(r.reason).not.toContain("\n");
    expect(r.reason.length).toBeLessThan(120);
    expect(d.execGhFindMergedPr).not.toHaveBeenCalled();
    expect(d.findLandedPrUrl).not.toHaveBeenCalled();
  });

  it("open PR -> not cleared, reason names the PR", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/12"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "OPEN", mergedAt: null })),
    });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r).toEqual({ cleared: false, reason: "blocker TARS-1 PR open: https://github.com/org/repo/pull/12" });
  });

  it("no PR at all -> not cleared, the needs-a-human reason", async () => {
    const r = await isBlockerCleared("TARS-1", deps());
    expect(r).toEqual({
      cleared: false,
      reason: "blocker TARS-1 has no merged PR in org/repo — needs a human (Done without a PR, or another repo)",
    });
  });

  it("gh throws -> not cleared, error in reason, redacted and capped", async () => {
    const long = "gh: HTTP 502 for someone@example.com " + "x".repeat(500);
    const d = deps({ execGhFindMergedPr: vi.fn(async () => { throw new Error(long); }) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(r.reason.startsWith("blocker TARS-1 check failed: gh: HTTP 502")).toBe(true);
    expect(r.reason).not.toContain("someone@example.com");
    expect(r.reason.length).toBeLessThanOrEqual("blocker TARS-1 check failed: ".length + 200);
  });

  it("findLandedPrUrl throws -> not cleared (fail closed)", async () => {
    const d = deps({ findLandedPrUrl: vi.fn(async () => { throw new Error("EACCES"); }) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r).toEqual({ cleared: false, reason: "blocker TARS-1 check failed: EACCES" });
  });

  it("unparseable gh pr view output -> not cleared (fail closed)", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/12"),
      execGhPrView: vi.fn(async () => "not json"),
    });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toMatch(/^blocker TARS-1 check failed: /);
  });

  it("a blocker from another Jira project (MC-9) is not cleared, needs a human, and gh is not called", async () => {
    const d = deps({ projectKey: "TARS", execGhFindMergedPr: vi.fn(async () => merged("u")) });
    const r = await isBlockerCleared("MC-9", d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toContain("needs a human");
    expect(r.reason).toBe("blocker MC-9 has no merged PR in org/repo — needs a human (Done without a PR, or another repo)");
    expect(d.execGhFindMergedPr).not.toHaveBeenCalled();
    expect(d.findLandedPrUrl).not.toHaveBeenCalled();
  });

  it("a merged PR into a non-default base is not cleared", async () => {
    const d = deps({ execGhFindMergedPr: vi.fn(async () => merged("https://github.com/org/repo/pull/7", "release/1.2")) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toContain("needs a human");
  });

  it("a cached merged result skips the gh call on the second check", async () => {
    const d = deps({ execGhFindMergedPr: vi.fn(async () => merged("https://github.com/org/repo/pull/5")) });
    expect((await isBlockerCleared("TARS-1", d)).cleared).toBe(true);
    expect(d.mergedCache.get("org/repo#TARS-1")).toBe("https://github.com/org/repo/pull/5");
    expect(d.mergedCache.has("TARS-1")).toBe(false);
    const second = await isBlockerCleared("TARS-1", d);
    expect(second.cleared).toBe(true);
    expect(d.execGhFindMergedPr).toHaveBeenCalledTimes(1);
    expect(d.findLandedPrUrl).toHaveBeenCalledTimes(1);
  });

  it("a cache entry for another repo does not clear the blocker here", async () => {
    const d = deps({ mergedCache: new Map([["other/repo#TARS-1", "https://github.com/other/repo/pull/1"]]) });
    expect((await isBlockerCleared("TARS-1", d)).cleared).toBe(false);
    expect(d.execGhFindMergedPr).toHaveBeenCalled();
  });

  it("failures and not-cleared results are never cached", async () => {
    const d = deps({ execGhFindMergedPr: vi.fn(async () => { throw new Error("boom"); }) });
    await isBlockerCleared("TARS-1", d);
    await isBlockerCleared("TARS-1", deps({ mergedCache: d.mergedCache }));
    expect(d.mergedCache.size).toBe(0);
  });

  it("TARS-1 vs a merged TARS-12 branch is not cleared (whole-token match, real finder)", async () => {
    const { realExecGhFindMergedPr } = await import("../../src/core/github-client.ts");
    const exec = vi.fn(async () =>
      JSON.stringify([
        { url: "u12", mergedAt: "2026-01-01T00:00:00Z", title: "TARS-12: thing", headRefName: "feature/TARS-12-thing", baseRefName: "main" },
      ]),
    );
    const d = deps({ execGhFindMergedPr: realExecGhFindMergedPr(REPO, exec) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
  });
});

describe("gateTicket", () => {
  it("two blockers, one cleared and one not -> pass:false, blockedBy:[TARS-2]", async () => {
    const jira = new StubJiraClient({ blockedBy: { "TARS-5": ["TARS-1", "TARS-2"] } });
    const d = deps({
      execGhFindMergedPr: vi.fn(async (k: string) => (k === "TARS-1" ? merged("https://github.com/org/repo/pull/1") : null)),
    });
    const r = await gateTicket("TARS-5", { ...d, jira });
    expect(r).toEqual({
      pass: false,
      blockedBy: ["TARS-2"],
      reasons: ["blocker TARS-2 has no merged PR in org/repo — needs a human (Done without a PR, or another repo)"],
    });
  });

  it("no blockers -> pass", async () => {
    const jira = new StubJiraClient({ blockedBy: {} });
    expect(await gateTicket("TARS-5", { ...deps(), jira })).toEqual({ pass: true });
  });

  it("all blockers cleared -> pass", async () => {
    const jira = new StubJiraClient({ blockedBy: { "TARS-5": ["TARS-1", "TARS-2"] } });
    const d = deps({ execGhFindMergedPr: vi.fn(async (k: string) => merged(`https://github.com/org/repo/pull/${k}`)) });
    expect(await gateTicket("TARS-5", { ...d, jira })).toEqual({ pass: true });
  });

  it("getBlockedBy throws -> fail closed (not pass), reason names the ticket", async () => {
    const jira = new StubJiraClient({ blockedBy: {} });
    jira.getBlockedBy = vi.fn(async () => { throw new Error("Jira 503"); });
    const r = await gateTicket("TARS-5", { ...deps(), jira });
    expect(r.pass).toBe(false);
    if (!r.pass) {
      expect(r.blockedBy).toEqual([]);
      expect(r.reasons).toEqual(["blockers of TARS-5 check failed: Jira 503"]);
    }
  });

  it("derives projectKey from the ticket key: a cross-project blocker is not cleared", async () => {
    const jira = new StubJiraClient({ blockedBy: { "TARS-5": ["MC-9"] } });
    const d = deps({ execGhFindMergedPr: vi.fn(async () => merged("u")) });
    const r = await gateTicket("TARS-5", { ...d, jira });
    expect(r).toEqual({
      pass: false,
      blockedBy: ["MC-9"],
      reasons: ["blocker MC-9 has no merged PR in org/repo — needs a human (Done without a PR, or another repo)"],
    });
    expect(d.execGhFindMergedPr).not.toHaveBeenCalled();
  });
});

describe("blocker cleared by Jira status (jira.blockerClearedStatuses)", () => {
  const LIST = ["Development Complete", "Deployed to INT"];
  const status = (name: string, done = false) => vi.fn(async () => ({ name, done }));
  const NEEDS = "blocker MC-9 has no merged PR in org/repo — needs a human (Done without a PR, or another repo)";

  it("a cross-project blocker in a listed status is cleared, and gh is not called", async () => {
    const d = deps({ clearedStatuses: LIST, getBlockerStatus: status("Deployed to INT") });
    const r = await isBlockerCleared("MC-9", d);
    expect(r).toEqual({ cleared: true, reason: "blocker MC-9 is Deployed to INT (in jira.blockerClearedStatuses)" });
    expect(d.execGhFindMergedPr).not.toHaveBeenCalled();
  });

  it("a blocker in Jira's Done category is cleared", async () => {
    const d = deps({ clearedStatuses: LIST, getBlockerStatus: status("Closed", true) });
    const r = await isBlockerCleared("MC-9", d);
    expect(r).toEqual({ cleared: true, reason: "blocker MC-9 is Closed (Done)" });
  });

  it("a blocker in an unlisted status stays blocked, and the reason names its status", async () => {
    const d = deps({ clearedStatuses: LIST, getBlockerStatus: status("In Progress") });
    const r = await isBlockerCleared("MC-9", d);
    expect(r).toEqual({ cleared: false, reason: `${NEEDS}; its status In Progress is not in jira.blockerClearedStatuses` });
  });

  it("a same-project blocker with an open PR and an unlisted status stays blocked", async () => {
    const d = deps({
      clearedStatuses: LIST,
      getBlockerStatus: status("Code Review"),
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/7"),
    });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toBe("blocker TARS-1 PR open: https://github.com/org/repo/pull/7; its status Code Review is not in jira.blockerClearedStatuses");
  });

  it("a same-project blocker with a merged PR is cleared by the PR, without a status read", async () => {
    const getBlockerStatus = status("In Progress");
    const d = deps({ clearedStatuses: LIST, getBlockerStatus, execGhFindMergedPr: vi.fn(async () => merged("https://github.com/org/repo/pull/3")) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r).toEqual({ cleared: true, reason: "blocker TARS-1 merged: https://github.com/org/repo/pull/3" });
    expect(getBlockerStatus).not.toHaveBeenCalled();
  });

  it("a status read that throws fails closed, and the reason says so", async () => {
    const d = deps({ clearedStatuses: LIST, getBlockerStatus: vi.fn(async () => { throw new Error("Jira 503"); }) });
    const r = await isBlockerCleared("MC-9", d);
    expect(r).toEqual({ cleared: false, reason: `${NEEDS}; its status check failed: Jira 503` });
  });

  it("without the list, the status is never read (today's behaviour)", async () => {
    const getBlockerStatus = status("Deployed to INT");
    const r = await isBlockerCleared("MC-9", deps({ getBlockerStatus }));
    expect(r).toEqual({ cleared: false, reason: NEEDS });
    expect(getBlockerStatus).not.toHaveBeenCalled();
  });

  it("a status clear is not cached (a status can move back)", async () => {
    const d = deps({ clearedStatuses: LIST, getBlockerStatus: status("Deployed to INT") });
    await isBlockerCleared("MC-9", d);
    expect(d.mergedCache.size).toBe(0);
  });

  it("status names match exactly (case and spacing matter)", async () => {
    const d = deps({ clearedStatuses: LIST, getBlockerStatus: status("deployed to int") });
    expect((await isBlockerCleared("MC-9", d)).cleared).toBe(false);
  });

  it("gateTicket reads the blocker's status through jira.getStatusDetail", async () => {
    const jira = new StubJiraClient({ blockedBy: { "MC-5": ["MC-1431"] }, statusDetail: { "MC-1431": { name: "Deployed to INT", done: false } } });
    const r = await gateTicket("MC-5", { ...deps(), clearedStatuses: LIST, jira });
    expect(r).toEqual({ pass: true });
  });
});
