import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeArgs,
  overnightArgv,
  isSafeBranchName,
  isSafeSessionName,
  realEnvFilesUnder,
  safeReportNames,
  overnightPromptFile,
  parseSandboxCheck,
  protectedHits,
  renderSyncSummary,
  resolvePlugins,
  SANDBOX_OVERNIGHT_DIR,
  SANDBOX_PLUGINS_DIR,
  SESSION_PREFIX,
  sessionCreateArgs,
  sessionName,
  validateSessionConfig,
  type BranchSync,
} from "../../../src/sandbox/sbx/session.ts";
import { DEFAULT_ENV_ALLOW } from "../../../src/sandbox/sbx/config.ts";

const RAW = {
  sandbox: { sbx: { kitDir: "/kit", template: "docker.io/library/dev-loop-sbx:v2", memory: "8g" } },
  session: {
    denyNetwork: ["github.com", "api.github.com"],
    protectedPaths: [".claude/settings.json", ".claude/hooks/", "scripts/check-*", "CLAUDE.md"],
    plugins: ["superpowers@claude-plugins-official"],
    npmRegistry: "https://nexus3.mgo.com/repository/fd-npm-all/",
  },
};

describe("validateSessionConfig", () => {
  it("reads the sbx block with the same rules as a project's sandbox.sbx", () => {
    const c = validateSessionConfig(RAW);
    expect(c.sbx.kitDir).toBe("/kit");
    expect(c.sbx.envAllow).toEqual(DEFAULT_ENV_ALLOW);
    expect(c.denyNetwork).toEqual(["github.com", "api.github.com"]);
    expect(c.plugins).toEqual(["superpowers@claude-plugins-official"]);
    expect(c.npmRegistry).toBe("https://nexus3.mgo.com/repository/fd-npm-all/");
  });
  it("expands ~/ in kitDir like a project config", () => {
    const c = validateSessionConfig({ ...RAW, sandbox: { sbx: { kitDir: "~/kit" } } });
    expect(c.sbx.kitDir).toBe(join(homedir(), "kit"));
  });
  it("refuses an sbx block the project validator refuses", () => {
    expect(() => validateSessionConfig({ ...RAW, sandbox: { sbx: { kitDir: "/k", envAllow: ["GH_TOKEN"] } } })).toThrow(/secret-shaped/);
  });
  it("refuses unknown session keys", () => {
    expect(() => validateSessionConfig({ ...RAW, session: { ...RAW.session, mountHome: true } })).toThrow('session: unknown key "mountHome"');
  });
  it("requires GitHub to be denied (the sandbox never pushes)", () => {
    expect(() => validateSessionConfig({ ...RAW, session: { ...RAW.session, denyNetwork: ["github.com"] } })).toThrow(/api\.github\.com/);
  });
  it("refuses a deny host that is not a plain DNS name", () => {
    expect(() => validateSessionConfig({ ...RAW, session: { ...RAW.session, denyNetwork: ["github.com", "api.github.com", "--allow-network"] } })).toThrow(/host name/);
  });
  it("refuses protected paths that are absolute, climb out, or are empty", () => {
    for (const bad of ["/etc", "../x", "", "a/../../b"]) {
      expect(() => validateSessionConfig({ ...RAW, session: { ...RAW.session, protectedPaths: [bad] } })).toThrow(/protectedPaths/);
    }
  });
  it("refuses a plugin that is not name@marketplace", () => {
    expect(() => validateSessionConfig({ ...RAW, session: { ...RAW.session, plugins: ["../evil"] } })).toThrow(/plugins/);
  });
  it("refuses an npm registry that is not https", () => {
    expect(() => validateSessionConfig({ ...RAW, session: { ...RAW.session, npmRegistry: "http://x/" } })).toThrow(/npmRegistry/);
  });
  it("reads the committed sbx.session.config.json", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(join(import.meta.dirname, "../../../sbx.session.config.json"), "utf8"));
    const c = validateSessionConfig(raw);
    expect(c.denyNetwork).toEqual(expect.arrayContaining(["github.com", "api.github.com"]));
    expect(c.protectedPaths).toEqual(expect.arrayContaining([".claude/", "CLAUDE.md", "scripts/check-*", ".github/", "package.json", "sbx.session.config.json"]));
  });
});

