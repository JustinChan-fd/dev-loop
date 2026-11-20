// The loop's fake .envrc for the robot: parsed from the committed
// .envrc.example, every value single-quoted and literal. Temp dirs and fake
// values only; no real env file is ever read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { FAKE_ENV_MARKER, ROBOT_ENV_VAR, fakeEnvPaths, fakeEnvSummary, parseEnvExample, parseEnvTemplate, renderFakeEnvrc, writeFakeEnv, type FakeEnvDeps } from "../../src/core/fake-env.ts";

const DEFAULT_PROFILE = { envTemplate: { path: ".envrc.example", format: "export" as const }, robotEnv: {}, nodeBin: null };
const CATALOG_PROFILE = { envTemplate: { path: "app/.env.example", format: "dotenv" as const }, robotEnv: {}, nodeBin: "/h/.nvm/versions/node/v26.7.0/bin" };

describe("parseEnvExample", () => {
  it("keeps export lines, unwraps matching quotes, keeps $(...) literal", () => {
    const text = [
      "# header",
      "export A=x",
      '  export B="two words"',
      "export C='q'",
      "# export D=1",
      "",
      "FOO=bar",
      "export E=$(echo pwned)",
      "export F=http://localhost:5001/x?y=1  ",
    ].join("\n");
    expect(parseEnvExample(text)).toEqual([
      ["A", "x"],
      ["B", "two words"],
      ["C", "q"],
      ["E", "$(echo pwned)"],
      ["F", "http://localhost:5001/x?y=1"],
    ]);
  });

  it("drops a trailing comment outside quotes, and never overrides names that change how commands run", () => {
    const text = 'export A="a" # note\nexport B=b # note\nexport C="x # y"\nexport PATH=$PATH:./bin\nexport NODE_OPTIONS=--x\nexport LD_PRELOAD=x\nexport DIRENV_DIR=x\nexport HOME=/x';
    expect(parseEnvExample(text)).toEqual([["A", "a"], ["B", "b"], ["C", "x # y"]]);
  });

  it("skips a name that is not a plain identifier", () => {
    expect(parseEnvExample("export 1A=x\nexport A-B=y\nexport OK_1=z")).toEqual([["OK_1", "z"]]);
  });
});

describe("renderFakeEnvrc", () => {
  it("a person (no DEVLOOP_ROBOT_ENV) gets the real .envrc when it exists, and never the fake", () => {
    const out = renderFakeEnvrc([["A", "x"]], "/r/it's");
    expect(out).toContain(`if [ -z "\${${ROBOT_ENV_VAR}:-}" ]; then\n  [ -f '/r/it'\\''s/.envrc' ] && source_env '/r/it'\\''s/.envrc'\n  return 0\nfi\n`);
    expect(out.indexOf("source_env")).toBeLessThan(out.indexOf("export A="));
  });

  it("no nodeBin: no PATH_add line", () => {
    expect(renderFakeEnvrc([["A", "x"]], "/r")).not.toContain("PATH_add");
    expect(renderFakeEnvrc([["A", "x"]], "/r", null)).not.toContain("PATH_add");
  });

  it("a nodeBin puts the project's node on PATH, after the handover (robot only)", () => {
    const bin = "/h/.nvm/versions/node/v26.7.0/bin";
    const out = renderFakeEnvrc([["A", "x"]], "/r", bin);
    const line = `[ -d '${bin}' ] && PATH_add '${bin}'`;
    expect(out).toContain(`${line}\n`);
    expect(out.indexOf(line)).toBeGreaterThan(out.indexOf("return 0\nfi"));
  });

  describe("a real shell", () => {
    let dir: string;
    let file: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "handover-"));
      file = join(dir, "fake.envrc");
      writeFileSync(file, renderFakeEnvrc([["A", "x"]], dir, dir));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const run = (robot: boolean): string => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
      if (robot) env[ROBOT_ENV_VAR] = "1";
      return execFileSync(
        "bash",
        ["-c", 'source_env(){ echo SOURCED "$1"; }; PATH_add(){ echo PATHADD; }; f(){ . "$1"; }; f "$1"; env', "_", file],
        { env, encoding: "utf8" },
      );
    };

    it("a non-robot shell gets no fake values, with or without a real .envrc", () => {
      let out = run(false);
      expect(out).not.toMatch(/^A=/m);
      expect(out).not.toContain("PATHADD");
      expect(out).not.toContain("SOURCED");
      writeFileSync(join(dir, ".envrc"), "export REAL=fake-test-value\n");
      out = run(false);
      expect(out).toContain(`SOURCED ${join(dir, ".envrc")}`);
      expect(out).not.toMatch(/^A=/m);
      expect(out).not.toContain("PATHADD");
    });

    it("the robot gets the fake values and the node PATH", () => {
      const out = run(true);
      expect(out).toMatch(/^A=x$/m);
      expect(out).toContain("PATHADD");
    });
  });

  it("starts with the marker, single-quotes every value, ends with a newline", () => {
    const out = renderFakeEnvrc([["A", "x"], ["B", "it's"], ["C", "$(echo pwned)"]], "/r");
    expect(out.split("\n")[0]).toBe(FAKE_ENV_MARKER);
    expect(out).toContain("export A='x'\n");
    expect(out).toContain("export B='it'\\''s'\n");
    expect(out).toContain("export C='$(echo pwned)'\n");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("an empty list is the marker only", () => {
    expect(renderFakeEnvrc([], "/r").startsWith(`${FAKE_ENV_MARKER}\n`)).toBe(true);
    expect(renderFakeEnvrc([], "/r")).not.toContain("export ");
  });
});

