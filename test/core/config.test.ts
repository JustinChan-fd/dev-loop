import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  loadLoopConfig,
  validateConfig,
  requiredPlaceholderFree,
  roleView,
  labelMajor,
  checkLabelVersion,
  ConfigError,
  repoSlugFromUrl,
  targetRepoAddDir,
  listAvailableProjects,
  resolveProjectConfigPath,
  localProfile,
} from "../../src/core/config.ts";
import type { Config, Role } from "../../src/core/types.ts";
import { makeV2Config } from "../fixtures/config.ts";
import * as fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const PROJECTS = ["webtarsthree", "catalog-ui-management", "catalog-ui-public"] as const;

describe("repoSlugFromUrl", () => {
  it("derives a slug from an SSH URL with a .git suffix", () => {
    expect(repoSlugFromUrl("git@github.com:fandango/webtarsthree.git")).toBe("webtarsthree");
  });

  it("derives a slug from an HTTPS URL with a .git suffix", () => {
    expect(repoSlugFromUrl("https://github.com/fandango/webtarsthree.git")).toBe("webtarsthree");
  });

  it("derives a slug from an HTTPS URL without a .git suffix", () => {
    expect(repoSlugFromUrl("https://github.com/org/catalog-ui-management")).toBe(
      "catalog-ui-management",
    );
  });

  it("derives a slug from an SSH URL without a .git suffix", () => {
    expect(repoSlugFromUrl("git@github.com:org/catalog-ui-management")).toBe(
      "catalog-ui-management",
    );
  });
});

describe("targetRepoAddDir", () => {
  it("returns targetRepo.path when set, so the spawned claude session can be granted directory access to it", () => {
    const config = makeV2Config((c) => {
      c.targetRepo.path = "/Users/me/Repos/webtarsthree";
    });
    expect(targetRepoAddDir(config)).toBe("/Users/me/Repos/webtarsthree");
  });

  it("returns null when targetRepo.path is unset (clone-based flow stays inside dev-loop's own cwd)", () => {
    const config = makeV2Config();
    expect(targetRepoAddDir(config)).toBeNull();
  });
});

describe("listAvailableProjects", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "list-projects-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists project names derived from pipeline.<name>.config.json files, sorted", async () => {
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    await fs.writeFile(path.join(dir, "pipeline.catalog-ui-management.config.json"), "{}", "utf8");
    expect(await listAvailableProjects(dir)).toEqual(["catalog-ui-management", "webtarsthree"]);
  });

  it("excludes pipeline.loop.config.json -- it is not a project", async () => {
    await fs.writeFile(path.join(dir, "pipeline.loop.config.json"), "{}", "utf8");
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    expect(await listAvailableProjects(dir)).toEqual(["webtarsthree"]);
  });

  it("returns an empty array when no pipeline configs exist", async () => {
    expect(await listAvailableProjects(dir)).toEqual([]);
  });

  it("returns an empty array when dir does not exist", async () => {
    expect(await listAvailableProjects(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});

describe("resolveProjectConfigPath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-project-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves a valid project name to its config path", async () => {
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    expect(await resolveProjectConfigPath("webtarsthree", dir)).toBe(
      path.join(dir, "pipeline.webtarsthree.config.json"),
    );
  });

  it("throws listing available projects when projectName is omitted", async () => {
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    await expect(resolveProjectConfigPath(undefined, dir)).rejects.toThrow(/webtarsthree/);
  });

  it("throws listing available projects when the named project's config file doesn't exist", async () => {
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    await expect(resolveProjectConfigPath("nonexistent", dir)).rejects.toThrow(/webtarsthree/);
  });

  it("never resolves 'loop' as if it were a project name", async () => {
    await fs.writeFile(path.join(dir, "pipeline.loop.config.json"), "{}", "utf8");
    await expect(resolveProjectConfigPath("loop", dir)).rejects.toThrow(/Unknown project "loop"/);
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads, parses and validates a v2 config file at the given path", async () => {
    const filePath = path.join(dir, "pipeline.webtarsthree.config.json");
    await fs.writeFile(filePath, JSON.stringify(makeV2Config()), "utf8");
    const config = await loadConfig(filePath);
    expect(config.roles.dev.triggerLabel).toBe("pipeline:v2:dev");
  });

  it("throws a ConfigError naming the file when the content fails validation", async () => {
    const filePath = path.join(dir, "pipeline.x.config.json");
    await fs.writeFile(filePath, JSON.stringify({ ...makeV2Config(), roles: undefined }), "utf8");
    await expect(loadConfig(filePath)).rejects.toThrow(ConfigError);
    await expect(loadConfig(filePath)).rejects.toThrow(/pipeline\.x\.config\.json/);
  });

  it("throws a ConfigError on invalid JSON", async () => {
    const filePath = path.join(dir, "pipeline.x.config.json");
    await fs.writeFile(filePath, "{ not json", "utf8");
    await expect(loadConfig(filePath)).rejects.toThrow(ConfigError);
  });

  it("throws if the file does not exist", async () => {
    await expect(loadConfig(path.join(dir, "does-not-exist.json"))).rejects.toThrow();
  });

  it("requires an explicit path -- there is no implicit default config file", async () => {
    // @ts-expect-error -- path is a required argument, not optional
    await expect(loadConfig()).rejects.toThrow();
  });
});

