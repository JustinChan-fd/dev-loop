/**
 * The blocker gate (spec §6.3.2): a ticket with Jira "is blocked by" links
 * is only worked once every blocker is cleared. This file is the single
 * rule -- change isBlockerCleared to change it.
 *
 * A blocker is cleared iff its work merged into the default branch of this
 * project's own `github.repo`:
 *   - the PR recorded for it in the landed logs (findLandedPrUrl) is a PR
 *     URL in this repo (`https://github.com/<repo>/pull/<n>`, owner/name
 *     case-insensitive) and gh reports it merged (`mergedAt`) into
 *     `defaultBranch` (`baseRefName`). A recorded URL for any other repo,
 *     or anything that isn't a PR URL, is ignored (never passed to gh), or
 *   - a gh search finds a merged PR into `defaultBranch` whose head branch
 *     or title carries the blocker key as a whole token (so a recorded PR
 *     closed unmerged, with the real one merged, still counts).
 * Everything else is not cleared, including every thrown error (fail
 * closed). A blocker from a different Jira project is not looked up at all:
 * it can't have a PR in this repo, so it gets the "needs a human" reason
 * straight away. A human clears such a blocker by removing the link; the
 * ticket is picked up on the next poll.
 *
 * A project may also list Jira status names (`jira.blockerClearedStatuses`)
 * that clear a blocker from any repo or project, e.g. "Deployed to INT" for
 * a backend ticket in another repo. When the PR rule above does not clear a
 * blocker and the list is set, the blocker's live status is read: a listed
 * name (exact match) or Jira's Done category clears it. A status clear is not
 * cached (a status can move back), and a failed status read stays blocked.
 * No list: the status is never read.
 */

import type { JiraClient } from "./jira-client.ts";
import { escapeRegExp, type ExecGhFindMergedPrFn, type ExecGhPrViewFn } from "./github-client.ts";
import { redactSensitive } from "./redact.ts";
import { TICKET_KEY } from "./paths.ts";

/** Cap on the gh/Jira error text kept in a reason (reasons end up in logs). */
const MAX_ERROR_CHARS = 200;

export interface BlockerGateDeps {
  /** The project's own `github.repo` (owner/name); only used in reasons, lookups are bound to it by the caller. */
  repo: string;
  /** Latest landed dev PR URL for a ticket key, or null (findLandedPrUrlAcross with the slug bound). */
  findLandedPrUrl: (key: string) => Promise<string | null>;
  execGhPrView: ExecGhPrViewFn;
  execGhFindMergedPr: ExecGhFindMergedPrFn;
  defaultBranch: string;
  /** `${repo}#${blockerKey}` -> merged PR URL. Process-lifetime, caller-owned. Only cleared results go in (merged never reverts). */
  mergedCache: Map<string, string>;
  /**
   * The gated ticket's Jira project key (the part before "-"). A blocker
   * from any other project is not cleared without calling gh. Required, so
   * no caller can skip that short-circuit; gateTicket derives it from the
   * ticket key.
   */
  projectKey: string;
  /** jira.blockerClearedStatuses: exact status names that clear a blocker. Absent or empty: the status is never read. */
  clearedStatuses?: string[];
  /** The blocker's live status: its name and whether it is in Jira's Done category. */
  getBlockerStatus?: (key: string) => Promise<{ name: string; done: boolean }>;
}

export interface BlockerCheck {
  cleared: boolean;
  reason: string;
}

export type GateResult = { pass: true } | { pass: false; blockedBy: string[]; reasons: string[] };

function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactSensitive(message).slice(0, MAX_ERROR_CHARS);
}

/** True iff `url` is exactly a PR URL in `repo` (owner/name case-insensitive). */
function isOwnRepoPrUrl(url: string, repo: string): boolean {
  return new RegExp(`^https://github\\.com/${escapeRegExp(repo)}/pull/\\d+$`, "i").test(url);
}

/** A key that failed TICKET_KEY, made safe to print: JSON-quoted (no raw newlines) and capped. */
function safeKey(key: string): string {
  return JSON.stringify(String(key).slice(0, 40));
}

const needsHuman = (key: string, repo: string): string =>
  `blocker ${key} has no merged PR in ${repo} — needs a human (Done without a PR, or another repo)`;