describe("sessionName", () => {
  it("is the session prefix plus a sortable UTC stamp, within sbx's name rules", () => {
    const n = sessionName(new Date("2026-11-20T22:45:01Z"));
    expect(n).toBe(`${SESSION_PREFIX}20261120-224501`);
    expect(n).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  });
});

describe("resolvePlugins", () => {
  const installed = { version: 2, plugins: { "superpowers@claude-plugins-official": [{ installPath: "/p/superpowers/7.0.2", version: "7.0.2" }] } };
  it("finds each named plugin's install folder", () => {
    expect(resolvePlugins(installed, ["superpowers@claude-plugins-official"])).toEqual([{ name: "superpowers", dir: "/p/superpowers/7.0.2" }]);
  });
  it("throws, naming the plugin, when it isn't installed", () => {
    expect(() => resolvePlugins(installed, ["nope@x"])).toThrow(/nope@x is not installed/);
  });
  it("throws on a registry it can't read", () => {
    expect(() => resolvePlugins(null, ["superpowers@claude-plugins-official"])).toThrow(/installed_plugins/);
  });
});

describe("sessionCreateArgs", () => {
  const cfg = validateSessionConfig(RAW);
  const args = sessionCreateArgs("dl-session-x", cfg, "/r", [{ name: "superpowers", dir: "/p/sp" }]);
  it("clones the repo instead of mounting it writable, and denies GitHub", () => {
    const i = args.indexOf("claude");
    const before = args.slice(0, i);
    expect(before).toContain("--clone");
    expect(before.join(" ")).toContain("--deny-network github.com --deny-network api.github.com");
    expect(args.slice(i)).toEqual([
      "claude", "--kit", "/kit", "/r",
      `/r/.overnight/in:${SANDBOX_OVERNIGHT_DIR}/in:ro`,
      `/r/.overnight/out:${SANDBOX_OVERNIGHT_DIR}/out`,
      `/p/sp:${SANDBOX_PLUGINS_DIR}/superpowers:ro`,
    ]);
  });
  it("keeps the project's template and memory flags", () => {
    expect(args.join(" ")).toContain("--memory 8g");
    expect(args.join(" ")).toContain("-t docker.io/library/dev-loop-sbx:v2 --pull never");
  });
  it("has no MCP (no Jira in a dev-loop session)", () => {
    expect(args).not.toContain("--static-mcp");
  });
});

describe("claudeArgs", () => {
  it("loads each mounted plugin by its in-sandbox folder", () => {
    expect(claudeArgs([{ name: "superpowers", dir: "/p" }])).toEqual(["--plugin-dir", `${SANDBOX_PLUGINS_DIR}/superpowers`]);
  });
});

describe("parseSandboxCheck", () => {
  it("passes on linux with /home/agent, no ssh key and a read-only clone source", () => {
    expect(parseSandboxCheck("os=Linux\nhome=yes\nsshkeys=0\nsource=ro\ngithub=blocked\n")).toEqual({ ok: true, reasons: [] });
  });
  it("fails on a Mac (the session is not in a sandbox)", () => {
    const r = parseSandboxCheck("os=Darwin\nhome=no\nsshkeys=2\nsource=missing\ngithub=open\n");
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      "not Linux (os=Darwin)",
      "no /home/agent",
      "2 readable SSH private keys",
      "not a --clone sandbox (no /run/sandbox/source)",
      "GitHub is reachable (it must be denied)",
    ]);
  });
  it("fails when the host checkout is writable from inside", () => {
    expect(parseSandboxCheck("os=Linux\nhome=yes\nsshkeys=0\nsource=rw\ngithub=blocked\n").reasons).toEqual(["the host checkout is writable from inside"]);
  });
  it("fails closed on output it can't read", () => {
    expect(parseSandboxCheck("").ok).toBe(false);
    expect(parseSandboxCheck("os=Linux\nhome=yes\n").reasons).toContain("check output incomplete");
  });
});

