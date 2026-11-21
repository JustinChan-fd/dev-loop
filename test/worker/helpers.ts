// Shared fakes for the worker-cycle tests: a scriptable Jira client built on
// StubJiraClient, a fake session handle, a scripted runSkill, a fake GitHub
// client, a movable clock and a temp log dir. No live calls.

import { vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubJiraClient } from "../../src/core/jira-client.ts";
import type { JiraTicket } from "../../src/core/jira-client.ts";
import type { GitHubClient } from "../../src/core/github-client.ts";
import type { InFlight } from "../../src/core/session.ts";
import type { Config, Role } from "../../src/core/types.ts";
import type { RunSkillFn, RunSkillResult } from "../../src/core/run-skill.ts";
import type { WorkerDeps } from "../../src/worker/cycle.ts";
import { makeV2Config } from "../fixtures/config.ts";

export const RESEARCH_LABEL = "pipeline:v2";
export const DEV_LABEL = "pipeline:v2:dev";
export const T0 = Date.parse("2026-11-11T12:00:00.000Z");

export type Event = unknown[];

/** A JiraClient whose polls answer from per-role ticket lists, honouring `key not in (...)`. */
export class FakeJira extends StubJiraClient {
  events: Event[];
  research: JiraTicket[] = [];
  dev: JiraTicket[] = [];
  polls: string[] = [];
  blockers: Record<string, string[]> = {};
  pollError: Error | null = null;
  claimImpl: (key: string) => Promise<boolean> = async () => true;
  swapImpl: (key: string, from: string, to: string) => Promise<void> = async () => {};
  transitionImpl: (key: string, to: string) => Promise<void> = async () => {};
  assignImpl: (key: string) => Promise<void> = async () => {};
  commentImpl: (key: string) => Promise<void> = async () => {};
  comments: Array<{ key: string; body: Record<string, unknown> }> = [];
  /** Live status by key; unknown keys read "In Progress" (the claim target). */
  statuses: Record<string, string> = {};
  statusImpl: (key: string) => Promise<void> = async () => {};

  constructor(events: Event[]) {
    super({ blockedBy: {} });
    this.events = events;
  }

  async pollOldestMatching(jql: string): Promise<JiraTicket | null> {
    this.polls.push(jql);
    this.events.push(["poll", jql]);
    if (this.pollError) throw this.pollError;
    const list_ = (re: RegExp) =>
      new Set(
        (re.exec(jql)?.[1] ?? "")
          .split(",")
          .map((s) => s.replace(/"/g, "").trim())
          .filter(Boolean),
      );
    const excluded = list_(/key not in \(([^)]*)\)/);
    const excludedIds = list_(/\bid not in \(([^)]*)\)/);
    const list = jql.includes(`"${DEV_LABEL}"`) ? this.dev : this.research;
    return list.find((t) => !excluded.has(t.key) && !(t.id !== undefined && excludedIds.has(t.id))) ?? null;
  }

  async claimTicket(key: string, from: string, to: string): Promise<boolean> {
    this.events.push(["claimTicket", key, from, to]);
    return this.claimImpl(key);
  }

  async swapLabel(key: string, from: string, to: string): Promise<void> {
    this.events.push(["swapLabel", key, from, to]);
    return this.swapImpl(key, from, to);
  }

  async transitionStatus(key: string, to: string, fields?: Record<string, unknown>): Promise<void> {
    this.events.push(["transitionStatus", key, to, fields]);
    return this.transitionImpl(key, to);
  }

  async assignTicket(key: string, accountId: string): Promise<void> {
    this.events.push(["assignTicket", key, accountId]);
    return this.assignImpl(key);
  }

  async addComment(key: string, body: Record<string, unknown>): Promise<void> {
    this.events.push(["addComment", key, body]);
    this.comments.push({ key, body });
    return this.commentImpl(key);
  }

  async removeLabel(key: string, label: string): Promise<void> {
    this.events.push(["removeLabel", key, label]);
  }

  async getStatus(key: string): Promise<string> {
    this.events.push(["getStatus", key]);
    await this.statusImpl(key);
    return this.statuses[key] ?? "In Progress";
  }

  /** Blocker status for the gate; unknown keys read "In Progress". */
  statusDetails: Record<string, { name: string; done: boolean }> = {};

  async getStatusDetail(key: string): Promise<{ name: string; done: boolean }> {
    this.events.push(["getStatusDetail", key]);
    return { ...(this.statusDetails[key] ?? { name: "In Progress", done: false }) };
  }

  async getBlockedBy(key: string): Promise<string[]> {
    this.events.push(["getBlockedBy", key]);
    return [...(this.blockers[key] ?? [])];
  }

  calls(name: string): Event[] {
    return this.events.filter((e) => e[0] === name);
  }
}

export function makeGitHub(events: Event[]): GitHubClient & { comments: Array<{ n: number; body: string }> } {
  const comments: Array<{ n: number; body: string }> = [];
  return {
    comments,
    findIssueByJiraKey: vi.fn(async (k: string) => ({ number: 7, url: `https://github.com/org/repo/issues/7#${k}`, state: "OPEN" as const })),
    createIssue: vi.fn(async () => ({ number: 7, url: "https://github.com/org/repo/issues/7", state: "OPEN" as const })),
    addComment: vi.fn(async (n: number, body: string) => {
      events.push(["gh.addComment", n, body]);
      comments.push({ n, body });
    }),
    closeIssue: vi.fn(async () => {}),
    closePr: vi.fn(async () => "already-closed" as const),
  };
}