describe("writeFakeEnv", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "fake-env-"));
    await mkdir(join(repo, ".git"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function deps(over: Partial<FakeEnvDeps> = {}) {
    const calls: { git: [string[], string][]; allow: string[] } = { git: [], allow: [] };
    const d: FakeEnvDeps = {
      git: async (args, cwd) => {
        calls.git.push([args, cwd]);
        return "export A=placeholder\nexport B=two\n";
      },
      direnvAllow: async (p) => {
        calls.allow.push(p);
      },
      ...over,
    };
    return { d, calls };
  }

  it("paths sit in <repo>/.claude/worktrees", () => {
    expect(fakeEnvPaths("/r")).toEqual({ envrc: "/r/.claude/worktrees/.envrc" });
  });

  it("writes the fake from origin's example, then allows it", async () => {
    const { d, calls } = deps();
    const r = await writeFakeEnv(repo, "master", DEFAULT_PROFILE, d);
    expect(r).toEqual({ names: ["A", "B"], allowed: true, skipped: false, template: ".envrc.example" });
    expect(calls.git).toEqual([[["show", "origin/master:.envrc.example"], repo]]);
    const p = fakeEnvPaths(repo);
    expect(await readFile(p.envrc, "utf8")).toBe(renderFakeEnvrc([["A", "placeholder"], ["B", "two"]], repo));
    expect(calls.allow).toEqual([p.envrc]);
  });

  it("git failing (no example on origin) gives a marker-only fake, never a throw", async () => {
    const { d } = deps({ git: async () => { throw new Error("fatal: path not in origin/master"); } });
    const r = await writeFakeEnv(repo, "master", DEFAULT_PROFILE, d);
    expect(r.names).toEqual([]);
    expect(await readFile(fakeEnvPaths(repo).envrc, "utf8")).toBe(renderFakeEnvrc([], repo));
  });

  it("direnv missing: files still written, allowed false", async () => {
    const { d } = deps({ direnvAllow: async () => { throw new Error("spawn direnv ENOENT"); } });
    const r = await writeFakeEnv(repo, "master", DEFAULT_PROFILE, d);
    expect(r.allowed).toBe(false);
    expect(await readFile(fakeEnvPaths(repo).envrc, "utf8")).toContain("export A=");
  });

  it("a repo dir with no .git yet (never cloned) is left alone, so a later git clone still works", async () => {
    const fresh = join(repo, "not-cloned");
    const { d, calls } = deps();
    expect(await writeFakeEnv(fresh, "master", DEFAULT_PROFILE, d)).toEqual({ names: [], allowed: false, skipped: true, template: ".envrc.example" });
    expect(existsSync(fresh)).toBe(false);
    expect(calls.git).toEqual([]);
  });

  it("the catalog profile reads its dotenv template from the app folder; robotEnv wins", async () => {
    const { d, calls } = deps({
      git: async (args, cwd) => {
        calls.git.push([args, cwd]);
        return "# c\nAPP_API_URL=http://localhost:4001\nAUTH_SERVER=https://auth.example.test\n";
      },
    });
    const r = await writeFakeEnv(repo, "main", { ...CATALOG_PROFILE, robotEnv: { X: "1", AUTH_SERVER: "fake" } }, d);
    expect(calls.git).toEqual([[["show", "origin/main:app/.env.example"], repo]]);
    expect(r.template).toBe("app/.env.example");
    expect(r.names).toEqual(["APP_API_URL", "AUTH_SERVER", "X"]);
    const text = await readFile(fakeEnvPaths(repo).envrc, "utf8");
    expect(text.match(/^export AUTH_SERVER=/gm)).toHaveLength(1);
    expect(text).toContain("export AUTH_SERVER='fake'\n");
    expect(text).toContain("export X='1'\n");
    expect(text).toContain("PATH_add '/h/.nvm/versions/node/v26.7.0/bin'");
  });

  it("the default profile writes what it always did (apart from the handover)", async () => {
    const { d } = deps();
    await writeFakeEnv(repo, "master", DEFAULT_PROFILE, d);
    const text = await readFile(fakeEnvPaths(repo).envrc, "utf8");
    expect(text.split("\n").filter((l) => l.startsWith("export "))).toEqual(["export A='placeholder'", "export B='two'"]);
    expect(text).not.toContain("PATH_add");
  });

  it("unchanged content is not rewritten but is allowed again", async () => {
    const { d, calls } = deps();
    await writeFakeEnv(repo, "master", DEFAULT_PROFILE, d);
    const before = (await stat(fakeEnvPaths(repo).envrc)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await writeFakeEnv(repo, "master", DEFAULT_PROFILE, d);
    expect((await stat(fakeEnvPaths(repo).envrc)).mtimeMs).toBe(before);
    expect(calls.allow).toHaveLength(2);
  });
});

describe("rootEnvFiles", () => {
  it("skips a name that can't go into a deny rule (space, colon) and *.example", async () => {
    const { rootEnvFiles } = await import("../../src/core/env-files.ts");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const d = mkdtempSync(join(tmpdir(), "env-files-"));
    try {
      for (const n of [".env.local copy", ".env:x", ".env", ".envrc.example"]) writeFileSync(join(d, n), "x");
      expect(rootEnvFiles(d)).toEqual([".env"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("parseEnvTemplate", () => {
  it("dotenv: plain NAME=value lines, the same quote, comment and never-override rules", () => {
    const text = ["# c", "A=x", 'B="two words"', "C='q' ", "# D=1", "export E=y", "F=v # note", 'G="a # b"', "PATH=/evil", "NODE_OPTIONS=--x", "=nov", "H=$(echo pwned)"].join("\r\n");
    expect(parseEnvTemplate(text, "dotenv")).toEqual([
      ["A", "x"],
      ["B", "two words"],
      ["C", "q"],
      ["E", "y"],
      ["F", "v"],
      ["G", "a # b"],
      ["H", "$(echo pwned)"],
    ]);
  });

  it("export: the same as parseEnvExample (plain NAME=value lines are not kept)", () => {
    const text = "export A=x\nFOO=bar\nexport B='y' # n";
    expect(parseEnvTemplate(text, "export")).toEqual(parseEnvExample(text));
    expect(parseEnvTemplate(text, "export")).toEqual([["A", "x"], ["B", "y"]]);
  });
});

describe("fakeEnvSummary", () => {
  it("names the template path, and the node bin when set", () => {
    expect(fakeEnvSummary({ names: ["a", "b", "c", "d", "e", "f"], allowed: true, skipped: false, template: "app/.env.example" })).toBe("robot env: 6 fake setting(s) from app/.env.example");
    expect(fakeEnvSummary({ names: ["a"], allowed: true, skipped: false, template: "app/.env.example", nodeBin: "/n/bin" })).toBe("robot env: 1 fake setting(s) from app/.env.example, node from /n/bin");
  });
});

describe("fakeEnvSummary", () => {
  it("names the count, or why there is no fake yet (never values)", async () => {
    const { fakeEnvSummary } = await import("../../src/core/fake-env.ts");
    expect(fakeEnvSummary({ names: ["A", "B"], allowed: true, skipped: false, template: ".envrc.example" })).toBe("robot env: 2 fake setting(s) from .envrc.example");
    expect(fakeEnvSummary({ names: [], allowed: false, skipped: true, template: ".envrc.example" })).toBe("robot env: repo not cloned yet; the fake is written on the first run after the clone");
    expect(fakeEnvSummary({ names: ["A"], allowed: false, skipped: false, template: ".envrc.example" })).toBe("robot env: 1 fake setting(s) from .envrc.example (direnv allow failed; is direnv installed?)");
  });
});