describe("overnightPromptFile", () => {
  const real = (p: string): string => p;
  it("accepts a file under .overnight/in", () => {
    expect(overnightPromptFile("/r", ".overnight/in/plan.md", real)).toBe("/r/.overnight/in/plan.md");
  });
  it("refuses a file anywhere else, even through ..", () => {
    expect(() => overnightPromptFile("/r", "README.md", real)).toThrow(/\.overnight\/in/);
    expect(() => overnightPromptFile("/r", ".overnight/in/../../etc/x", real)).toThrow(/\.overnight\/in/);
  });
  it("refuses a symlink that leaves .overnight/in", () => {
    expect(() => overnightPromptFile("/r", ".overnight/in/link.md", () => "/Users/me/.ssh/id_ed25519")).toThrow(/\.overnight\/in/);
  });
});

describe("protectedHits", () => {
  const P = [".claude/settings.json", ".claude/hooks/", "scripts/check-*", "CLAUDE.md"];
  it("matches exact files, folders and prefixes", () => {
    expect(protectedHits(["src/a.ts", "CLAUDE.md", ".claude/hooks/x.sh", "scripts/check-secret.ts", ".claude/settings.json"], P)).toEqual([
      "CLAUDE.md", ".claude/hooks/x.sh", "scripts/check-secret.ts", ".claude/settings.json",
    ]);
  });
  it("matches case variants and ./ prefixes (the Mac disk folds case)", () => {
    expect(protectedHits(["claude.md", "./CLAUDE.md", ".Claude/Hooks/x"], P)).toEqual(["claude.md", "./CLAUDE.md", ".Claude/Hooks/x"]);
  });
  it("does not match look-alikes", () => {
    expect(protectedHits(["docs/CLAUDE.md", ".claude/settings.json.bak", ".claude/hooksy", "scripts/checker.ts"], P)).toEqual([]);
  });
});

describe("isSafeBranchName", () => {
  it("accepts ordinary branch names", () => {
    for (const b of ["feat/run-watcher", "fix/a_b.c", "x"]) expect(isSafeBranchName(b)).toBe(true);
  });
  it("refuses anything that could act as a flag or shell text when printed in a command", () => {
    for (const b of ["-x", "a b", "a;rm", "$(x)", "a..b", "a/", "/a", "HEAD", "a.lock", "a`b", "", "refs/x", "tags/x", "x/HEAD", "heads/x", "remotes/o/x"]) expect(isSafeBranchName(b)).toBe(false);
  });
});

describe("renderSyncSummary", () => {
  const ok: BranchSync = { branch: "feat/run-watcher", status: "synced", commits: 3, adds: 120, dels: 4, files: 7, hits: [] };
  const prot: BranchSync = { branch: "feat/x", status: "protected", commits: 1, adds: 2, dels: 0, files: 1, hits: ["CLAUDE.md"] };
  it("prints the header, one line per branch, and the next steps", () => {
    const s = renderSyncSummary("dl-session-1", [ok, prot], [".overnight/out/report.md"]);
    expect(s).toContain('Synced from sandbox "dl-session-1" (checked and re-signed, nothing pushed):');
    expect(s).toMatch(/feat\/run-watcher\s+3 commits\s+\+120 −4\s+7 files\s+✓ no protected files/);
    expect(s).toMatch(/feat\/x\s+1 commit\s+\+2 −0\s+1 file\s+⚠ CLAUDE\.md \(needs --allow-protected\)/);
    expect(s).toContain("Report: .overnight/out/report.md");
    expect(s).toContain("git diff main...feat/run-watcher");
  });
  it("diffs from the host commit the work grew from, when sync knows it (a branch cut from an unmerged one)", () => {
    const s = renderSyncSummary("n", [{ ...ok, base: "abc1234def5678" }], []);
    expect(s).toContain("git diff abc1234def5678..feat/run-watcher");
    expect(s).not.toContain("git diff main...feat/run-watcher");
    expect(s).toContain("git push -u origin feat/run-watcher && gh pr create");
    expect(s).toContain("git branch -D feat/run-watcher");
  });
  it("names the held branch's own base in the read-first line", () => {
    const s = renderSyncSummary("n", [{ ...prot, base: "fff0000" }], []);
    expect(s).toContain("git log -p fff0000..sandbox-n/feat/x");
  });
  it("gives no keep/drop lines for a branch it didn't create locally", () => {
    const s = renderSyncSummary("n", [prot], []);
    expect(s).not.toContain("git push -u origin feat/x");
    expect(s).toContain("npm run claude:sbx:sync -- --name=n --allow-protected");
    expect(s).toContain("git log -p main..sandbox-n/feat/x");
    expect(s).not.toContain("<branch>");
  });
  it("says so when there is nothing new", () => {
    expect(renderSyncSummary("n", [], [])).toContain('No new branches in sandbox "n".');
  });
  it("shows a branch it left alone with the reason", () => {
    const s = renderSyncSummary("n", [{ ...ok, status: "exists", detail: "a local feat/run-watcher already differs" }], []);
    expect(s).toContain("✗ a local feat/run-watcher already differs");
    expect(s).not.toContain("git push -u origin feat/run-watcher");
  });
});

