// The real RunSkillFn over an injected spawn: the prompt it builds, where it
// spawns, what it creates, and where it reads the verdict (only
// RUN_DIR/verdict.json).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunSkill, sandboxInstanceName, sandboxInstancePrefix, sandboxMounts, sandboxPreflightInstanceName, type SkillRunnerDeps } from "../../src/worker/skill-runner.ts";
import { noneAdapter } from "../../src/sandbox/none.ts";
import type { SandboxSelection } from "../../src/sandbox/select.ts";
import type { SandboxDenial } from "../../src/sandbox/types.ts";
import type { SpawnClaudeOpts, SpawnClaudeResult } from "../../src/core/spawn-claude.ts";
import { resolveRepoPath, v2RunDir } from "../../src/core/paths.ts";
import { ALLOWED_TOOLS as DEV_TOOLS } from "../../src/roles/dev/tools.ts";
import { ALLOWED_TOOLS as RESEARCH_TOOLS } from "../../src/roles/research/tools.ts";
import { makeV2Config } from "../fixtures/config.ts";
import { allowedToolsFor } from "../../src/core/atlassian-tools.ts";
import { projectJson, type ResolvedProfile } from "../../src/core/project-profile.ts";
import { APP_PROFILE, DEFAULT_PROFILE } from "../fixtures/profile.ts";

const RID = "20261111T010203Z";
const SLUG = "skill-runner-test";

function okRun(): SpawnClaudeResult {
  return {
    stdout: JSON.stringify({ total_cost_usd: 1.5 }),
    usage: { costUsd: 1.5, tokens: { in: 10, out: 5 } },
    started: "2026-11-11T01:02:03.000Z",
    ended: "2026-11-11T01:12:03.000Z",
    killedTimeout: false,
  };
}

