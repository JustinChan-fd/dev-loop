import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  UnsafePathError,
  v2RunsLog,
  v1RunsLog,
  v2RunDir,
  v2CloneDir,
  v2SessionsDir,
  runIdNow,
  v1PreCutoverRunsLog,
  v2RunsArchive,
  v2ProjectDir,
  resolveRepoPath,
  TICKET_KEY,
  SESSION_ID,
  PROJECT_SLUG,
  RUN_ID,
  isPipelineWorktree,
  v2FixtureRunDir,
  v2FixtureRunsLog,
  FIXTURE_NAME,
} from "../../src/core/paths.ts";

const RID = "20261111T010203Z";
const BAD = ["../x", "a/b", "/abs", "TARS-1 x", ""];

describe("paths: exact strings", () => {
  it("v2RunsLog", () => expect(v2RunsLog("web")).toBe("runs/v2/web.jsonl"));
  it("v1RunsLog", () => {
    expect(v1RunsLog("research", "web")).toBe("runs/v1/research/web.jsonl");
    expect(v1RunsLog("dev", "web")).toBe("runs/v1/dev/web.jsonl");
  });
  it("v2RunDir", () =>
    expect(v2RunDir("web", "s1", "TARS-12", "dev", RID)).toBe(`.pipeline/v2/web/s1/TARS-12/dev-${RID}`));
  it("v2CloneDir", () => expect(v2CloneDir("web")).toBe(".pipeline/v2/web/repo"));
  it("v2SessionsDir", () => expect(v2SessionsDir("web")).toBe(".pipeline/v2/web/sessions"));
  it("runIdNow", () => expect(runIdNow(new Date("2026-11-11T01:02:03.456Z"))).toBe(RID));
  it("no legacy (cwd-relative) path functions remain", async () => {
    const mod = await import("../../src/core/paths.ts");
    expect(Object.keys(mod).filter((k) => /^legacy/.test(k))).toEqual([]);
  });
  it("v2RunsArchive", () => expect(v2RunsArchive("web")).toBe("runs/v2/web.reset-archive.jsonl"));
  it("v2ProjectDir", () => expect(v2ProjectDir("web")).toBe(".pipeline/v2/web"));
  it("v1PreCutoverRunsLog: the pre-cutover live v1 logs, repo-root-relative", () => {
    expect(v1PreCutoverRunsLog("dev", "web")).toBe("runs/web.jsonl");
    expect(v1PreCutoverRunsLog("research", "web")).toBe("research-loop/runs/web.jsonl");
  });
  it("resolveRepoPath accepts the pre-cutover v1 logs", () => {
    expect(resolveRepoPath(v1PreCutoverRunsLog("research", "web"))).toBe(
      resolve(import.meta.dirname, "../..", "research-loop/runs/web.jsonl"),
    );
  });
  it("resolveRepoPath is absolute under the repo root", () => {
    expect(resolveRepoPath(v2CloneDir("web"))).toBe(resolve(import.meta.dirname, "../..", ".pipeline/v2/web/repo"));
  });
});