describe("overnightArgv", () => {
  it("never lets claude -p stop its own background subagents (run 1 died at the 10-minute default)", () => {
    const v = overnightArgv({ name: "n", repo: "/r", env: ["-e", "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"], agent: [], ask: "x", log: "/l" });
    const at = v.indexOf("exec");
    const execArgs = v.slice(at, v.indexOf("n", at));
    expect(execArgs).toContain("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0");
    // A host value passed by name would override ours; it is dropped.
    expect(execArgs.filter((x) => x.startsWith("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"))).toEqual(["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0"]);
  });
  const argv = overnightArgv({ name: "dl-session-1", repo: "/r", env: ["-e", "ANTHROPIC_DEFAULT_OPUS_MODEL"], agent: ["--plugin-dir", "/p"], ask: "do it", log: "/r/.overnight/out/dl-session-1.log" });
  it("runs caffeinate inside a detached screen, so the Mac stays awake for as long as the job runs", () => {
    expect(argv.slice(0, 6)).toEqual(["screen", "-dmS", "dl-session-1", "caffeinate", "-is", "sh"]);
  });
  it("passes the prompt and every argument as sh positionals, never inside the script text", () => {
    const script = argv[7];
    expect(script).toBe('log="$1"; shift; "$@" < /dev/null 2>&1 | tee -a "$log"');
    expect(argv.slice(8)).toEqual([
      "sh", "/r/.overnight/out/dl-session-1.log",
      "sbx", "exec", "-w", "/r", "-e", "ANTHROPIC_DEFAULT_OPUS_MODEL", "-e", "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0", "dl-session-1",
      "claude", "-p", "--dangerously-skip-permissions", "--plugin-dir", "/p", "do it",
    ]);
  });
});

describe("isSafeSessionName", () => {
  it("accepts dl-session-* names sbx allows", () => {
    expect(isSafeSessionName("dl-session-20261120-224501")).toBe(true);
  });
  it("refuses anything else (it goes into a git remote and ref name)", () => {
    for (const n of ["dl-1-x", "dl-session-", "dl-session-A", "dl-session-a/b", "dl-session-a..b", `dl-session-${"a".repeat(60)}`]) expect(isSafeSessionName(n), n).toBe(false);
  });
});

describe("safeReportNames", () => {
  it("keeps plain .md names and drops anything that could carry terminal escapes", () => {
    expect(safeReportNames(["report.md", "a b.md", "x\u001b[2J.md", "notes.txt", "ok-1_2.md"])).toEqual(["report.md", "ok-1_2.md"]);
  });
});

describe("realEnvFilesUnder", () => {
  it("finds a real env file at any depth, skipping node_modules, .git and the loop's own fake", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "envscan-"));
    try {
      for (const f of ["a/b/.env.local", "node_modules/x/.env", ".git/.env", "c/.env.example", "w/.claude/worktrees/.envrc", "w/.ENVRC"]) {
        mkdirSync(join(d, f, ".."), { recursive: true });
        writeFileSync(join(d, f), f.endsWith("worktrees/.envrc") ? "# dev-loop fake env: generated\n" : "X=1\n");
      }
      expect(realEnvFilesUnder(d).sort()).toEqual(["a/b/.env.local", "w/.ENVRC"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