describe("validateConfig", () => {
  const valid = makeV2Config();

  it("returns a valid config unchanged", () => {
    expect(validateConfig(structuredClone(valid))).toEqual(valid);
  });

  it("accepts jira.blockerClearedStatuses as a list of status names", () => {
    const c = validateConfig({ ...structuredClone(valid), jira: { ...structuredClone(valid.jira), blockerClearedStatuses: ["Deployed to INT"] } });
    expect(c.jira.blockerClearedStatuses).toEqual(["Deployed to INT"]);
  });

  it.each([
    ["a string", "Deployed to INT"],
    ["an empty name", [""]],
    ["a non-string", [3]],
    ["a name with a quote", ['Deployed "INT"']],
  ])("rejects jira.blockerClearedStatuses that is %s", (_what, v) => {
    expect(() => validateConfig({ ...structuredClone(valid), jira: { ...structuredClone(valid.jira), blockerClearedStatuses: v } })).toThrow(
      /jira\.blockerClearedStatuses/,
    );
  });

  it.each(PROJECTS)("%s: blockers in Development Complete or later clear the gate", async (project) => {
    const c = await loadConfig(path.join(REPO_ROOT, `pipeline.${project}.config.json`));
    expect(c.jira.blockerClearedStatuses).toEqual(["Development Complete", "Deployed to INT", "Deployed to STG", "Ready for Release", "Deployed to PROD"]);
  });

  it("rejects autoPromoteLabel", () => {
    expect(() => validateConfig({ ...valid, autoPromoteLabel: "auto-promote" })).toThrow(
      /autoPromoteLabel was removed in 2.0.0/,
    );
  });

  it("rejects unknown top-level keys and missing roles", () => {
    expect(() => validateConfig({ ...valid, surprise: 1 })).toThrow(/unknown key "surprise"/);
    const { roles: _roles, ...noRoles } = valid;
    expect(() => validateConfig(noRoles)).toThrow(/roles/);
    expect(() => validateConfig({ ...valid, roles: { research: valid.roles.research } })).toThrow(
      /roles\.dev/,
    );
  });

  it("rejects a v1-shaped config (jira.triggerLabel / jira.pollJql / jira.codeReviewFields)", () => {
    const v1 = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "docs/changelog/legacy-config/dev-loop/pipeline.webtarsthree.config.json"), "utf8"),
    );
    expect(() => validateConfig(v1)).toThrow(ConfigError);
    expect(() =>
      validateConfig({ ...valid, jira: { ...valid.jira, triggerLabel: "pipeline:dev" } }),
    ).toThrow(/jira: unknown key "triggerLabel"/);
  });

  it("rejects unknown keys inside roles and ceilings", () => {
    expect(() =>
      validateConfig(makeV2Config((c) => Object.assign(c.roles.research, { codeReviewFields: {} }))),
    ).toThrow(/roles\.research: unknown key "codeReviewFields"/);
    expect(() =>
      validateConfig(makeV2Config((c) => Object.assign(c.ceilings, { maxCostPerRunUsd: 5 }))),
    ).toThrow(/ceilings: unknown key "maxCostPerRunUsd"/);
  });

  it("requires ceilings.maxAttemptsPerTicket and ceilings.maxCostPerTicketUsd", () => {
    for (const key of ["maxRunsPerDay", "maxAttemptsPerTicket", "maxCostPerTicketUsd"] as const) {
      const c = makeV2Config() as unknown as { ceilings: Record<string, unknown> };
      delete c.ceilings[key];
      expect(() => validateConfig(c)).toThrow(new RegExp(`ceilings\\.${key}`));
    }
  });

  it("rejects a non-positive or non-numeric ceilings.maxCostPerTicketUsd", () => {
    for (const bad of [0, -1, "50", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const c = makeV2Config((x) => {
        (x.ceilings as { maxCostPerTicketUsd: unknown }).maxCostPerTicketUsd = bad;
      });
      expect(() => validateConfig(c)).toThrow(/ceilings\.maxCostPerTicketUsd must be a number > 0/);
    }
    expect(validateConfig(makeV2Config((x) => (x.ceilings.maxCostPerTicketUsd = 0.5))).ceilings.maxCostPerTicketUsd).toBe(0.5);
  });

  it("rejects a non-positive per-role ceiling and a non-integer count ceiling", () => {
    expect(() => validateConfig(makeV2Config((c) => (c.roles.dev.ceilings.runTimeoutMin = 0)))).toThrow(
      /roles\.dev\.ceilings\.runTimeoutMin/,
    );
    expect(() => validateConfig(makeV2Config((c) => (c.ceilings.maxAttemptsPerTicket = 1.5)))).toThrow(
      /ceilings\.maxAttemptsPerTicket/,
    );
  });

  it.each([
    ['"', 'pipeline:v2" OR project = X'],
    ["\\", "pipeline:v2\\"],
    ["newline", "pipeline:v2\nOR"],
  ])("rejects a label or status value containing %s (they are interpolated into JQL)", (_name, bad) => {
    const setters: Array<[string, (c: Config) => void]> = [
      ["roles.research.triggerLabel", (c) => (c.roles.research.triggerLabel = bad)],
      ["roles.research.handoffLabel", (c) => {
        c.roles.research.handoffLabel = bad;
        c.roles.dev.triggerLabel = bad;
      }],
      ["jira.repoLabel", (c) => (c.jira.repoLabel = bad)],
      ["jira.statusNames.bounced", (c) => (c.jira.statusNames.bounced = bad)],
      ["jira.statusNames.prOpen", (c) => (c.jira.statusNames.prOpen = bad)],
      ["jira.claimStatus.from", (c) => (c.jira.claimStatus.from = bad)],
      ["jira.claimStatus.to", (c) => (c.jira.claimStatus.to = bad)],
    ];
    for (const [field, set] of setters) {
      expect(() => validateConfig(makeV2Config(set))).toThrow(new RegExp(field.replace(/\./g, "\\.")));
    }
  });

  it("requires research's handoffLabel to be dev's triggerLabel, and the two triggers to differ", () => {
    expect(() => validateConfig(makeV2Config((c) => (c.roles.dev.triggerLabel = "pipeline:other")))).toThrow(
      /roles\.research\.handoffLabel .* must equal roles\.dev\.triggerLabel/,
    );
    expect(() =>
      validateConfig(
        makeV2Config((c) => {
          c.roles.research.handoffLabel = c.roles.research.triggerLabel;
          c.roles.dev.triggerLabel = c.roles.research.triggerLabel;
        }),
      ),
    ).toThrow(/must differ/);
  });

  it("accepts \"___\" placeholders (requiredPlaceholderFree refuses them per phase)", () => {
    expect(() =>
      validateConfig(makeV2Config((c) => (c.roles.dev.codeReviewFields.piiField = "___"))),
    ).not.toThrow();
  });
});

