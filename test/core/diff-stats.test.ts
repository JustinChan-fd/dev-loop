import { describe, it, expect, vi } from "vitest";
import { parsePrDiffStats, realPrDiffStats, diffStatsSidecarPath } from "../../src/core/diff-stats.ts";

describe("parsePrDiffStats", () => {
  it("reads gh's changedFiles/additions/deletions", () => {
    expect(parsePrDiffStats('{"changedFiles":29,"additions":2400,"deletions":110}')).toEqual({ files: 29, additions: 2400, deletions: 110 });
  });
  it("malformed JSON is null", () => {
    expect(parsePrDiffStats("not json")).toBeNull();
  });
  it("a missing field or a negative/non-integer number is null", () => {
    expect(parsePrDiffStats('{"changedFiles":1,"additions":2}')).toBeNull();
    expect(parsePrDiffStats('{"changedFiles":-1,"additions":2,"deletions":0}')).toBeNull();
    expect(parsePrDiffStats('{"changedFiles":1.5,"additions":2,"deletions":0}')).toBeNull();
    expect(parsePrDiffStats("null")).toBeNull();
  });
});

describe("realPrDiffStats", () => {
  it("asks gh for exactly the three fields of that PR", async () => {
    const exec = vi.fn(async () => '{"changedFiles":3,"additions":40,"deletions":2}');
    const url = "https://github.com/org/repo/pull/9";
    expect(await realPrDiffStats(exec)(url)).toEqual({ files: 3, additions: 40, deletions: 2 });
    expect(exec).toHaveBeenCalledWith(["pr", "view", url, "--json", "changedFiles,additions,deletions"]);
  });
  it("a failing gh is null, never a throw", async () => {
    const exec = vi.fn(async () => { throw new Error("gh: not found"); });
    expect(await realPrDiffStats(exec)("https://github.com/org/repo/pull/9")).toBeNull();
  });
});

describe("diffStatsSidecarPath", () => {
  it("sits next to the log", () => {
    expect(diffStatsSidecarPath("runs/v2/webtarsthree.jsonl")).toBe("runs/v2/webtarsthree.diff-stats.json");
    expect(diffStatsSidecarPath("runs/v1/dev/webtarsthree.jsonl")).toBe("runs/v1/dev/webtarsthree.diff-stats.json");
  });
});