describe("makeRunSkill", () => {
  let repo: string;
  let spawned: SpawnClaudeOpts[];
  let onSpawn: (opts: SpawnClaudeOpts) => Promise<void>;
  let result: SpawnClaudeResult;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "skill-runner-repo-"));
    spawned = [];
    onSpawn = async () => {};
    result = okRun();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(resolveRepoPath(`.pipeline/v2/${SLUG}`), { recursive: true, force: true });
    // Leave no empty .pipeline/v2 or .pipeline behind (rmdir only removes an empty dir).
    for (const d of [resolveRepoPath(`.pipeline/v2/${SLUG}`).replace(`/${SLUG}`, ""), resolveRepoPath(`.pipeline/v2/${SLUG}`).replace(`/v2/${SLUG}`, "")]) {
      await rmdir(d).catch(() => {});
    }
  });

  function deps(extra: Partial<SkillRunnerDeps> = {}): SkillRunnerDeps {
    return {
      config: makeV2Config((c) => {
        c.targetRepo.path = repo;
      }),
      slug: SLUG,
      repoRoot: "/abs/dev-loop",
      stream: false,
      researchStance: "# research stance\nbe skeptical",
      skillVersion: { research: "sha-r", dev: "sha-d" },
      spawn: async (opts) => {
        spawned.push(opts);
        await onSpawn(opts);
        return result;
      },
      log: () => {},
      logError: () => {},
      // Never the real refresh: it would run direnv allow on temp files.
      refreshFakeEnv: async () => {},
      profile: DEFAULT_PROFILE,
      ...extra,
    };
  }

  const runDir = (role: "research" | "dev") => v2RunDir(SLUG, "dev-1", "TARS-1", role, RID);

  it("dev: prompt with absolute run-dir and repo-dir, cwd = repo root, no stance, add-dir = repo dir", async () => {
    await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    const [o] = spawned;
    expect(o.prompt).toBe(`/ticket-to-pr TARS-1 run-dir=${resolveRepoPath(runDir("dev"))} repo-dir=${repo}`);
    expect(o.cwd).toBe("/abs/dev-loop");
    expect(o.allowedTools).toBe(DEV_TOOLS);
    expect(o.addDir).toBe(repo);
    expect(o.excludeClaudeMd ?? []).toEqual([]);
    expect(o.appendSystemPrompt).toBeUndefined();
    expect(o.denyEditsUnder ?? []).toEqual([]);
    expect(o.logPrefix).toBe("ticket-to-pr");
    expect(o.maxBudgetUsd).toBe(20);
    expect(o.timeoutMin).toBe(75);
    expect(o.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(String(75 * 60_000));
    expect(o.rawUsagePath).toBe(join(resolveRepoPath(runDir("dev")), "usage.json"));
  });

  it("research: same cwd, excludes the root CLAUDE.md and appends the research stance", async () => {
    await makeRunSkill(deps())({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
    const [o] = spawned;
    expect(o.prompt).toBe(`/ticket-refine TARS-1 run-dir=${resolveRepoPath(runDir("research"))} repo-dir=${repo}`);
    expect(o.cwd).toBe("/abs/dev-loop");
    expect(o.allowedTools).toBe(RESEARCH_TOOLS);
    expect(o.excludeClaudeMd).toEqual(["/abs/dev-loop/CLAUDE.md"]);
    expect(o.appendSystemPrompt).toBe("# research stance\nbe skeptical");
    // Research may write only RUN_DIR (under the repo root), never the target checkout (Ruling 27).
    expect(o.denyEditsUnder).toEqual([repo]);
    expect(o.logPrefix).toBe("ticket-refine");
    expect(o.addDir).toBe(repo);
    expect(o.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(String(120 * 60_000));
  });

  it("no targetRepo.path: repo-dir is the absolute v2 clone dir and no --add-dir (it is inside the repo root)", async () => {
    const d = deps({ config: makeV2Config() });
    await makeRunSkill(d)({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(spawned[0].prompt).toMatch(new RegExp(`repo-dir=${resolveRepoPath(`.pipeline/v2/${SLUG}/repo`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    expect(spawned[0].addDir).toBeNull();
  });

  it("research with no targetRepo.path: denies edits under the v2 clone dir (RUN_DIR is outside it)", async () => {
    const d = deps({ config: makeV2Config() });
    await makeRunSkill(d)({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
    const clone = resolveRepoPath(`.pipeline/v2/${SLUG}/repo`);
    expect(spawned[0].denyEditsUnder).toEqual([clone]);
    expect(resolveRepoPath(runDir("research")).startsWith(clone + "/")).toBe(false);
  });

  it("both roles: denyReads lists the target repo's real root env files (never *.example), rescanned per run", async () => {
    const run = makeRunSkill(deps());
    await run({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(spawned[0].denyReads).toEqual([]);
    await writeFile(join(repo, ".envrc"), "export X=fake\n");
    await writeFile(join(repo, ".env"), "X=fake\n");
    await writeFile(join(repo, ".envrc.example"), "export X=placeholder\n");
    await run({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    await run({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
    expect(spawned[1].denyReads).toEqual([join(repo, ".env"), join(repo, ".envrc")]);
    expect(spawned[2].denyReads).toEqual([join(repo, ".env"), join(repo, ".envrc")]);
  });

  it("an app-folder profile denies the app folder's real env files too", async () => {
    await makeRunSkill(deps({ profile: APP_PROFILE }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(spawned[0].denyReads).toContain(join(repo, "app/.env.local"));
  });

  it("writes RUN_DIR/project.json from the profile before the spawn", async () => {
    let seen: unknown = null;
    onSpawn = async () => {
      seen = JSON.parse(await readFile(join(resolveRepoPath(runDir("dev")), "project.json"), "utf8"));
    };
    await makeRunSkill(deps({ profile: APP_PROFILE }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(seen).toEqual(projectJson(APP_PROFILE));
  });

  it("fetches the ticket's attachments into RUN_DIR before the spawn, for both roles", async () => {
    const seen: unknown[] = [];
    onSpawn = async (o) => {
      const dir = o.ticketKey && resolveRepoPath(spawned.length === 1 ? runDir("dev") : runDir("research"));
      seen.push(JSON.parse(await readFile(join(dir as string, "attachments.json"), "utf8")));
    };
    const attachments = {
      list: async () => [{ id: "9", filename: "resp.json", size: 4, mimeType: "text/plain" }],
      download: async () => Buffer.from("{}\n"),
    };
    const run = makeRunSkill(deps({ attachments }));
    await run({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    await run({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
    expect(seen).toHaveLength(2);
    for (const m of seen as Array<{ attachments: Array<{ status: string }> }>) expect(m.attachments.map((a) => a.status)).toEqual(["fetched"]);
    expect(await readFile(join(resolveRepoPath(runDir("dev")), "attachments", "resp.json"), "utf8")).toBe("{}\n");
  });

  it("logs a one-line attachment summary, and a failed listing never stops the run", async () => {
    const logs: string[] = [];
    const attachments = { list: async () => { throw new Error("Jira 503"); }, download: async () => Buffer.from("") };
    await makeRunSkill(deps({ attachments, log: (m) => void logs.push(m) }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(spawned).toHaveLength(1);
    expect(logs.some((l) => /TARS-1: attachments: could not list \(Jira 503\)/.test(l))).toBe(true);
  });

  it("refreshFakeEnv gets the profile, once per run", async () => {
    const got: ResolvedProfile[] = [];
    await makeRunSkill(deps({ profile: APP_PROFILE, refreshFakeEnv: async (p) => void got.push(p) }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(got).toEqual([APP_PROFILE]);
  });

  it("both roles' spawn env marks the robot (DEVLOOP_ROBOT_ENV=1), so the fake env loads for it", async () => {
    const run = makeRunSkill(deps());
    await run({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    await run({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
    expect(spawned.map((o) => o.env.DEVLOOP_ROBOT_ENV)).toEqual(["1", "1"]);
  });

  it("refreshes the fake env before every spawn; a refresh failure is logged, never fatal", async () => {
    const order: string[] = [];
    onSpawn = async () => void order.push("spawn");
    const errors: string[] = [];
    let n = 0;
    const run = makeRunSkill(deps({
      refreshFakeEnv: async () => {
        order.push("refresh");
        if (++n === 2) throw new Error("disk full");
      },
      logError: (m) => errors.push(m),
    }));
    await run({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    await run({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(order).toEqual(["refresh", "spawn", "refresh", "spawn"]);
    expect(errors.some((e) => e.includes("fake env") && e.includes("disk full"))).toBe(true);
  });

  it("validates REPO_DIR at construction: a malformed targetRepo.path throws before any run", () => {
    for (const bad of ["/abs/my repo", "relative/repo", "/abs/x;rm", "/abs/../x"]) {
      expect(() =>
        makeRunSkill(
          deps({
            config: makeV2Config((c) => {
              c.targetRepo.path = bad;
            }),
          }),
        ),
      ).toThrow(/repo-dir/);
    }
  });

  it("creates RUN_DIR before spawning", async () => {
    let existed = false;
    onSpawn = async (o) => {
      existed = (await stat(resolveRepoPath(runDir("dev")))).isDirectory();
      expect(o.prompt).toContain("run-dir=");
    };
    await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(existed).toBe(true);
  });

  it("reads RUN_DIR/verdict.json (redacted) and returns it with the measured usage", async () => {
    onSpawn = async () => {
      await writeFile(join(resolveRepoPath(runDir("dev")), "verdict.json"), '{"outcome":"landed","detail":"mail a@b.example"}', "utf8");
    };
    const r = await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(r.verdictRaw).toContain('"outcome":"landed"');
    expect(r.verdictRaw).not.toContain("a@b.example");
    expect(r).toMatchObject({ costUsd: 1.5, tokens: { in: 10, out: 5 }, skillVersion: "sha-d", model: "sonnet" });
  });

  it("never reads a verdict from anywhere else (no newest-run-dir discovery)", async () => {
    onSpawn = async () => {
      const other = resolveRepoPath(`.pipeline/v2/${SLUG}`);
      await mkdir(join(other, "elsewhere"), { recursive: true });
      await writeFile(join(other, "elsewhere", "verdict.json"), '{"outcome":"landed"}', "utf8");
    };
    const r = await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(r.verdictRaw).toBeUndefined();
  });

  it("a timeout kill returns the killed verdict without reading verdict.json", async () => {
    result = { ...okRun(), killedTimeout: true };
    onSpawn = async () => {
      await writeFile(join(resolveRepoPath(runDir("dev")), "verdict.json"), '{"outcome":"landed"}', "utf8");
    };
    const r = await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(JSON.parse(r.verdictRaw!).outcome).toBe("killed");
    expect(r.costUsd).toBe(1.5);
  });

  it("calls beforeRun for research only (the mirror Issue), before spawning", async () => {
    const order: string[] = [];
    const d = deps({ beforeRun: async (role, key) => void order.push(`before:${role}:${key}`) });
    onSpawn = async (o) => void order.push(`spawn:${o.prompt.split(" ")[0]}`);
    await makeRunSkill(d)({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
    await makeRunSkill(d)({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(order).toEqual(["before:research:TARS-1", "spawn:/ticket-refine", "spawn:/ticket-to-pr"]);
  });

  it("rejects a runDir that is not this ticket's and role's (never spawns)", async () => {
    const run = makeRunSkill(deps());
    await expect(run({ role: "dev", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 20 })).rejects.toThrow();
    await expect(run({ role: "dev", ticketKey: "TARS-2", runDir: runDir("dev"), maxBudgetUsd: 20 })).rejects.toThrow();
    expect(spawned).toEqual([]);
  });

  it("raw usage lands in RUN_DIR/usage.json via the spawn's rawUsagePath (written by spawnClaudeRun)", async () => {
    onSpawn = async (o) => {
      await writeFile(o.rawUsagePath, "{}", "utf8");
    };
    await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(await readFile(join(resolveRepoPath(runDir("dev")), "usage.json"), "utf8")).toBe("{}");
  });

  describe("sandbox", () => {
    const fakeAdapter = { ...noneAdapter, name: "fake" };
    const sel = (mode: "enforce" | "discover"): SandboxSelection => ({ adapter: fakeAdapter, mode, config: { k: 1 } });
    const denied: SandboxDenial[] = [{ kind: "network", target: "evil.example" }];
    const withReport = (d: SandboxDenial[], extra: Partial<SpawnClaudeResult> = {}): SpawnClaudeResult => ({
      ...okRun(),
      ...extra,
      sandbox: { adapter: "fake", instance: "dl-x", prepare_ms: 5, report: { denied: d, approveHint: "approve evil.example" } },
    });
    const writeVerdict = async () => {
      await writeFile(join(resolveRepoPath(runDir("dev")), "verdict.json"), '{"outcome":"landed"}', "utf8");
    };

    it("an adapter that proxies Atlassian MCP gets the allowlist under its server name and naming", async () => {
      const proxy = { ...fakeAdapter, atlassianMcp: (c: unknown) => ((c as { k: number }).k === 1 ? { server: "gw", naming: "v2" as const } : undefined) };
      const s: SandboxSelection = { adapter: proxy, mode: "discover", config: { k: 1 } };
      await makeRunSkill(deps({ sandbox: s }))({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
      await makeRunSkill(deps({ sandbox: s }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(spawned[0].allowedTools).toBe(allowedToolsFor("research", { server: "gw", naming: "v2" }));
      expect(spawned[0].allowedTools).toContain("mcp__gw__addOrEditJiraIssueComment");
      expect(spawned[0].allowedTools).not.toContain("mcp__atlassian__");
      expect(spawned[1].allowedTools).toBe(allowedToolsFor("dev", { server: "gw", naming: "v2" }));
    });

    it("an adapter without atlassianMcp keeps the host allowlist", async () => {
      await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(spawned[0].allowedTools).toBe(DEV_TOOLS);
    });

    it("a sandbox with host skill paths passes them to dev only, after repo-dir", async () => {
      const withSkills = { ...fakeAdapter, hostSkillPaths: () => ({ "push-branch": "/home/agent/.dev-loop/skills/push-branch/SKILL.md" }) };
      const s: SandboxSelection = { adapter: withSkills, mode: "discover", config: { k: 1 } };
      await makeRunSkill(deps({ sandbox: s }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      await makeRunSkill(deps({ sandbox: s }))({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
      expect(spawned[0].prompt).toBe(
        `/ticket-to-pr TARS-1 run-dir=${resolveRepoPath(runDir("dev"))} repo-dir=${repo} push-branch=/home/agent/.dev-loop/skills/push-branch/SKILL.md`,
      );
      expect(spawned[1].prompt).toBe(`/ticket-refine TARS-1 run-dir=${resolveRepoPath(runDir("research"))} repo-dir=${repo}`);
    });

    it("an adapter with hostPush adds push=host to the dev prompt only", async () => {
      const hp = { ...fakeAdapter, hostPush: () => true };
      const s: SandboxSelection = { adapter: hp, mode: "discover", config: { k: 1 } };
      await makeRunSkill(deps({ sandbox: s }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      await makeRunSkill(deps({ sandbox: s }))({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
      expect(spawned[0].prompt).toBe(`/ticket-to-pr TARS-1 run-dir=${resolveRepoPath(runDir("dev"))} repo-dir=${repo} push=host`);
      expect(spawned[1].prompt).toBe(`/ticket-refine TARS-1 run-dir=${resolveRepoPath(runDir("research"))} repo-dir=${repo}`);
    });

    it("the plain host loop (no sandbox) builds today's dev prompt, with no host skill paths", async () => {
      await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(spawned[0].prompt).toBe(`/ticket-to-pr TARS-1 run-dir=${resolveRepoPath(runDir("dev"))} repo-dir=${repo}`);
    });

    it("without deps.sandbox, spawn opts have no sandbox key at all", async () => {
      await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(Object.hasOwn(spawned[0], "sandbox")).toBe(false);
    });

    it("a slug whose prefix leaves no room fails at construction with a sandbox, not without", () => {
      const slug = "p".repeat(60);
      expect(() => makeRunSkill({ ...deps({ sandbox: sel("enforce") }), slug })).toThrow(/is too long \(max 56 chars\)/);
      expect(() => makeRunSkill({ ...deps(), slug })).not.toThrow();
    });

    it("with a selection, spawn opts carry the adapter, instance name, mounts, repo dir and adapter config", async () => {
      await makeRunSkill(deps({ sandbox: sel("enforce"), shortId: () => "a1b2c3" }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(spawned[0].sandbox).toEqual({
        adapter: fakeAdapter,
        run: { instanceName: "dl-17-skill-runner-test-tars-1-dev-a1b2c3", mounts: ["/abs/dev-loop", repo], repoDir: repo, config: { k: 1 } },
      });
    });

    it("the default shortId is 6 lowercase hex chars", async () => {
      await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(spawned[0].sandbox!.run.instanceName).toMatch(/^dl-17-skill-runner-test-tars-1-dev-[0-9a-f]{6}$/);
    });

    it("the running line names the sandbox instance only when a sandbox is attached", async () => {
      const lines: string[] = [];
      await makeRunSkill(deps({ log: (m) => void lines.push(m) }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      await makeRunSkill(deps({ log: (m) => void lines.push(m), sandbox: sel("enforce"), shortId: () => "a1b2c3" }))({
        role: "dev",
        ticketKey: "TARS-1",
        runDir: runDir("dev"),
        maxBudgetUsd: 20,
      });
      const running = lines.filter((l) => l.includes(": running"));
      expect(running).toEqual([
        `[ticket-to-pr] TARS-1: running (run dir ${runDir("dev")}, budget $20)...`,
        `[ticket-to-pr] TARS-1: running in dl-17-skill-runner-test-tars-1-dev-a1b2c3 (run dir ${runDir("dev")}, budget $20)...`,
      ]);
    });

    it("enforce + denied report: parked, verdictRaw undefined, verdict.json not read", async () => {
      result = withReport(denied);
      onSpawn = writeVerdict;
      const lines: string[] = [];
      const r = await makeRunSkill(deps({ sandbox: sel("enforce"), log: (m) => void lines.push(m), logError: (m) => void lines.push(m) }))({
        role: "dev",
        ticketKey: "TARS-1",
        runDir: runDir("dev"),
        maxBudgetUsd: 20,
      });
      expect(r.verdictRaw).toBeUndefined();
      expect(r.parked).toEqual({ denied, approveHint: "approve evil.example" });
      expect(r).toMatchObject({ costUsd: 1.5, tokens: { in: 10, out: 5 }, started: okRun().started, ended: okRun().ended, skillVersion: "sha-d", model: "sonnet" });
      expect(lines).toContain("[ticket-to-pr] TARS-1: sandbox refused network evil.example; parking");
    });

    it("the sandbox refused log line is redacted (token-shaped target)", async () => {
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
      const secret: SandboxDenial[] = [{ kind: "credential", target: `token ${token}` }];
      for (const mode of ["enforce", "discover"] as const) {
        result = withReport(secret);
        onSpawn = writeVerdict;
        const lines: string[] = [];
        await makeRunSkill(deps({ sandbox: sel(mode), log: (m) => void lines.push(m), logError: (m) => void lines.push(m) }))({
          role: "dev",
          ticketKey: "TARS-1",
          runDir: runDir("dev"),
          maxBudgetUsd: 20,
        });
        const refused = lines.filter((l) => l.includes("sandbox refused"));
        expect(refused).toHaveLength(1);
        expect(refused[0]).not.toContain(token);
        expect(refused[0]).toContain("REDACTED");
      }
    });

    it("discover + denied report: reads verdict.json normally, no parked", async () => {
      result = withReport(denied);
      onSpawn = writeVerdict;
      const lines: string[] = [];
      const r = await makeRunSkill(deps({ sandbox: sel("discover"), log: (m) => void lines.push(m), logError: (m) => void lines.push(m) }))({
        role: "dev",
        ticketKey: "TARS-1",
        runDir: runDir("dev"),
        maxBudgetUsd: 20,
      });
      expect(r.verdictRaw).toContain('"outcome":"landed"');
      expect(r.parked).toBeUndefined();
      expect(lines).toContain("[ticket-to-pr] TARS-1: sandbox refused network evil.example; discover mode, not parking");
    });

    it("discover + denied report: the result's sandbox meta carries the denials and the hint", async () => {
      result = withReport(denied);
      onSpawn = writeVerdict;
      const r = await makeRunSkill(deps({ sandbox: sel("discover") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(r.sandbox).toEqual({ adapter: "fake", instance: "dl-x", prepare_ms: 5, denied, approveHint: "approve evil.example" });
    });

    it("enforce + denied, and discover + empty report: no denied/approveHint on the sandbox meta", async () => {
      result = withReport(denied);
      const parked = await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(parked.sandbox).toEqual({ adapter: "fake", instance: "dl-x", prepare_ms: 5 });
      result = withReport([]);
      onSpawn = writeVerdict;
      const clean = await makeRunSkill(deps({ sandbox: sel("discover") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(clean.sandbox).toEqual({ adapter: "fake", instance: "dl-x", prepare_ms: 5 });
    });

    it("discover + all-infra denials: parked with allInfra true (discover relaxes only network/credential)", async () => {
      const infra: SandboxDenial[] = [{ kind: "infra", target: "prepare" }];
      for (const role of ["dev", "research"] as const) {
        result = withReport(infra, { spawnError: "sandbox prepare failed: boom" });
        const r = await makeRunSkill(deps({ sandbox: sel("discover") }))({ role, ticketKey: "TARS-1", runDir: runDir(role), maxBudgetUsd: 20 });
        expect(r.verdictRaw).toBeUndefined();
        expect(r.parked).toEqual({ denied: infra, approveHint: "approve evil.example", allInfra: true });
        expect(r.sandbox).toEqual({ adapter: "fake", instance: "dl-x", prepare_ms: 5 });
      }
    });

    it("discover + mixed network and infra denials: not parked", async () => {
      result = withReport([...denied, { kind: "infra", target: "inspect" }]);
      onSpawn = writeVerdict;
      const r = await makeRunSkill(deps({ sandbox: sel("discover") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(r.parked).toBeUndefined();
      expect(r.verdictRaw).toContain('"outcome":"landed"');
    });

    it("enforce + prepare failure (spawnError + infra denial): parked, not the agent_error early result", async () => {
      const infra: SandboxDenial[] = [{ kind: "infra", target: "prepare" }];
      for (const role of ["dev", "research"] as const) {
        result = withReport(infra, { spawnError: "sandbox prepare failed: boom" });
        const r = await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role, ticketKey: "TARS-1", runDir: runDir(role), maxBudgetUsd: 20 });
        expect(r.verdictRaw).toBeUndefined();
        expect(r.parked?.denied).toEqual(infra);
      }
    });

    it("enforce + all-infra denials: parked with allInfra true", async () => {
      const infra: SandboxDenial[] = [{ kind: "infra", target: "prepare" }];
      result = withReport(infra, { spawnError: "sandbox prepare failed: boom" });
      const r = await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(r.parked).toEqual({ denied: infra, approveHint: "approve evil.example", allInfra: true });
    });

    it("enforce + mixed network and infra denials: parked without allInfra", async () => {
      const mixed: SandboxDenial[] = [...denied, { kind: "infra", target: "inspect" }];
      result = withReport(mixed);
      const r = await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(r.parked?.denied).toEqual(mixed);
      expect(r.parked && "allInfra" in r.parked).toBe(false);
    });

    it("carries sandbox {adapter, instance, prepare_ms} (no report) on parked, normal and early results", async () => {
      const meta = { adapter: "fake", instance: "dl-x", prepare_ms: 5 };
      result = withReport(denied);
      const parked = await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(parked.sandbox).toEqual(meta);

      result = withReport([]);
      onSpawn = writeVerdict;
      const normal = await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(normal.sandbox).toEqual(meta);

      onSpawn = async () => {};
      for (const role of ["dev", "research"] as const) {
        result = withReport([], { spawnError: "claude exited 1" });
        const early = await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role, ticketKey: "TARS-1", runDir: runDir(role), maxBudgetUsd: 20 });
        // The early (spawnError) result: dev serializes an agent_error verdict, research leaves it undefined.
        if (role === "dev") expect(early.verdictRaw).toContain("agent_error");
        else expect(early.verdictRaw).toBeUndefined();
        expect(early.sandbox).toEqual(meta);
      }
    });

    it("no sandbox key on the result when the spawn was not sandboxed", async () => {
      onSpawn = writeVerdict;
      const r = await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect("sandbox" in r).toBe(false);
    });

    it("enforce + empty denied report: normal path, no parked", async () => {
      result = withReport([]);
      onSpawn = writeVerdict;
      const r = await makeRunSkill(deps({ sandbox: sel("enforce") }))({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
      expect(r.verdictRaw).toContain('"outcome":"landed"');
      expect(r.parked).toBeUndefined();
    });
  });
});

describe("sandboxInstanceName", () => {
  it("is dl-<len>-<project>-<ticket lowercased>-<role>-<shortId>", () => {
    expect(sandboxInstanceName("webtarsthree", "TARS-12", "dev", "a1b2c3")).toBe("dl-12-webtarsthree-tars-12-dev-a1b2c3");
    expect(sandboxInstanceName("webtarsthree", "TARS-12", "research", "00ff00")).toBe("dl-12-webtarsthree-tars-12-research-00ff00");
  });
  it("turns any char outside [a-z0-9-] into -", () => {
    expect(sandboxInstanceName("my_proj.x", "AB_C-1", "dev", "a1b2c3")).toBe("dl-9-my-proj-x-ab-c-1-dev-a1b2c3");
  });
  it("caps at 63 chars by trimming the ticket-role middle, keeping prefix and shortId", () => {
    const project = "p".repeat(40);
    const name = sandboxInstanceName(project, "ABCDEFGHIJ-123456", "research", "a1b2c3");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith(sandboxInstancePrefix(project))).toBe(true);
    expect(name.endsWith("-a1b2c3")).toBe(true);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
  it("throws when the prefix leaves no room for the shortId", () => {
    expect(() => sandboxInstanceName("p".repeat(60), "TARS-1", "dev", "a1b2c3")).toThrow(/sandbox instance prefix ".*" is too long \(max 56 chars\); shorten the project name/);
  });
  it("starts with sandboxInstancePrefix(project), so cleanup scope and names cannot drift", () => {
    for (const project of ["webtarsthree", "my_proj.x"]) {
      expect(sandboxInstanceName(project, "TARS-1", "dev", "a1b2c3").startsWith(sandboxInstancePrefix(project))).toBe(true);
    }
  });
});

describe("sandboxPreflightInstanceName", () => {
  it("is sandboxInstancePrefix(project) + preflight- + shortId", () => {
    expect(sandboxPreflightInstanceName("webtarsthree", "abc123")).toBe("dl-12-webtarsthree-preflight-abc123");
  });
  it("caps at 63 chars by trimming the preflight word, keeping prefix and shortId", () => {
    const project = "p".repeat(45);
    const name = sandboxPreflightInstanceName(project, "abc123");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith(sandboxInstancePrefix(project))).toBe(true);
    expect(name.endsWith("-abc123")).toBe(true);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
  it("throws when the prefix leaves no room for the shortId", () => {
    expect(() => sandboxPreflightInstanceName("p".repeat(60), "abc123")).toThrow(/sandbox instance prefix ".*" is too long \(max 56 chars\); shorten the project name/);
  });
});

describe("sandboxInstancePrefix", () => {
  it("is dl-<len>-<project>-, sanitized", () => {
    expect(sandboxInstancePrefix("webtarsthree")).toBe("dl-12-webtarsthree-");
    expect(sandboxInstancePrefix("My_Proj")).toBe("dl-7-my-proj-");
  });
  it("no project's prefix starts another project's prefix or instance names", () => {
    const projects = ["a", "a-b", "a-b-c", "ab", "webtarsthree", "webtarsthree-eval", "catalog-ui", "catalog-ui-public", "catalog-ui-management"];
    for (const p of projects) {
      for (const q of projects) {
        if (p === q) continue;
        expect(sandboxInstancePrefix(q).startsWith(sandboxInstancePrefix(p))).toBe(false);
        expect(sandboxInstanceName(q, "TARS-1", "dev", "a1b2c3").startsWith(sandboxInstancePrefix(p))).toBe(false);
      }
    }
  });
});

describe("sandboxMounts", () => {
  it("an outside checkout gives both paths", () => {
    expect(sandboxMounts("/abs/dev-loop", "/abs/checkout")).toEqual(["/abs/dev-loop", "/abs/checkout"]);
  });
  it("an inside clone gives only the root", () => {
    expect(sandboxMounts("/abs/dev-loop", "/abs/dev-loop/.pipeline/v2/x/repo")).toEqual(["/abs/dev-loop"]);
  });
  it("the same path twice gives one", () => {
    expect(sandboxMounts("/abs/dev-loop", "/abs/dev-loop")).toEqual(["/abs/dev-loop"]);
  });
  it("a sibling sharing a name prefix is not inside", () => {
    expect(sandboxMounts("/abs/dev-loop", "/abs/dev-loop-other")).toEqual(["/abs/dev-loop", "/abs/dev-loop-other"]);
  });
});