describe("paths: validation", () => {
  for (const bad of BAD) {
    const label = JSON.stringify(bad);
    it(`rejects ${label} for every argument`, () => {
      expect(() => v2RunsLog(bad)).toThrow(UnsafePathError);
      expect(() => v1RunsLog("dev", bad)).toThrow(UnsafePathError);
      expect(() => v2CloneDir(bad)).toThrow(UnsafePathError);
      expect(() => v2SessionsDir(bad)).toThrow(UnsafePathError);
      expect(() => v2RunDir(bad, "s1", "TARS-1", "dev", RID)).toThrow(UnsafePathError);
      expect(() => v2RunDir("web", bad, "TARS-1", "dev", RID)).toThrow(UnsafePathError);
      expect(() => v2RunDir("web", "s1", bad, "dev", RID)).toThrow(UnsafePathError);
      expect(() => v2RunDir("web", "s1", "TARS-1", bad as never, RID)).toThrow(UnsafePathError);
      expect(() => v2RunDir("web", "s1", "TARS-1", "dev", bad)).toThrow(UnsafePathError);
      expect(() => v2RunsArchive(bad)).toThrow(UnsafePathError);
      expect(() => v2ProjectDir(bad)).toThrow(UnsafePathError);
      expect(() => v1PreCutoverRunsLog("dev", bad)).toThrow(UnsafePathError);
      expect(() => v1RunsLog(bad as never, "web")).toThrow(UnsafePathError);
    });
  }
  it("rejects a bad phase and malformed runId", () => {
    expect(() => v2RunDir("web", "s1", "TARS-1", "qa" as never, RID)).toThrow(UnsafePathError);
    expect(() => v2RunDir("web", "s1", "TARS-1", "dev", "2026-11-11")).toThrow(UnsafePathError);
  });
  it("rejects absolute and escaping paths in resolveRepoPath", () => {
    expect(() => resolveRepoPath("../outside")).toThrow(UnsafePathError);
    expect(() => resolveRepoPath("/etc/passwd")).toThrow(UnsafePathError);
  });
  it("exports the identifier regexes", () => {
    expect(TICKET_KEY.test("TARS-1465")).toBe(true);
    expect(SESSION_ID.test("a1-b")).toBe(true);
    expect(SESSION_ID.test("-a")).toBe(false);
    expect(PROJECT_SLUG.test("web-tars")).toBe(true);
    expect(RUN_ID.test(RID)).toBe(true);
  });
});

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("paths: no path literals outside paths.ts", () => {
  const FORBIDDEN = [/["'`]\.pipeline/, /["'`]runs\//, /["'`]runs["'`]/];
  it("src has none", () => {
    const hits: string[] = [];
    for (const f of tsFiles(resolve(import.meta.dirname, "../../src"))) {
      if (f.endsWith("/core/paths.ts")) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
          if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${f}:${i + 1}: ${t}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("isPipelineWorktree -push", () => {
  it("accepts the host push worktree suffix", () => {
    expect(isPipelineWorktree("TARS-1", "TARS-1-20261117T090121Z-push")).toBe(true);
    expect(isPipelineWorktree("TARS-1", "TARS-1-20261117T090121Z-pushy")).toBe(false);
  });
});

describe("fixture paths (eval fixtures)", () => {
  it("v2FixtureRunDir: .pipeline/v2/fixtures/<fixture>/<ticket>/research-<runId>", () => {
    expect(v2FixtureRunDir("mc-1718", "FX-1", RID)).toBe(`.pipeline/v2/fixtures/mc-1718/FX-1/research-${RID}`);
  });
  it("v2FixtureRunsLog: runs/v2/fixtures/<fixture>.jsonl, never the project log", () => {
    expect(v2FixtureRunsLog("mc-1718")).toBe("runs/v2/fixtures/mc-1718.jsonl");
  });
  it("rejects a bad fixture name, ticket or run id", () => {
    for (const bad of ["../x", "a/b", "Up", "", "-x"]) {
      expect(() => v2FixtureRunDir(bad, "FX-1", RID)).toThrow(UnsafePathError);
      expect(() => v2FixtureRunsLog(bad)).toThrow(UnsafePathError);
    }
    expect(() => v2FixtureRunDir("a", "fx-1", RID)).toThrow(UnsafePathError);
    expect(() => v2FixtureRunDir("a", "FX-1", "x")).toThrow(UnsafePathError);
  });
  it("FIXTURE_NAME: lowercase, digits and dashes", () => {
    expect(FIXTURE_NAME.test("mc-1435-xl")).toBe(true);
    expect(FIXTURE_NAME.test("-x")).toBe(false);
  });
  it("resolveRepoPath accepts fixture paths", () => {
    expect(resolveRepoPath(v2FixtureRunsLog("a"))).toBe(resolve(import.meta.dirname, "../..", "runs/v2/fixtures/a.jsonl"));
  });
});