export async function isBlockerCleared(blockerKey: string, deps: BlockerGateDeps): Promise<BlockerCheck> {
  const byPr = await isClearedByPr(blockerKey, deps);
  const list = deps.clearedStatuses ?? [];
  if (byPr.cleared || list.length === 0 || !deps.getBlockerStatus || !TICKET_KEY.test(String(blockerKey))) return byPr;
  try {
    const { name, done } = await deps.getBlockerStatus(blockerKey);
    if (list.includes(name)) return { cleared: true, reason: `blocker ${blockerKey} is ${name} (in jira.blockerClearedStatuses)` };
    if (done) return { cleared: true, reason: `blocker ${blockerKey} is ${name} (Done)` };
    return { cleared: false, reason: `${byPr.reason}; its status ${String(name).slice(0, 60)} is not in jira.blockerClearedStatuses` };
  } catch (err) {
    return { cleared: false, reason: `${byPr.reason}; its status check failed: ${errorText(err)}` };
  }
}

async function isClearedByPr(blockerKey: string, deps: BlockerGateDeps): Promise<BlockerCheck> {
  if (typeof blockerKey !== "string" || !TICKET_KEY.test(blockerKey)) {
    return { cleared: false, reason: `blocker ${safeKey(blockerKey)} check failed: invalid key` };
  }

  const cacheKey = `${deps.repo}#${blockerKey}`;
  const cached = deps.mergedCache.get(cacheKey);
  if (cached) return { cleared: true, reason: `blocker ${blockerKey} merged: ${cached}` };

  if (projectOf(blockerKey) !== deps.projectKey) {
    return { cleared: false, reason: needsHuman(blockerKey, deps.repo) };
  }

  const cleared = (url: string): BlockerCheck => {
    deps.mergedCache.set(cacheKey, url);
    return { cleared: true, reason: `blocker ${blockerKey} merged: ${url}` };
  };

  try {
    let openPr: string | null = null;
    const recorded = await deps.findLandedPrUrl(blockerKey);
    if (recorded && isOwnRepoPrUrl(recorded, deps.repo)) {
      const status = JSON.parse(await deps.execGhPrView(recorded)) as {
        state?: string;
        mergedAt?: string | null;
        baseRefName?: string;
      };
      if (status.mergedAt && status.baseRefName === deps.defaultBranch) return cleared(recorded);
      if (status.state === "OPEN") openPr = recorded;
    }

    const found = await deps.execGhFindMergedPr(blockerKey, { baseRefName: deps.defaultBranch });
    // Re-check the base here too, so the rule holds whatever finder is injected.
    if (found && found.mergedAt && found.baseRefName === deps.defaultBranch) return cleared(found.url);

    if (openPr) return { cleared: false, reason: `blocker ${blockerKey} PR open: ${openPr}` };
    return { cleared: false, reason: needsHuman(blockerKey, deps.repo) };
  } catch (err) {
    return { cleared: false, reason: `blocker ${blockerKey} check failed: ${errorText(err)}` };
  }
}

/**
 * Pass only when every "is blocked by" link is cleared. A failure reading
 * the links themselves fails closed too (pass: false, no blockedBy).
 */
export async function gateTicket(
  ticketKey: string,
  deps: Omit<BlockerGateDeps, "projectKey"> & { jira: JiraClient },
): Promise<GateResult> {
  let blockers: string[];
  try {
    blockers = await deps.jira.getBlockedBy(ticketKey);
  } catch (err) {
    return { pass: false, blockedBy: [], reasons: [`blockers of ${ticketKey} check failed: ${errorText(err)}`] };
  }

  const checkDeps: BlockerGateDeps = {
    ...deps,
    projectKey: projectOf(ticketKey),
    getBlockerStatus: deps.getBlockerStatus ?? ((key) => deps.jira.getStatusDetail(key)),
  };
  const blockedBy: string[] = [];
  const reasons: string[] = [];
  for (const key of blockers) {
    const r = await isBlockerCleared(key, checkDeps);
    if (!r.cleared) {
      blockedBy.push(key);
      reasons.push(r.reason);
    }
  }
  return blockedBy.length === 0 ? { pass: true } : { pass: false, blockedBy, reasons };
}