describe("the three project config files", () => {
  it.each(PROJECTS)("%s loads and its slug equals the --project name", async (project) => {
    const config = await loadConfig(path.join(REPO_ROOT, `pipeline.${project}.config.json`));
    expect(repoSlugFromUrl(config.targetRepo.url)).toBe(project);
  });

  it("webtarsthree uses the v2 labels and excludes eval tickets from both polls", async () => {
    const c = await loadConfig(path.join(REPO_ROOT, "pipeline.webtarsthree.config.json"));
    expect(c.roles.research.triggerLabel).toBe("pipeline:v2");
    expect(c.roles.research.handoffLabel).toBe("pipeline:v2:dev");
    expect(c.roles.dev.triggerLabel).toBe("pipeline:v2:dev");
    expect(c.roles.research.pollJql).toContain('AND labels != "dev-loop-eval"');
    expect(c.roles.dev.pollJql).toContain('AND labels != "dev-loop-eval"');
    expect(c.roles.dev.pollJql).not.toContain("assignee");
    expect(c.ceilings).toEqual({ maxRunsPerDay: 100, maxAttemptsPerTicket: 2, maxCostPerTicketUsd: 50 });
  });

  it.each([...PROJECTS, "eval"])("%s: the dev poll skips finished tickets (statusCategory != Done)", async (project) => {
    // TARS-1640 (2026-11-17): closed while still labelled pipeline:v2:dev, and dev ran it again.
    const c = await loadConfig(path.join(REPO_ROOT, `pipeline.${project}.config.json`));
    expect(c.roles.dev.pollJql).toContain("AND statusCategory != Done");
  });

  it("catalog-ui-management config: v2 labels, sbx block, local profile, no assignee clause", async () => {
    const { preflight } = await import("../../src/core/cli-args.ts");
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    const c = await loadConfig(path.join(REPO_ROOT, "pipeline.catalog-ui-management.config.json"));
    expect(() => preflight(c, "worker", pkg.version)).not.toThrow();
    expect(c.roles.research.triggerLabel).toBe("pipeline:v2");
    expect(c.roles.research.handoffLabel).toBe("pipeline:v2:dev");
    expect(c.roles.dev.triggerLabel).toBe("pipeline:v2:dev");
    expect(c.roles.dev.pollJql).not.toMatch(/assignee/);
    expect(c.roles.research.pollJql).toContain('AND labels != "dev-loop-eval"');
    expect(c.roles.dev.pollJql).toContain('AND labels != "dev-loop-eval"');
    expect(c.sandbox?.sbx).toMatchObject({ template: "docker.io/library/dev-loop-sbx:v2-node26" });
    expect(c.sandbox?.mode).toBe("discover");
    expect(localProfile(c)).toEqual({
      appDir: "app",
      versionFile: "app/.nvmrc",
      envTemplate: { path: "app/.env.example", format: "dotenv" },
      realEnvFiles: ["app/.env.local"],
      robotEnv: {},
      devCommand: "npm run dev",
      devUrl: "http://localhost:3000",
    });
  });

  it("catalog-ui-public keeps its v1 labels until cutover", async () => {
    for (const project of ["catalog-ui-public"]) {
      const c = await loadConfig(path.join(REPO_ROOT, `pipeline.${project}.config.json`));
      expect(c.roles.research.triggerLabel).toBe("pipeline:research");
      expect(c.roles.research.handoffLabel).toBe("pipeline:dev");
      expect(c.roles.dev.triggerLabel).toBe("pipeline:dev");
    }
  });
});

