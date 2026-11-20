// Loads and validates pipeline.<project>.config.json (2.0.0 shape, spec
// section 6.4) and derives each role's view of it.
//
// validateConfig is strict: unknown keys, a missing field, a JQL-unsafe
// label/status value or a removed v1 key (autoPromoteLabel) all throw a
// ConfigError. "___" placeholders are allowed by the validator --
// requiredPlaceholderFree refuses the ones a given phase needs.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_ADAPTER, adapterNames, getAdapter } from "../sandbox/index.ts";
import { NEVER_OVERRIDE } from "./env-files.ts";
import type {
  Config,
  DevView,
  LocalProfile,
  LoopConfig,
  ResearchView,
  Role,
} from "./types.ts";

/** A config file that is missing, unparseable or fails validation. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Read, parse and validate a pipeline config file at the given path. There
 * is no default path: with multiple projects, an implicit default would
 * silently couple this loader to one project. Throws if the file is missing
 * (the fs error), and a ConfigError naming the file if it is not valid JSON
 * or fails validateConfig.
 */
export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    return validateConfig(parsed);
  } catch (err) {
    if (err instanceof ConfigError) throw new ConfigError(`${path}: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

/** Characters that would break out of a quoted JQL string. */
const JQL_UNSAFE = /["\\\r\n]/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown, at: string): Obj {
  if (!isObj(v)) throw new ConfigError(`${at} must be an object`);
  return v;
}

/** Throws on any key of `o` not in `allowed`; on a missing required key. */
function keys(o: Obj, at: string, required: string[], optional: string[] = []): void {
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) {
      throw new ConfigError(`${at}: unknown key "${k}"`);
    }
  }
  for (const k of required) {
    if (!(k in o)) throw new ConfigError(`${at ? `${at}.` : ""}${k} is required`);
  }
}

function str(o: Obj, k: string, at: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) {
    throw new ConfigError(`${at}.${k} must be a non-empty string`);
  }
  return v;
}

/** A label or status name: interpolated into a quoted JQL string. */
function jqlValue(o: Obj, k: string, at: string): string {
  const v = str(o, k, at);
  if (JQL_UNSAFE.test(v)) {
    throw new ConfigError(`${at}.${k} must not contain a double quote, backslash or newline (it is interpolated into JQL): ${JSON.stringify(v)}`);
  }
  return v;
}

function positive(o: Obj, k: string, at: string, integer = false): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
    throw new ConfigError(`${at}.${k} must be a${integer ? "n integer" : " number"} > 0 (got ${JSON.stringify(v)})`);
  }
  return v;
}

function roleCeilings(v: unknown, at: string): void {
  const c = obj(v, at);
  keys(c, at, ["maxCostPerRunUsd", "runTimeoutMin"]);
  positive(c, "maxCostPerRunUsd", at);
  positive(c, "runTimeoutMin", at);
}

/**
 * Validate a parsed config against the 2.0.0 shape and return it typed.
 * Pure. Throws a ConfigError naming the offending path.
 */
export function validateConfig(raw: unknown): Config {
  const root = obj(raw, "config");
  if ("autoPromoteLabel" in root) {
    throw new ConfigError(
      "autoPromoteLabel was removed in 2.0.0: a green research verdict always hands off to dev (spec section 6.3). Delete the key.",
    );
  }
  keys(root, "", ["targetRepo", "github", "jira", "roles", "ceilings"], ["sandbox"]);

  const targetRepo = obj(root.targetRepo, "targetRepo");
  keys(targetRepo, "targetRepo", ["url", "defaultBranch"], ["path", "local"]);
  str(targetRepo, "url", "targetRepo");
  str(targetRepo, "defaultBranch", "targetRepo");
  if ("path" in targetRepo) str(targetRepo, "path", "targetRepo");
  if ("local" in targetRepo) localBlock(targetRepo.local, "targetRepo.local");

  const github = obj(root.github, "github");
  keys(github, "github", ["repo"]);
  str(github, "repo", "github");

  const jira = obj(root.jira, "jira");
  keys(jira, "jira", ["repoLabel", "statusNames", "claimStatus"]);
  jqlValue(jira, "repoLabel", "jira");
  const statusNames = obj(jira.statusNames, "jira.statusNames");
  keys(statusNames, "jira.statusNames", ["bounced", "prOpen"]);
  jqlValue(statusNames, "bounced", "jira.statusNames");
  jqlValue(statusNames, "prOpen", "jira.statusNames");
  const claimStatus = obj(jira.claimStatus, "jira.claimStatus");
  keys(claimStatus, "jira.claimStatus", ["from", "to"]);
  jqlValue(claimStatus, "from", "jira.claimStatus");
  jqlValue(claimStatus, "to", "jira.claimStatus");

  const roles = obj(root.roles, "roles");
  keys(roles, "roles", ["research", "dev"]);
  const research = obj(roles.research, "roles.research");
  keys(research, "roles.research", ["triggerLabel", "handoffLabel", "pollJql", "ceilings"]);
  const researchTrigger = jqlValue(research, "triggerLabel", "roles.research");
  const handoff = jqlValue(research, "handoffLabel", "roles.research");
  str(research, "pollJql", "roles.research");
  roleCeilings(research.ceilings, "roles.research.ceilings");

  const dev = obj(roles.dev, "roles.dev");
  keys(dev, "roles.dev", ["triggerLabel", "pollJql", "codeReviewFields", "ceilings"]);
  const devTrigger = jqlValue(dev, "triggerLabel", "roles.dev");
  str(dev, "pollJql", "roles.dev");
  const crf = obj(dev.codeReviewFields, "roles.dev.codeReviewFields");
  keys(crf, "roles.dev.codeReviewFields", ["piiField", "piiNoImpactOptionId", "qaNotesField"]);
  for (const k of ["piiField", "piiNoImpactOptionId", "qaNotesField"]) str(crf, k, "roles.dev.codeReviewFields");
  roleCeilings(dev.ceilings, "roles.dev.ceilings");

  if (handoff !== devTrigger) {
    throw new ConfigError(
      `roles.research.handoffLabel ("${handoff}") must equal roles.dev.triggerLabel ("${devTrigger}"): the research handoff is what the dev poll matches`,
    );
  }
  if (researchTrigger === devTrigger) {
    throw new ConfigError(
      `roles.research.triggerLabel and roles.dev.triggerLabel must differ (both "${devTrigger}"), or a refined ticket would re-match the research poll`,
    );
  }

  const ceilings = obj(root.ceilings, "ceilings");
  keys(ceilings, "ceilings", ["maxRunsPerDay", "maxAttemptsPerTicket", "maxCostPerTicketUsd"]);
  positive(ceilings, "maxRunsPerDay", "ceilings", true);
  positive(ceilings, "maxAttemptsPerTicket", "ceilings", true);
  positive(ceilings, "maxCostPerTicketUsd", "ceilings");

  if ("sandbox" in root) validateSandbox(root.sandbox);

  return raw as Config;
}

/** A path relative to the repo root: plain segments, no "..", no leading or trailing slash. */
const REL_PATH = /^[A-Za-z0-9@._+-]+(\/[A-Za-z0-9@._+-]+)*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/;

function relPath(v: unknown, at: string, allowDot = false): void {
  const ok =
    typeof v === "string" &&
    REL_PATH.test(v) &&
    !v.split("/").some((seg) => seg === ".." || (seg === "." && !(allowDot && v === ".")));
  if (!ok) {
    throw new ConfigError(`${at} must be a path relative to the repo root, with no ".." and no leading or trailing slash (got ${JSON.stringify(v)})`);
  }
}

/** targetRepo.local: how the project runs locally (types.ts LocalProfileConfig). */
function localBlock(v: unknown, at: string): void {
  const l = obj(v, at);
  keys(l, at, [], ["appDir", "node", "envTemplate", "realEnvFiles", "robotEnv", "devCommand", "devUrl"]);
  if ("appDir" in l) relPath(l.appDir, `${at}.appDir`, true);
  if ("node" in l) {
    const n = obj(l.node, `${at}.node`);
    keys(n, `${at}.node`, ["versionFile"]);
    relPath(n.versionFile, `${at}.node.versionFile`);
  }
  if ("envTemplate" in l) {
    const t = obj(l.envTemplate, `${at}.envTemplate`);
    keys(t, `${at}.envTemplate`, ["path", "format"]);
    relPath(t.path, `${at}.envTemplate.path`);
    if (t.format !== "export" && t.format !== "dotenv") {
      throw new ConfigError(`${at}.envTemplate.format must be "export" or "dotenv" (got ${JSON.stringify(t.format)})`);
    }
  }
  if ("realEnvFiles" in l) {
    if (!Array.isArray(l.realEnvFiles)) throw new ConfigError(`${at}.realEnvFiles must be an array of paths`);
    l.realEnvFiles.forEach((p, i) => relPath(p, `${at}.realEnvFiles[${i}]`));
  }
  if ("robotEnv" in l) {
    const r = obj(l.robotEnv, `${at}.robotEnv`);
    for (const [name, value] of Object.entries(r)) {
      if (!ENV_NAME.test(name) || NEVER_OVERRIDE.test(name)) {
        throw new ConfigError(`${at}.robotEnv: ${JSON.stringify(name)} is not a settable name (letters, digits, _; never PATH, HOME, NODE_OPTIONS, GIT_* and the like)`);
      }
      if (typeof value !== "string") throw new ConfigError(`${at}.robotEnv.${name} must be a string`);
    }
  }
  if ("devCommand" in l) str(l, "devCommand", at);
  if ("devUrl" in l) {
    const u = str(l, "devUrl", at);
    if (!LOCAL_URL.test(u)) throw new ConfigError(`${at}.devUrl must be http(s)://localhost or 127.0.0.1 (got ${JSON.stringify(u)})`);
  }
}

