/**
 * Sandbox adapter interface.
 *
 * A wall socket and plugs: the loop is the socket, and it talks only to this
 * interface. Each sandbox (a Docker sandbox plug, an Apple container plug, a
 * cloud sandbox plug) is one adapter file that fits the socket. The `none`
 * adapter is the default "no plug" case: the house works exactly as it does
 * today. Adding a sandbox = one adapter folder + one registry line in
 * index.ts. Removing an adapter = delete its folder + its registry line.
 */
import type { SpawnOptions } from "node:child_process";
import type { AtlassianMcp } from "../core/atlassian-tools.ts";
import type { ResetStep } from "../core/reset/step.ts";

export type SandboxMode = "discover" | "enforce";

/** The optional `sandbox` block of a project config. Adapter sub-blocks are keyed by adapter name. */
export interface SandboxConfig {
  /** Absent means the default adapter. */
  adapter?: string;
  mode?: SandboxMode;
  [adapterName: string]: unknown;
}

export interface PreflightCtx {
  repoRoot: string;
  mounts: string[];
  /** The cwd every spawn uses (the repo root); an adapter may check it like a mount. */
  cwd: string;
  /** A throwaway, project-scoped name for an adapter that needs a test instance. */
  instanceName: string;
  /** The project's "owner/repo" (config github.repo), for an adapter that checks GitHub reachability. */
  githubRepo?: string;
  /**
   * The target repo's checkout (REPO_DIR). The loop has written the robot's
   * fake env under it (src/core/fake-env.ts); an adapter that can cover the
   * real root env files does so here. Absent: nothing to cover.
   */
  repoDir?: string;
  /** The project's Node major (the project profile); absent means the host's. */
  nodeMajor?: number;
  /** The project's app folder, relative to repoDir (the project profile); absent means ".". */
  appDir?: string;
  config: unknown;
}

export interface RunSandboxSpec {
  instanceName: string;
  mounts: string[];
  /** Same as PreflightCtx.repoDir. */
  repoDir?: string;
  config: unknown;
}

export interface SandboxHandle {
  adapter: string;
  instanceName: string;
}

export interface WrappedSpawn {
  cmd: string;
  args: string[];
  opts: SpawnOptions & { env: NodeJS.ProcessEnv };
}

export interface SandboxDenial {
  kind: "network" | "credential" | "infra";
  target: string;
}

export interface SandboxReport {
  denied: SandboxDenial[];
  approveHint?: string;
}

export interface RunStartCtx {
  repoRoot: string;
  /** False when the run passed --no-dashboard. */
  dashboard: boolean;
  log: (msg: string) => void;
}

export interface SandboxAdapter {
  readonly name: string;
  /** Validate and normalize this adapter's own config sub-block (undefined when absent). Throws Error with a fix-naming message. */
  validateConfig(raw: unknown): unknown;
  preflight(ctx: PreflightCtx): Promise<void>;
  /**
   * Optional. Called once after preflight passes on a real run (not
   * --preflight-only), e.g. to open the adapter's live dashboard. Best effort:
   * must not throw.
   */
  onRunStart?(ctx: RunStartCtx): void;
  /**
   * Optional. Where the spawned agent finds the Atlassian MCP tools when this
   * adapter proxies MCP itself (server name + tool naming, see
   * src/core/atlassian-tools.ts). Absent: the host connector's names. The
   * allowlist is built from it; the hooks match any server name regardless.
   */
  atlassianMcp?(config: unknown): AtlassianMcp | undefined;
  /**
   * Optional. Where the operator's own skills (read by path, e.g. push-branch
   * in ticket-to-pr Phase 5) are inside this sandbox: skill name -> absolute
   * SKILL.md path. The loop passes each to the skill as `<name>=<path>`.
   * Absent, or a skill missing from the map: the skill reads its usual host
   * path (~/.claude/skills/<name>/SKILL.md), as a run outside any sandbox does.
   */
  hostSkillPaths?(config: unknown): Record<string, string>;
  /**
   * Optional. True when commits made inside this sandbox are signed and pushed
   * by the loop on the host, not by the agent: the dev agent stops at the
   * `ready_to_push` verdict and is told `push=host`. Absent or false: the
   * agent pushes itself, as in a run outside any sandbox.
   */
  hostPush?(config: unknown): boolean;
  /**
   * Remove leftover instances from an earlier crashed run. Removes only
   * instances whose name starts with `scope.prefix` (this project's
   * `dl-<len>-<project>-`); called after the session lock is held.
   */
  cleanupOrphans(scope: { prefix: string }): Promise<void>;
  /**
   * Optional. Steps for `npm run reset-project` (area "sandbox") that survey
   * and remove this adapter's leftovers for one ticket. `scope.prefix` is the
   * project's `dl-<len>-<project>-`; `scope.ticket` is the ticket as it appears
   * in instance names (lowercased, sanitized). Absent: nothing to reset.
   */
  resetSteps?(scope: { prefix: string; ticket: string }, config: unknown): ResetStep[];
  prepare(run: RunSandboxSpec): Promise<SandboxHandle>;
  /** Turn (cmd, args, opts) into what actually gets spawned. h must be the handle prepare returned. */
  wrap(h: SandboxHandle, cmd: string, args: string[], opts: WrappedSpawn["opts"]): WrappedSpawn;
  inspect(h: SandboxHandle, exitCode: number | null): Promise<SandboxReport>;
  /** Idempotent. May throw on a real failure; spawn-claude logs it and carries on. */
  teardown(h: SandboxHandle): Promise<void>;
}