/**
 * Per-role equivalence: for each project and role, roleView(newConfig, role)
 * equals the fields that role read from its own legacy (v1) file.
 *   - research read research-loop's copy: jira.triggerLabel, handoffLabel,
 *     pollJql.refine, ...; dev read dev-loop's copy: jira.handoffLabel as its
 *     poll {label} (buildDevJql), pollJql.dev, codeReviewFields, ...
 *   - Intended differences, and only these:
 *       webtarsthree and catalog-ui-management: triggerLabel/handoffLabel (v2 labels); dev pollJql
 *         (assignee clause dropped); both pollJqls gain the dev-loop-eval
 *         exclusion (asserted exactly below).
 *       a legacy dev value that was "___" takes research's real value
 *         (catalog-ui-public claim/status names, spec section 6.4).
 */
describe("per-role equivalence with the legacy config files", () => {
  type Legacy = {
    jira: {
      triggerLabel: string;
      handoffLabel: string;
      repoLabel: string;
      claimStatus: { from: string; to: string };
      pollJql: { refine: string; dev: string };
      statusNames: { bounced: string; prOpen: string };
      codeReviewFields?: Record<string, string>;
    };
    ceilings: { maxRunsPerDay: number; maxCostPerRunUsd: number; runTimeoutMin: number };
  };
  const legacy = (repo: "dev-loop" | "research-loop", project: string): Legacy =>
    JSON.parse(
      readFileSync(path.join(REPO_ROOT, "docs/changelog/legacy-config", repo, `pipeline.${project}.config.json`), "utf8"),
    );
  const fillFrom = <T extends Record<string, string>>(devValue: T, researchValue: T): T =>
    Object.fromEntries(
      Object.entries(devValue).map(([k, v]) => [k, v === "___" ? researchValue[k] : v]),
    ) as T;
  const EVAL = ' AND labels != "dev-loop-eval"';
  // Added after the merge (TARS-1640): dev never picks up a finished ticket.
  const NOT_DONE = " AND statusCategory != Done";
  const withNotDone = (jql: string) => jql.replace(' AND status != "{prOpenStatus}"', ` AND status != "{prOpenStatus}"${NOT_DONE}`);
  const beforeOrderBy = (jql: string, clause: string) => jql.replace(/ ORDER BY /, `${clause} ORDER BY `);

  function expectedView(project: string, role: Role): Record<string, unknown> {
    const r = legacy("research-loop", project);
    const d = legacy("dev-loop", project);
    if (role === "research") {
      return {
        triggerLabel: r.jira.triggerLabel,
        handoffLabel: r.jira.handoffLabel,
        pollJql: r.jira.pollJql.refine,
        repoLabel: r.jira.repoLabel,
        claimStatus: r.jira.claimStatus,
        statusNames: r.jira.statusNames,
        limits: r.ceilings,
      };
    }
    return {
      triggerLabel: d.jira.handoffLabel,
      pollJql: withNotDone(d.jira.pollJql.dev),
      repoLabel: d.jira.repoLabel,
      claimStatus: fillFrom(d.jira.claimStatus, r.jira.claimStatus),
      statusNames: fillFrom(d.jira.statusNames, r.jira.statusNames),
      codeReviewFields: d.jira.codeReviewFields,
      limits: d.ceilings,
    };
  }

  const cases = PROJECTS.flatMap((p) => (["research", "dev"] as const).map((role) => [p, role] as const));

  it.each(cases)("%s / %s", async (project, role) => {
    const config = await loadConfig(path.join(REPO_ROOT, `pipeline.${project}.config.json`));
    const actual = { ...roleView(config, role) } as Record<string, unknown>;
    const expected = expectedView(project, role);
    // catalog-ui-management moved to v2 the same way (project profiles, 2026-11-20).
    if (project === "webtarsthree" || project === "catalog-ui-management") {
      for (const k of ["triggerLabel", "handoffLabel"]) {
        delete actual[k];
        delete expected[k];
      }
      const legacyDevJql = legacy("dev-loop", project).jira.pollJql.dev;
      expected.pollJql =
        role === "research"
          ? beforeOrderBy(expected.pollJql as string, EVAL)
          : beforeOrderBy(withNotDone(legacyDevJql.replace(' AND assignee = "{assignee}"', "")), EVAL);
    }
    expect(actual).toEqual(expected);
  });

  it("the legacy files carry the ceilings the plan states (research 50/120, dev 20/75, 100 runs/day)", () => {
    for (const p of PROJECTS) {
      expect(legacy("research-loop", p).ceilings).toEqual({ maxRunsPerDay: 100, maxCostPerRunUsd: 50, runTimeoutMin: 120 });
      expect(legacy("dev-loop", p).ceilings).toEqual({ maxRunsPerDay: 100, maxCostPerRunUsd: 20, runTimeoutMin: 75 });
    }
  });
});

