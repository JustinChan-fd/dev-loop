// The one module that knows every on-disk path the pipeline uses. Every
// segment is validated against the Global Constraints identifier regexes and
// every result is checked to stay inside the directory it belongs to, so a
// hostile ticket key / session id / slug can never escape (UnsafePathError).

import { isAbsolute, resolve, sep } from "node:path";
import type { Role } from "./types.ts";

/** A Jira issue key, e.g. "TARS-1465". */
export const TICKET_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
/** A session id, e.g. "s1". */
export const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A project slug. */
export const PROJECT_SLUG = /^[a-z0-9-]+$/;
/** The format runIdNow() produces. */
export const RUN_ID = /^\d{8}T\d{6}Z$/;

/**
 * True iff `name` is a worktree dir the pipeline itself makes for `ticket`
 * under `<repo>/.claude/worktrees/`: `<TICKET>-<RUN_ID>` (ticket-to-pr's run
 * worktree), `-ground` (ticket-refine), `-baseline` and `-fu` (ticket-to-pr's
 * baseline and follow-up worktrees). A person's own `<TICKET>-okta-spike` is not.
 */
export function isPipelineWorktree(ticket: string, name: string): boolean {
  if (!TICKET_KEY.test(ticket) || !name.startsWith(`${ticket}-`)) return false;
  return /^\d{8}T\d{6}Z(-ground|-baseline|-fu|-push)?$/.test(name.slice(ticket.length + 1));
}

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ROLES: readonly string[] = ["research", "dev"];

function check(label: string, value: string, re: RegExp): string {
  if (typeof value !== "string" || !re.test(value)) {
    throw new UnsafePathError(`${label} ${JSON.stringify(value)} must match ${re}`);
  }
  return value;
}

function checkRole(role: string): Role {
  if (!ROLES.includes(role)) throw new UnsafePathError(`role ${JSON.stringify(role)} must be one of ${ROLES.join(", ")}`);
  return role as Role;
}

function contain(rel: string, base: string, roots: string[]): string {
  const abs = resolve(base, rel);
  if (!roots.some((r) => abs.startsWith(resolve(base, r) + sep))) {
    throw new UnsafePathError(`path ${JSON.stringify(rel)} escapes ${roots.join(" and ")}`);
  }
  return rel;
}

const V2 = ["runs/v2", ".pipeline/v2"];

/** runs/v2/<project>.jsonl */
export function v2RunsLog(project: string): string {
  check("project", project, PROJECT_SLUG);
  return contain(`runs/v2/${project}.jsonl`, REPO_ROOT, V2);
}

/** runs/v1/<role>/<project>.jsonl (post-cutover v1 archive layout). */
export function v1RunsLog(role: Role, project: string): string {
  checkRole(role);
  check("project", project, PROJECT_SLUG);
  return contain(`runs/v1/${role}/${project}.jsonl`, REPO_ROOT, ["runs/v1"]);
}

/** runs/v2/<project>.reset-archive.jsonl: where reset moves archived v2 records (append-only). */
export function v2RunsArchive(project: string): string {
  check("project", project, PROJECT_SLUG);
  return contain(`runs/v2/${project}.reset-archive.jsonl`, REPO_ROOT, V2);
}

/** .pipeline/v2/<project>: the project's v2 state root (session dirs, sessions/, repo/). */
export function v2ProjectDir(project: string): string {
  check("project", project, PROJECT_SLUG);
  return contain(`.pipeline/v2/${project}`, REPO_ROOT, V2);
}

const PRE_CUTOVER = ["runs", "research-loop/runs"];

/**
 * The pre-cutover live v1 log of a role, repo-root-relative: dev wrote
 * runs/<project>.jsonl, research wrote research-loop/runs/<project>.jsonl.
 * v1 readers use it only when the post-cutover v1RunsLog file is absent.
 */
export function v1PreCutoverRunsLog(role: Role, project: string): string {
  checkRole(role);
  check("project", project, PROJECT_SLUG);
  const rel = role === "dev" ? `runs/${project}.jsonl` : `research-loop/runs/${project}.jsonl`;
  return contain(rel, REPO_ROOT, PRE_CUTOVER);
}

/** .pipeline/v2/<project>/<session>/<ticket>/<phase>-<runId> (usage.json lives inside). */
export function v2RunDir(project: string, session: string, ticket: string, phase: Role, runId: string): string {
  check("project", project, PROJECT_SLUG);
  check("session", session, SESSION_ID);
  check("ticket", ticket, TICKET_KEY);
  checkRole(phase);
  check("runId", runId, RUN_ID);
  return contain(`.pipeline/v2/${project}/${session}/${ticket}/${phase}-${runId}`, REPO_ROOT, V2);
}

/** An eval fixture's name (evals/fixtures/<name>/). */
export const FIXTURE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** .pipeline/v2/fixtures/<fixture>/<ticket>/research-<runId>: a fixture run's RUN_DIR (eval fixtures). */
export function v2FixtureRunDir(fixture: string, ticket: string, runId: string): string {
  check("fixture", fixture, FIXTURE_NAME);
  check("ticket", ticket, TICKET_KEY);
  check("runId", runId, RUN_ID);
  return contain(`.pipeline/v2/fixtures/${fixture}/${ticket}/research-${runId}`, REPO_ROOT, V2);
}

/** runs/v2/fixtures/<fixture>.jsonl: a fixture's own log. Never a project's v2 log. */
export function v2FixtureRunsLog(fixture: string): string {
  check("fixture", fixture, FIXTURE_NAME);
  return contain(`runs/v2/fixtures/${fixture}.jsonl`, REPO_ROOT, V2);
}

/** .pipeline/v2/<project>/repo */
export function v2CloneDir(project: string): string {
  check("project", project, PROJECT_SLUG);
  return contain(`.pipeline/v2/${project}/repo`, REPO_ROOT, V2);
}

/** .pipeline/v2/<project>/sessions */
export function v2SessionsDir(project: string): string {
  check("project", project, PROJECT_SLUG);
  return contain(`.pipeline/v2/${project}/sessions`, REPO_ROOT, V2);
}

/** "YYYYMMDDTHHMMSSZ" (UTC). */
export function runIdNow(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/** Resolve a repo-relative path from the functions above to an absolute one, re-checking containment. */
export function resolveRepoPath(rel: string): string {
  if (isAbsolute(rel)) throw new UnsafePathError(`path ${JSON.stringify(rel)} must be repo-relative`);
  contain(rel, REPO_ROOT, [...V2, "runs/v1", ...PRE_CUTOVER]);
  return resolve(REPO_ROOT, rel);
}