export interface FakeSession {
  name: string;
  inFlight: InFlight | null;
  orphanedInFlight: InFlight[];
  current: InFlight | null;
  setInFlight: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

export function makeSession(
  name = "dev-1",
  inFlight: InFlight | null = null,
  orphaned: InFlight[] = [],
  /** Make the n-th (1-based) setInFlight call throw, e.g. a lost lock. */
  failOn?: (f: InFlight | null, n: number) => boolean,
): FakeSession {
  let n = 0;
  const s: FakeSession = {
    name,
    inFlight,
    orphanedInFlight: orphaned,
    current: inFlight,
    setInFlight: vi.fn(async (f: InFlight | null) => {
      n++;
      if (failOn?.(f, n)) throw new Error("session lock lost");
      s.current = f;
    }),
    release: vi.fn(async () => {}),
  };
  return s;
}

export function ticket(key: string, o: Partial<JiraTicket> = {}): JiraTicket {
  const id = String(10000 + Number(/(\d+)$/.exec(key)?.[1] ?? 0));
  return { key, id, status: "To Do", assignee: "acc-1", labels: [RESEARCH_LABEL, "repo:org-repo"], ...o };
}

export function devTicket(key: string, o: Partial<JiraTicket> = {}): JiraTicket {
  return ticket(key, { status: "In Progress", labels: [DEV_LABEL, "repo:org-repo"], ...o });
}

export const researchVerdict = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ outcome: "ready", phase_reached: "verify", failure_category: null, detail: "refined", ...o });

export const researchBounce = (detail = "AC2 contradicts AC4"): string =>
  researchVerdict({ outcome: "bounced", failure_category: "spec_contradicted", detail });

export const devVerdict = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({
    outcome: "landed",
    phase_reached: "pr",
    failure_category: null,
    detail: "PR opened",
    red_confirmed: true,
    verify_loops: 1,
    retries: 0,
    skill_version: "x",
    model: "sonnet",
    pr: "https://github.com/org/repo/pull/5",
    cost_usd: 0,
    tokens: { in: 0, out: 0 },
    ...o,
  });

export const devBounce = (detail = "AC3 is unspecified"): string =>
  devVerdict({ outcome: "bounced", failure_category: "spec_ambiguous", detail, pr: null });

export const devError = (): string =>
  devVerdict({ outcome: "error", failure_category: "agent_error", detail: "crashed in green", pr: null });

export type Step = Partial<RunSkillResult> | Error;

export function scriptedRunSkill(events: Event[], script: Partial<Record<Role, Step[]>> = {}): RunSkillFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (args: Parameters<RunSkillFn>[0]) => {
    events.push(["runSkill", args.role, args.ticketKey, args.maxBudgetUsd, args.runDir]);
    const step = script[args.role]?.shift();
    if (step instanceof Error) throw step;
    const base: RunSkillResult = {
      verdictRaw: args.role === "research" ? researchVerdict() : devVerdict(),
      started: "2026-11-11T11:00:00.000Z",
      ended: "2026-11-11T11:10:00.000Z",
      costUsd: 1,
      tokens: { in: 10, out: 5 },
      skillVersion: "sha-1",
      model: "sonnet",
    };
    return { ...base, ...step };
  }) as unknown as RunSkillFn & ReturnType<typeof vi.fn>;
}

export interface Harness {
  dir: string;
  logPath: string;
  events: Event[];
  jira: FakeJira;
  github: ReturnType<typeof makeGitHub>;
  session: FakeSession;
  clock: { t: number; advance: (ms: number) => void };
  logs: string[];
  deps: WorkerDeps;
  /** A fresh WorkerDeps over the same log/jira (a new process): new session, new runSkill. */
  restart: (o?: Partial<WorkerDeps>) => WorkerDeps;
  cleanup: () => Promise<void>;
}

export async function harness(
  o: {
    config?: (c: Config) => void;
    script?: Partial<Record<Role, Step[]>>;
    session?: FakeSession;
    deps?: Partial<WorkerDeps>;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "worker-cycle-"));
  const logPath = join(dir, "v2.jsonl");
  const events: Event[] = [];
  const jira = new FakeJira(events);
  const github = makeGitHub(events);
  const session = o.session ?? makeSession();
  const clock = {
    t: T0,
    advance(ms: number) {
      clock.t += ms;
    },
  };
  const logs: string[] = [];
  const config = makeV2Config(o.config);
  const base = (): WorkerDeps => ({
    jira,
    github,
    config,
    slug: "repo",
    session,
    loopVersion: "2.0.0",
    runSkill: scriptedRunSkill(events, o.script),
    logPath,
    now: () => new Date(clock.t),
    assigneeAccountId: "acc-1",
    gate: {
      findLandedPrUrl: async () => null,
      execGhPrView: async () => {
        throw new Error("execGhPrView not stubbed");
      },
      execGhFindMergedPr: async () => null,
      mergedCache: new Map(),
    },
    findOpenPrUrl: async () => null,
    recentWindowMs: 120_000,
    log: (m: string) => logs.push(m),
    ...o.deps,
  });
  const deps = base();
  return {
    dir,
    logPath,
    events,
    jira,
    github,
    session,
    clock,
    logs,
    deps,
    restart: (p = {}) => ({ ...base(), session: makeSession(), runSkill: scriptedRunSkill(events), ...p }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