describe("roleView", () => {
  it("research: its own labels/JQL/ceilings plus the shared jira values and maxRunsPerDay; no codeReviewFields", () => {
    const view = roleView(makeV2Config(), "research");
    expect(view).toEqual({
      triggerLabel: "pipeline:v2",
      handoffLabel: "pipeline:v2:dev",
      pollJql: makeV2Config().roles.research.pollJql,
      repoLabel: "repo:org-repo",
      claimStatus: { from: "To Do", to: "In Progress" },
      statusNames: { bounced: "Blocked", prOpen: "Code Review" },
      limits: { maxRunsPerDay: 100, maxCostPerRunUsd: 50, runTimeoutMin: 120 },
    });
  });

  it("dev: its own label/JQL/codeReviewFields/ceilings; no handoffLabel", () => {
    const view = roleView(makeV2Config(), "dev");
    expect(view).not.toHaveProperty("handoffLabel");
    expect(view.codeReviewFields.piiField).toBe("customfield_13504");
    expect(view.limits).toEqual({ maxRunsPerDay: 100, maxCostPerRunUsd: 20, runTimeoutMin: 75 });
  });
});

describe("requiredPlaceholderFree", () => {
  it("placeholder refusal by phase (catalog-ui-public)", async () => {
    const c = await loadConfig(path.join(REPO_ROOT, "pipeline.catalog-ui-public.config.json"));
    expect(() => requiredPlaceholderFree(c, "research")).not.toThrow();
    expect(() => requiredPlaceholderFree(c, "dev")).toThrow(/roles\.dev\.codeReviewFields\.piiField/);
    expect(() => requiredPlaceholderFree(c, "worker")).toThrow(/roles\.dev\.codeReviewFields\.piiField/);
  });

  it("names every placeholder path the phase needs, and none it doesn't", () => {
    const c = makeV2Config((x) => {
      x.roles.research.triggerLabel = "___";
      x.roles.dev.codeReviewFields.qaNotesField = "___";
      x.github.repo = "___";
    });
    expect(() => requiredPlaceholderFree(c, "research")).toThrow(
      /roles\.research\.triggerLabel.*github\.repo|github\.repo.*roles\.research\.triggerLabel/,
    );
    let message = "";
    try {
      requiredPlaceholderFree(c, "research");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("codeReviewFields");
    expect(() => requiredPlaceholderFree(c, "dev")).toThrow(/roles\.dev\.codeReviewFields\.qaNotesField/);
  });

  it("treats a pollJql that still contains ___ as a placeholder", () => {
    const c = makeV2Config((x) => (x.roles.research.pollJql = 'labels = "{label}" AND status = "___"'));
    expect(() => requiredPlaceholderFree(c, "research")).toThrow(/roles\.research\.pollJql/);
    expect(() => requiredPlaceholderFree(c, "dev")).not.toThrow();
  });

  it("a fully bound config passes every phase", () => {
    for (const phase of ["research", "dev", "worker"] as const) {
      expect(() => requiredPlaceholderFree(makeV2Config(), phase)).not.toThrow();
    }
  });

  it("an unknown phase from an untyped caller gets the strictest (worker) check", () => {
    const c = makeV2Config((x) => (x.roles.dev.codeReviewFields.piiField = "___"));
    const untyped = requiredPlaceholderFree as (c: Config, p?: string) => void;
    expect(() => untyped(c)).toThrow(/piiField/);
  });
});

describe("labelMajor", () => {
  it("extracts the major version from a pipeline label", () => {
    expect(labelMajor("pipeline:v2")).toBe("2");
    expect(labelMajor("pipeline:v2:dev")).toBe("2");
    expect(labelMajor("pipeline:v12")).toBe("12");
  });

  it("returns null for an unversioned or full-version label", () => {
    expect(labelMajor("pipeline:research")).toBeNull();
    expect(labelMajor("pipeline:dev")).toBeNull();
    expect(labelMajor("pipeline:v2.0.0")).toBeNull();
    expect(labelMajor("pipeline:v2.0.0:dev")).toBeNull();
    expect(labelMajor("pipeline:v2x")).toBeNull();
    expect(labelMajor("xpipeline:v2")).toBeNull();
  });
});

describe("checkLabelVersion", () => {
  /** A config whose research trigger is `label` and whose dev stage is `<label>:dev`. */
  function withLabel(label: string): Config {
    return makeV2Config((c) => {
      c.roles.research.triggerLabel = label;
      c.roles.research.handoffLabel = `${label}:dev`;
      c.roles.dev.triggerLabel = `${label}:dev`;
    });
  }

  it("same major: ok, no warning, whatever the minor/patch", () => {
    expect(checkLabelVersion(withLabel("pipeline:v2"), "2.0.0")).toEqual({ ok: true });
    expect(checkLabelVersion(withLabel("pipeline:v2"), "2.1.0")).toEqual({ ok: true });
    expect(checkLabelVersion(withLabel("pipeline:v2"), "2.7.3")).toEqual({ ok: true });
  });

  it("unversioned trigger label: not ok", () => {
    const result = checkLabelVersion(withLabel("pipeline:research"), "2.0.0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worker mode needs a versioned trigger label (pipeline:v<major>)");
  });

  it("old full-version label: not ok, and names the new label", () => {
    const result = checkLabelVersion(withLabel("pipeline:v2.0.0"), "2.1.0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"pipeline:v2"');
  });

  it("major mismatch: not ok", () => {
    const result = checkLabelVersion(withLabel("pipeline:v1"), "2.0.0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("pipeline:v1");
      expect(result.error).toContain("2.0.0");
    }
  });

  it("catalog-ui-public is refused (v1 labels until cutover); webtarsthree and catalog-ui-management pass", async () => {
    const pub = await loadConfig(path.join(REPO_ROOT, "pipeline.catalog-ui-public.config.json"));
    expect(checkLabelVersion(pub, "2.0.0").ok).toBe(false);
    for (const project of ["webtarsthree", "catalog-ui-management"]) {
      const w = await loadConfig(path.join(REPO_ROOT, `pipeline.${project}.config.json`));
      expect(checkLabelVersion(w, "2.0.0")).toEqual({ ok: true });
    }
  });
});

describe("loadLoopConfig", () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-config-test-"));
    originalCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads and parses pipeline.loop.config.json from the current directory by default", async () => {
    await fs.writeFile(
      path.join(dir, "pipeline.loop.config.json"),
      JSON.stringify({ pollIntervalSec: 60 }),
      "utf8",
    );
    const loopConfig = await loadLoopConfig();
    expect(loopConfig.pollIntervalSec).toBe(60);
  });

  it("reads from an explicit path when given one", async () => {
    const filePath = path.join(dir, "custom.loop.config.json");
    await fs.writeFile(filePath, JSON.stringify({ pollIntervalSec: 30 }), "utf8");
    const loopConfig = await loadLoopConfig(filePath);
    expect(loopConfig.pollIntervalSec).toBe(30);
  });

  it("carries postRunDelaySec through when present", async () => {
    await fs.writeFile(
      path.join(dir, "pipeline.loop.config.json"),
      JSON.stringify({ pollIntervalSec: 60, postRunDelaySec: 5 }),
      "utf8",
    );
    const loopConfig = await loadLoopConfig();
    expect(loopConfig.postRunDelaySec).toBe(5);
  });

  it("throws if the file does not exist", async () => {
    await expect(loadLoopConfig()).rejects.toThrow();
  });
});