/** targetRepo.local with every default filled in. No block reproduces today's (root, host Node, .envrc.example). */
export function localProfile(config: Config): LocalProfile {
  const l = config.targetRepo.local ?? {};
  return {
    appDir: l.appDir ?? ".",
    versionFile: l.node?.versionFile ?? null,
    envTemplate: l.envTemplate ? { ...l.envTemplate } : { path: ".envrc.example", format: "export" },
    realEnvFiles: [...(l.realEnvFiles ?? [])],
    robotEnv: { ...(l.robotEnv ?? {}) },
    devCommand: l.devCommand ?? "npm run dev",
    devUrl: l.devUrl ?? "http://localhost:3000",
  };
}

/** The optional sandbox block; each adapter validates its own sub-block. */
function validateSandbox(v: unknown): void {
  const sb = obj(v, "sandbox");
  keys(sb, "sandbox", [], ["adapter", "mode", ...adapterNames()]);
  if (sb.adapter !== undefined) str(sb, "adapter", "sandbox");
  let adapter;
  try {
    adapter = getAdapter((sb.adapter as string | undefined) ?? DEFAULT_ADAPTER);
  } catch (err) {
    throw new ConfigError(`sandbox.adapter: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (sb.mode !== undefined && sb.mode !== "discover" && sb.mode !== "enforce") {
    throw new ConfigError(`sandbox.mode must be "discover" or "enforce" (got ${JSON.stringify(sb.mode)})`);
  }
  // The selected adapter, plus every adapter whose settings are present: a
  // block kept for an opt-in run (--sandbox=<name>, no adapter line) is
  // checked at load, not first at that run.
  const names = new Set([adapter.name, ...adapterNames().filter((n) => sb[n] !== undefined)]);
  for (const name of names) {
    try {
      getAdapter(name).validateConfig(sb[name]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const prefix = `sandbox.${name}: `;
      throw new ConfigError(msg.startsWith(prefix) ? msg : `${prefix}${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Role views
// ---------------------------------------------------------------------------

/**
 * Everything one role reads from the config: its own label(s), JQL and
 * per-run ceilings, plus the shared jira values and maxRunsPerDay (counted
 * per role). The runners take this, never the whole Config.
 */
export function roleView(config: Config, role: "research"): ResearchView;
export function roleView(config: Config, role: "dev"): DevView;
export function roleView(config: Config, role: Role): ResearchView | DevView;
export function roleView(config: Config, role: Role): ResearchView | DevView {
  const shared = {
    repoLabel: config.jira.repoLabel,
    claimStatus: { ...config.jira.claimStatus },
    statusNames: { ...config.jira.statusNames },
  };
  if (role === "research") {
    const r = config.roles.research;
    return {
      pollJql: r.pollJql,
      triggerLabel: r.triggerLabel,
      handoffLabel: r.handoffLabel,
      ...shared,
      limits: { maxRunsPerDay: config.ceilings.maxRunsPerDay, ...r.ceilings },
    };
  }
  if (role === "dev") {
    const d = config.roles.dev;
    return {
      pollJql: d.pollJql,
      triggerLabel: d.triggerLabel,
      ...shared,
      codeReviewFields: { ...d.codeReviewFields },
      limits: { maxRunsPerDay: config.ceilings.maxRunsPerDay, ...d.ceilings },
    };
  }
  throw new Error(`roleView: unknown role ${JSON.stringify(role)}`);
}

// ---------------------------------------------------------------------------
// Label-version guard (worker mode, enforced from Task 15)
// ---------------------------------------------------------------------------

/** "pipeline:v2" (or "pipeline:v2:dev") -> "2"; an unversioned or full-version label -> null. */
export function labelMajor(label: string): string | null {
  return /^pipeline:v(\d+)(?::|$)/.exec(label)?.[1] ?? null;
}

const major = (version: string): string => version.split(".")[0];

/**
 * Worker mode only runs a config whose research trigger label carries this
 * package's major version (pipeline:v<major>), so v1 and v2 never take each
 * other's tickets. Minor and patch releases share the label, so it holds no
 * minor/patch part to fall out of date.
 */
export function checkLabelVersion(
  config: Config,
  pkgVersion: string,
): { ok: true } | { ok: false; error: string } {
  const label = config.roles.research.triggerLabel;
  const expected = `pipeline:v${major(pkgVersion)}`;
  const labelMaj = labelMajor(label);
  if (labelMaj === null) {
    return {
      ok: false,
      error: `worker mode needs a versioned trigger label (pipeline:v<major>); roles.research.triggerLabel is "${label}" (dev-loop ${pkgVersion} expects "${expected}")`,
    };
  }
  if (labelMaj !== major(pkgVersion)) {
    return {
      ok: false,
      error: `trigger label "${label}" is for major version ${labelMaj}, but this is dev-loop ${pkgVersion} (major version mismatch)`,
    };
  }
  return { ok: true };
}

/**
 * Read and parse pipeline.loop.config.json -- loop-mechanics settings, not
 * project wiring, so (unlike loadConfig) there's no multi-project ambiguity
 * to guard against: a plain default path is fine. `path` defaults to
 * "pipeline.loop.config.json" in the current working directory.
 */
export async function loadLoopConfig(
  path: string = "pipeline.loop.config.json",
): Promise<LoopConfig> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as LoopConfig;
}

/**
 * Derive a filesystem-safe project slug from a target repo's git remote
 * URL, e.g. "webtarsthree" from "git@github.com:fandango/webtarsthree.git"
 * or "https://github.com/fandango/webtarsthree". Used to namespace
 * per-project paths (runs log, `.pipeline/` workdir) so multiple projects'
 * configs can coexist in one pipeline repo without collisions.
 */
export function repoSlugFromUrl(url: string): string {
  const withoutGitSuffix = url.replace(/\.git$/, "");
  const lastSegment = withoutGitSuffix.split(/[/:]/).pop();
  if (!lastSegment) {
    throw new Error(`repoSlugFromUrl: could not derive a slug from "${url}".`);
  }
  return lastSegment;
}

/**
 * List available project names at `dir` (repo root by default): every
 * "pipeline.<name>.config.json" file present, minus
 * "pipeline.loop.config.json" (loop-mechanics, not a project). Returns an
 * empty array if `dir` doesn't exist or has no matching files -- never
 * throws, since this is only ever used to build a human-readable error
 * listing for --project.
 */
export async function listAvailableProjects(dir: string = "."): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .map((name) => /^pipeline\.(.+)\.config\.json$/.exec(name)?.[1])
    .filter((name): name is string => name !== undefined && name !== "loop")
    .sort();
}

/**
 * Resolve a --project name to its "pipeline.<name>.config.json" path at
 * `dir` (repo root by default). Throws a clear, synchronous error listing
 * the actually-available projects if `projectName` is omitted, or if no
 * config file exists for it -- this runs before any Jira/GitHub I/O, so a
 * typo or missing flag fails fast instead of surfacing as a confusing
 * downstream error.
 */
export async function resolveProjectConfigPath(
  projectName: string | undefined,
  dir: string = ".",
): Promise<string> {
  const available = await listAvailableProjects(dir);
  const list = available.length > 0 ? available.join(", ") : "(none found)";
  if (!projectName) {
    throw new Error(`--project <name> is required. Available projects: ${list}`);
  }
  if (!available.includes(projectName)) {
    throw new Error(
      `Unknown project "${projectName}" (no pipeline.${projectName}.config.json in ${dir}). Available projects: ${list}`,
    );
  }
  return join(dir, `pipeline.${projectName}.config.json`);
}

/**
 * The directory to grant the spawned `claude -p` session access to via
 * `--add-dir`, beyond dev-loop's own cwd. When `targetRepo.path` is set,
 * ticket-to-pr's per-run worktrees are created inside that checkout (see
 * docs/logging.md), which sits outside dev-loop's own directory tree --
 * without an explicit grant, every Edit/Write into the worktree is denied
 * regardless of `--permission-mode acceptEdits` (that flag only
 * auto-answers the permission *prompt* for Edit/Write, it doesn't grant
 * directory access). Returns null when `targetRepo.path` is unset, since
 * the clone-based flow's worktrees live under the v2 clone
 * (`v2CloneDir`), already inside dev-loop's own cwd. Both roles get it.
 */
export function targetRepoAddDir(config: Config): string | null {
  return config.targetRepo.path ?? null;
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/** Paths every phase needs, with a getter. */
type PathGetter = [string, (c: Config) => string | undefined];

const SHARED_PATHS: PathGetter[] = [
  ["targetRepo.url", (c) => c.targetRepo.url],
  ["targetRepo.defaultBranch", (c) => c.targetRepo.defaultBranch],
  ["github.repo", (c) => c.github.repo],
  ["jira.repoLabel", (c) => c.jira.repoLabel],
  ["jira.statusNames.bounced", (c) => c.jira.statusNames.bounced],
  ["jira.statusNames.prOpen", (c) => c.jira.statusNames.prOpen],
  ["jira.claimStatus.from", (c) => c.jira.claimStatus.from],
  ["jira.claimStatus.to", (c) => c.jira.claimStatus.to],
];

const RESEARCH_PATHS: PathGetter[] = [
  ["roles.research.triggerLabel", (c) => c.roles.research.triggerLabel],
  ["roles.research.handoffLabel", (c) => c.roles.research.handoffLabel],
  ["roles.research.pollJql", (c) => c.roles.research.pollJql],
];

const DEV_PATHS: PathGetter[] = [
  ["roles.dev.triggerLabel", (c) => c.roles.dev.triggerLabel],
  ["roles.dev.pollJql", (c) => c.roles.dev.pollJql],
  ["roles.dev.codeReviewFields.piiField", (c) => c.roles.dev.codeReviewFields.piiField],
  ["roles.dev.codeReviewFields.piiNoImpactOptionId", (c) => c.roles.dev.codeReviewFields.piiNoImpactOptionId],
  ["roles.dev.codeReviewFields.qaNotesField", (c) => c.roles.dev.codeReviewFields.qaNotesField],
];

/** A value is a placeholder if it is "___", or (a JQL template) contains "___". */
const isPlaceholder = (v: string | undefined): boolean => v === undefined || v.includes("___");

/**
 * Throws a ConfigError naming every "___" path the phase needs (Appendix A
 * of the pipeline spec not yet filled in). research needs the shared values
 * plus its own; dev needs the shared values plus its own; worker needs
 * both. Fails closed:
 * an unknown phase (an untyped caller) gets the worker check.
 */
export function requiredPlaceholderFree(config: Config, phase: Role | "worker"): void {
  const paths = [
    ...SHARED_PATHS,
    ...(phase === "dev" ? [] : RESEARCH_PATHS),
    ...(phase === "research" ? [] : DEV_PATHS),
  ];
  const missing = paths.filter(([, get]) => isPlaceholder(get(config))).map(([path]) => path);
  if (missing.length > 0) {
    throw new ConfigError(
      `--phase ${phase}: the config still has placeholder "___" values for: ${missing.join(", ")}. ` +
        `Fill in Appendix A of the pipeline spec (docs/config.md) first.`,
    );
  }
}