/**
 * Skill/agent/hook prose is pipeline logic with no unit test of its own.
 * These pin that it names only config keys the v2 loader accepts.
 */
describe(".claude/ prose references only v2 config keys", () => {
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return files(p);
      return e.isFile() ? [p] : [];
    });
  }
  const claudeFiles = files(path.join(REPO_ROOT, ".claude")).map((f) => ({
    rel: path.relative(REPO_ROOT, f),
    text: readFileSync(f, "utf8"),
  }));

  it("finds the skills, agents and hooks", () => {
    const rels = claudeFiles.map((f) => f.rel);
    expect(rels).toContain(path.join(".claude", "skills", "ticket-refine", "SKILL.md"));
    expect(rels.some((r) => r.startsWith(path.join(".claude", "agents")))).toBe(true);
    expect(rels.some((r) => r.startsWith(path.join(".claude", "hooks")))).toBe(true);
  });

  it("no .claude/ file mentions autoPromoteLabel (removed in 2.0.0, the loader rejects it)", () => {
    expect(claudeFiles.filter((f) => f.text.includes("autoPromoteLabel")).map((f) => f.rel)).toEqual([]);
  });

  it("no .claude/ file names a v1 config key path that moved under roles.*", () => {
    const v1Key =
      /\bjira\.(triggerLabel|handoffLabel|pollJql|codeReviewFields)\b|\bceilings\.(maxCostPerRunUsd|runTimeoutMin)\b|(?<![.\w])(triggerLabel|handoffLabel|pollJql|codeReviewFields)(?=`)/;
    const hits = claudeFiles.flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => v1Key.test(line))
        .map(({ line, i }) => `${f.rel}:${i + 1}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it("ticket-refine's passing-verdict comment never has a Needs-decision / Approve section (v1 parity: always omitted)", () => {
    const skill = readFileSync(path.join(REPO_ROOT, ".claude/skills/ticket-refine/SKILL.md"), "utf8");
    const start = skill.indexOf("2. **On a passing verdict**");
    const end = skill.indexOf("3. **On a bounce**");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const passing = skill.slice(start, end);
    expect(passing).not.toContain("**Needs decision:**");
    expect(passing).not.toMatch(/omit this\s+whole "Needs decision" section/);
    expect(skill).not.toContain("Approve — move to");
    expect(passing).toContain('A passing verdict\'s comment never has a "Needs decision" section');
  });
});

describe("validateConfig: optional sandbox block", () => {
  const withSandbox = (sb: unknown) => makeV2Config((c) => Object.assign(c, { sandbox: sb }));

  it("accepts an absent sandbox, {adapter:none}, and {adapter:none, mode:discover}", () => {
    expect(() => validateConfig(makeV2Config())).not.toThrow();
    expect(() => validateConfig(withSandbox({ adapter: "none" }))).not.toThrow();
    expect(() => validateConfig(withSandbox({ adapter: "none", mode: "discover" }))).not.toThrow();
  });

  it("rejects an unregistered adapter, naming sandbox.adapter and the valid names", () => {
    expect(() => validateConfig(withSandbox({ adapter: "bogus" }))).toThrow(
      'sandbox.adapter: unknown sandbox adapter "bogus"; valid: none, sbx',
    );
  });

  it("rejects a non-string adapter with a type error", () => {
    expect(() => validateConfig(withSandbox({ adapter: 5 }))).toThrow("sandbox.adapter must be a non-empty string");
  });

  it("rejects a bad mode", () => {
    expect(() => validateConfig(withSandbox({ adapter: "none", mode: "loud" }))).toThrow(
      'sandbox.mode must be "discover" or "enforce" (got "loud")',
    );
  });

  it("rejects an unknown key (keys() wording)", () => {
    expect(() => validateConfig(withSandbox({ adapter: "none", kitDir: "/x" }))).toThrow('sandbox: unknown key "kitDir"');
  });

  it("does not double the sandbox.<name> prefix when the adapter's message already has it", () => {
    expect(() => validateConfig(withSandbox({ adapter: "sbx" }))).toThrow(/^sandbox\.sbx: kitDir is required$/);
  });

  it("rejects a non-object sandbox", () => {
    expect(() => validateConfig(withSandbox("none"))).toThrow("sandbox must be an object");
  });

  it("accepts adapter settings with no adapter line (opt-in per run with --sandbox=<name>)", () => {
    expect(() => validateConfig(withSandbox({ mode: "discover", sbx: { kitDir: "/x" } }))).not.toThrow();
  });

  it("validates an adapter's settings even when no adapter line selects it", () => {
    expect(() => validateConfig(withSandbox({ mode: "discover", sbx: {} }))).toThrow(/^sandbox\.sbx: kitDir is required$/);
  });
});

describe("shipped configs use the major-only label", () => {
  it("webtarsthree and eval: pipeline:v2 / pipeline:v2:dev", async () => {
    for (const project of ["webtarsthree", "eval"]) {
      const c = await loadConfig(path.join(REPO_ROOT, `pipeline.${project}.config.json`));
      expect(c.roles.research.triggerLabel).toBe("pipeline:v2");
      expect(c.roles.research.handoffLabel).toBe("pipeline:v2:dev");
      expect(c.roles.dev.triggerLabel).toBe("pipeline:v2:dev");
    }
  });
});

describe("targetRepo.local", () => {
  const CATALOG = {
    appDir: "app",
    node: { versionFile: "app/.nvmrc" },
    envTemplate: { path: "app/.env.example", format: "dotenv" },
    realEnvFiles: ["app/.env.local"],
    robotEnv: {},
    devCommand: "npm run dev",
    devUrl: "http://localhost:3000",
  };
  const withLocal = (local: unknown): unknown =>
    makeV2Config((c) => {
      (c.targetRepo as unknown as Record<string, unknown>).local = local;
    });

  it("no local block gives today's defaults", () => {
    expect(localProfile(validateConfig(makeV2Config()))).toEqual({
      appDir: ".",
      versionFile: null,
      envTemplate: { path: ".envrc.example", format: "export" },
      realEnvFiles: [],
      robotEnv: {},
      devCommand: "npm run dev",
      devUrl: "http://localhost:3000",
    });
  });

  it("accepts catalog's block", () => {
    const { node, ...rest } = CATALOG;
    expect(localProfile(validateConfig(withLocal(CATALOG)))).toEqual({ ...rest, versionFile: node.versionFile });
  });

  it("an empty local block gives the defaults", () => {
    expect(localProfile(validateConfig(withLocal({}))).appDir).toBe(".");
  });

  it.each(["../x", "/abs", "app/", "", "a/../b", "app\\x", "./app"])("rejects appDir %s", (appDir) => {
    expect(() => validateConfig(withLocal({ appDir }))).toThrow(ConfigError);
    expect(() => validateConfig(withLocal({ appDir }))).toThrow(/targetRepo\.local\.appDir/);
  });

  it.each([
    ["node.versionFile", { node: { versionFile: "../x" } }],
    ["envTemplate.path", { envTemplate: { path: "../x", format: "dotenv" } }],
    ["realEnvFiles", { realEnvFiles: ["../x"] }],
    ["node.versionFile", { node: { versionFile: "." } }],
  ])("rejects a bad relative path in %s", (field, local) => {
    expect(() => validateConfig(withLocal(local))).toThrow(new RegExp(`targetRepo\\.local\\.${field.replace(".", "\\.")}`));
  });

  it("rejects an unknown format", () => {
    expect(() => validateConfig(withLocal({ envTemplate: { path: "a.env", format: "yaml" } }))).toThrow(/envTemplate\.format/);
  });

  it("rejects robotEnv names that change how commands run", () => {
    expect(() => validateConfig(withLocal({ robotEnv: { PATH: "x" } }))).toThrow(/robotEnv/);
    expect(() => validateConfig(withLocal({ robotEnv: { "bad name": "x" } }))).toThrow(/robotEnv/);
    expect(() => validateConfig(withLocal({ robotEnv: { OK: 1 } }))).toThrow(/robotEnv/);
  });

  it("rejects unknown keys in local", () => {
    expect(() => validateConfig(withLocal({ appdir: "app" }))).toThrow(/unknown key "appdir"/);
  });

  it("devUrl must be http(s)://localhost or 127.0.0.1", () => {
    expect(() => validateConfig(withLocal({ devUrl: "https://int.example.com" }))).toThrow(/devUrl/);
    expect(() => validateConfig(withLocal({ devUrl: "http://localhost.evil.com" }))).toThrow(/devUrl/);
    expect(localProfile(validateConfig(withLocal({ devUrl: "http://127.0.0.1:5173/x" }))).devUrl).toBe("http://127.0.0.1:5173/x");
  });
});
