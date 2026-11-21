// Jira client boundary, shared by both roles. The loop runners depend only
// on this interface, so tests can inject a mock instead of touching real
// Jira.
//
// Appendix A of the pipeline spec (the concrete Jira instance/binding
// values: base URL, auth, status IDs, epic link field, etc.) is currently
// unfilled - pipeline.config.json has every value set to the literal
// string "___". Until that's filled in there is no real Jira to bind to,
// so StubJiraClient throws on every call.

import type { Config } from "./types.ts";
import { TICKET_KEY } from "./paths.ts";

/**
 * Minimal description of a Jira ticket as the loops need it. Kept narrow
 * deliberately -- the loops should not need full Jira field fidelity.
 */
export interface JiraTicket {
  key: string;
  /** Numeric issue id as a string, when the search returned one (used to exclude a ticket whose key fails TICKET_KEY). */
  id?: string;
  status: string;
  /** Jira accountId of the current assignee, or null if unassigned. */
  assignee: string | null;
  /** The ticket's labels (research's autoPromoteLabel gate reads these). */
  labels: string[];
}

export interface JiraClient {
  /**
   * Poll Jira for the oldest ticket matching the given JQL. Returns null
   * if no ticket matches.
   */
  pollOldestMatching(jql: string): Promise<JiraTicket | null>;

  /**
   * Poll Jira for every ticket matching the given JQL (not just the
   * oldest) -- used by the merge-reconciliation pass, which needs to
   * check every ticket currently at Code Review, not claim one at a time
   * the way the main poll loop does.
   */
  pollAllMatching(jql: string): Promise<JiraTicket[]>;

  /**
   * Attempt to atomically claim a ticket by transitioning it from one
   * status to another. Returns false (never throws) if the transition
   * failed because another process raced it and already moved the
   * ticket - the caller should skip this ticket and continue, not treat
   * that as an error.
   *
   * A 400 whose body names required fields ("Field X is required.")
   * throws ClaimMissingFieldsError so the caller can report them by name.
   *
   * Any other failure (a non-2xx Jira response, e.g. a 400 from a
   * transition screen with a required field this call doesn't send, or a
   * network error) throws. Callers must catch that themselves and treat
   * it as a per-ticket skip, never let it escape the poll loop (the
   * research role reports it as poll-loop's "claim-error" kind).
   */
  claimTicket(ticketKey: string, from: string, to: string): Promise<boolean>;

  /**
   * Transition a ticket to a new status (not a claim - used for
   * post-run outcome transitions such as marking a ticket "bounced" or
   * moving it toward "landed"). `fields`, if given, is sent alongside the
   * transition request -- some transitions have a required Jira screen
   * (e.g. Code Review's PII/QA-notes fields) that rejects an empty
   * payload even when the field schema itself reports `required: false`.
   */
  transitionStatus(
    ticketKey: string,
    to: string,
    fields?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Swap a ticket's pipeline-stage label from `from` to `to` in one PUT
   * (Jira's labels field supports a remove/add op pair directly -- no
   * GET-then-merge needed).
   */
  swapLabel(ticketKey: string, from: string, to: string): Promise<void>;

  /**
   * Remove a single label from a ticket. Jira treats removing a label the
   * ticket doesn't have as a no-op, so this is safe to repeat.
   */
  removeLabel(ticketKey: string, label: string): Promise<void>;

  /**
   * Assign a ticket to the given Jira account ID. Callers should only
   * invoke this when the ticket is currently unassigned -- this method
   * itself does not check, it just performs the assignment.
   */
  assignTicket(ticketKey: string, accountId: string): Promise<void>;

  /**
   * Post a comment to a ticket. `bodyAdf` must be a full Atlassian Document
   * Format doc (`{ type: "doc", version: 1, content: [...] }`), not a plain
   * string -- Jira's v3 comment endpoint rejects a bare string body the
   * same way its transition-screen rich-text fields do (see
   * buildQaNotesAdf's doc comment in loop-runner.ts).
   */
  addComment(ticketKey: string, bodyAdf: Record<string, unknown>): Promise<void>;

  /**
   * Close a ticket for good -- used by reset-project's --close-remote, not
   * by the normal pipeline (which never closes a ticket itself; a human
   * does that by hand). This Jira instance has no single "close" status
   * name that's guaranteed to exist across every project's workflow
   * (unlike statusNames.bounced/prOpen, which are per-project config), so
   * this discovers a target by status *category* instead: any status
   * whose statusCategory.key is "done" counts as closed, regardless of
   * its literal name ("Closed", "Done", "Won't Do", ...).
   *
   * "already-done": the ticket's current status is already in the done
   * category -- a safe idempotent no-op, no transition attempted.
   * "no-transition": the ticket isn't done, and no transition to a
   * done-category status is offered from its current status (e.g. a
   * workflow that requires an intermediate status first) -- never
   * silently treated as success.
   * "closed": a transition was found and successfully applied.
   *
   * If more than one done-category transition is offered, the first one
   * (by the API's own ordering) is used -- there is no per-project config
   * to prefer one by name. `transitionName` on a "closed" result always
   * names which one was actually used, so a wrong pick anywhere is
   * visible rather than silent.
   */
  closeTicket(ticketKey: string): Promise<CloseTicketResult>;

  /** The ticket's current Jira status name (`GET issue?fields=status`). */
  getStatus(ticketKey: string): Promise<string>;

  /** The ticket's status name and whether it is in Jira's Done category (`GET issue?fields=status`). The blocker gate reads it. */
  getStatusDetail(ticketKey: string): Promise<{ name: string; done: boolean }>;

  /**
   * Keys of the tickets this one "is blocked by": issue links whose
   * `type.inward` is "is blocked by" and that carry an `inwardIssue`.
   * Outward ("blocks") and other link types are ignored, and any linked key
   * that fails TICKET_KEY is dropped. The blocker gate
   * (src/core/blocker-gate.ts) is the only caller.
   */
  getBlockedBy(ticketKey: string): Promise<string[]>;

  /** Every comment on the ticket, oldest first (paged, 100 at a time). */
  listComments(ticketKey: string): Promise<JiraComment[]>;

  /** Delete one comment. Throws the request error (with `status`) on failure. */
  deleteComment(ticketKey: string, commentId: string): Promise<void>;

  /** The ticket's labels (`GET issue?fields=labels`); `[]` when absent. */
  getLabels(ticketKey: string): Promise<string[]>;
}

/** A Jira comment as reset needs it: identity, time, a one-line preview and a link. */
export interface JiraComment {
  id: string;
  /** ISO timestamp as Jira reports it. */
  created: string;
  /** First ADF block with text, trimmed, max 120 chars. */
  firstLine: string;
  url: string;
}

export type CloseTicketResult =
  | { result: "already-done" }
  | { result: "closed"; transitionName: string }
  | { result: "no-transition" };

/**
 * Stand-in JiraClient used until Appendix A of the pipeline spec is
 * filled in with real Jira binding values (base URL, auth, status IDs,
 * epic link field, etc.). Every method throws a clear, actionable error
 * rather than silently doing nothing or hitting a real API.
 */
export class StubJiraClient implements JiraClient {
  private readonly blockedBy: Record<string, string[]> | undefined;

  /**
   * `opts.blockedBy` makes getBlockedBy answer from that map (unlisted key
   * -> []) instead of throwing, for tests of the blocker gate.
   */
  private readonly statusDetail?: Record<string, { name: string; done: boolean }>;

  constructor(opts: { blockedBy?: Record<string, string[]>; statusDetail?: Record<string, { name: string; done: boolean }> } = {}) {
    this.blockedBy = opts.blockedBy;
    this.statusDetail = opts.statusDetail;
  }

  private static notConfigured(method: string): Error {
    return new Error(
      `StubJiraClient.${method}: Jira instance is not configured. ` +
        `Appendix A of the pipeline spec is unfilled (pipeline.config.json ` +
        `still has placeholder "___" values) - this needs real Jira ` +
        `binding values (base URL, auth, status IDs, epic link field, etc.) ` +
        `before ${method} can do anything real.`,
    );
  }

  async pollOldestMatching(_jql: string): Promise<JiraTicket | null> {
    throw StubJiraClient.notConfigured("pollOldestMatching");
  }

  async pollAllMatching(_jql: string): Promise<JiraTicket[]> {
    throw StubJiraClient.notConfigured("pollAllMatching");
  }

  async claimTicket(
    _ticketKey: string,
    _from: string,
    _to: string,
  ): Promise<boolean> {
    throw StubJiraClient.notConfigured("claimTicket");
  }

  async transitionStatus(
    _ticketKey: string,
    _to: string,
    _fields?: Record<string, unknown>,
  ): Promise<void> {
    throw StubJiraClient.notConfigured("transitionStatus");
  }

  async swapLabel(_ticketKey: string, _from: string, _to: string): Promise<void> {
    throw StubJiraClient.notConfigured("swapLabel");
  }

  async removeLabel(_ticketKey: string, _label: string): Promise<void> {
    throw StubJiraClient.notConfigured("removeLabel");
  }

  async assignTicket(_ticketKey: string, _accountId: string): Promise<void> {
    throw StubJiraClient.notConfigured("assignTicket");
  }

  async addComment(
    _ticketKey: string,
    _bodyAdf: Record<string, unknown>,
  ): Promise<void> {
    throw StubJiraClient.notConfigured("addComment");
  }

  async closeTicket(_ticketKey: string): Promise<CloseTicketResult> {
    throw StubJiraClient.notConfigured("closeTicket");
  }

  async getStatus(_ticketKey: string): Promise<string> {
    throw StubJiraClient.notConfigured("getStatus");
  }

  /** `opts.statusDetail` answers from that map (unlisted key -> "In Progress"); otherwise not configured. */
  async getStatusDetail(ticketKey: string): Promise<{ name: string; done: boolean }> {
    if (!this.statusDetail) throw StubJiraClient.notConfigured("getStatusDetail");
    return { ...(this.statusDetail[ticketKey] ?? { name: "In Progress", done: false }) };
  }

  async getBlockedBy(ticketKey: string): Promise<string[]> {
    if (!this.blockedBy) throw StubJiraClient.notConfigured("getBlockedBy");
    return [...(this.blockedBy[ticketKey] ?? [])];
  }

  async listComments(_ticketKey: string): Promise<JiraComment[]> {
    throw StubJiraClient.notConfigured("listComments");
  }

  async deleteComment(_ticketKey: string, _commentId: string): Promise<void> {
    throw StubJiraClient.notConfigured("deleteComment");
  }

  async getLabels(_ticketKey: string): Promise<string[]> {
    throw StubJiraClient.notConfigured("getLabels");
  }
}

// An emoji node with no attrs.text: the loop's own prefixes' shortNames.
const EMOJI_SHORT_NAMES: Record<string, string> = {
  ":white_check_mark:": "\u2705",
  ":x:": "\u274c",
  ":warning:": "\u26a0\ufe0f",
};

function adfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: unknown; shortName?: unknown } };
  if (n.type === "text") return typeof n.text === "string" ? n.text : "";
  if (n.type === "emoji") {
    if (typeof n.attrs?.text === "string") return n.attrs.text;
    const short = n.attrs?.shortName;
    return typeof short === "string" ? (EMOJI_SHORT_NAMES[short] ?? "") : "";
  }
  return (n.content ?? []).map(adfText).join("");
}

/** Text of the first top-level ADF block whose text is non-empty, trimmed, max 120 chars. */
function adfFirstLine(body: unknown): string {
  const content = (body as { content?: unknown[] } | null)?.content ?? [];
  for (const block of content) {
    const text = adfText(block).trim();
    if (text) return text.slice(0, 120);
  }
  return "";
}

/** Credentials RealJiraClient needs, read from process.env by callers. */
export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

/** Reads JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN from process.env, or throws. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): JiraCredentials {
  const baseUrl = env.JIRA_BASE_URL;
  const email = env.JIRA_EMAIL;
  const apiToken = env.JIRA_API_TOKEN;
  const missing = [
    !baseUrl && "JIRA_BASE_URL",
    !email && "JIRA_EMAIL",
    !apiToken && "JIRA_API_TOKEN",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `RealJiraClient: missing required env var(s): ${missing.join(", ")}. ` +
        `Set them in a gitignored .env (see .env.example) and run via the npm scripts, ` +
        `which load DEVLOOP_ENV_FILE (default .env); set DEVLOOP_ENV_FILE to keep the file outside the repo.`,
    );
  }
  return { baseUrl: baseUrl!, email: email!, apiToken: apiToken! };
}

/**
 * Reads JIRA_ASSIGNEE_ACCOUNT_ID from process.env, or throws. Kept separate
 * from JiraCredentials/credentialsFromEnv since this isn't an API
 * credential -- it's the human's own Jira account ID, used as a call-time
 * argument (assignTicket) and in JQL, not something RealJiraClient holds
 * as constructor state.
 */
export function assigneeAccountIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const accountId = env.JIRA_ASSIGNEE_ACCOUNT_ID;
  if (!accountId) {
    throw new Error(
      "RealJiraClient: missing required env var JIRA_ASSIGNEE_ACCOUNT_ID. " +
        "Set it in a gitignored .env (see .env.example) and run via the npm scripts, " +
        "which load DEVLOOP_ENV_FILE (default .env); set DEVLOOP_ENV_FILE to keep the file outside the repo.",
    );
  }
  return accountId;
}

interface JiraSearchResponse {
  issues: Array<{
    id?: string | number;
    key: string;
    fields: {
      status: { name: string };
      labels?: string[];
      assignee: { accountId: string } | null;
    };
  }>;
}

interface JiraIssueLinksResponse {
  fields?: {
    issuelinks?: Array<{
      type?: { name?: string; inward?: string; outward?: string };
      inwardIssue?: { key?: unknown };
      outwardIssue?: { key?: unknown };
    }>;
  };
}

interface JiraTransitionsResponse {
  transitions: Array<{ id: string; to: { name: string; statusCategory: { key: string } } }>;
}

interface JiraStatusFieldResponse {
  fields: { status: { name: string; statusCategory: { key: string } } };
}

/**
 * A transition's target status name looks like forward progress (worth
 * auto-hopping through on the way to a done-category status) when it
 * matches this and does NOT match BACKWARD_STATUS_RE. Deliberately
 * conservative -- closeTicket only ever hops through a status a human
 * would recognize as "further along," never one that could set the
 * ticket back (Blocked, Rejected, Reopened, ...).
 */
const FORWARD_STATUS_RE =
  /complete|done|closed?|resolved?|ready|release|deploy|verified?|approved?|accepted|delivered|shipped|merged/i;
const BACKWARD_STATUS_RE = /block|reject|reopen|restart/i;

function isForwardProgressStatusName(name: string): boolean {
  return FORWARD_STATUS_RE.test(name) && !BACKWARD_STATUS_RE.test(name);
}

/**
 * Upper bound on intermediate forward-progress hops closeTicket will walk
 * through before giving up. Generic across every project/issue-type
 * workflow -- not configured per project, since the live transitions list
 * at each step is already the ground truth for what that specific ticket
 * (whatever issue type, whatever workflow) can do next. A Task with a
 * short workflow reaches "done" in 0-1 hops and never gets near this
 * bound; a Story gated behind Code Review/Development Complete/Deployed
 * steps (observed live on TARS-1467) needs more. Bounded (not unlimited)
 * so an unexpectedly long or cyclic chain of unambiguous-looking
 * transitions can't walk a live ticket somewhere unbounded.
 */
const MAX_INTERMEDIATE_HOPS = 4;

/**
 * REST-backed JiraClient for Jira Cloud, authenticated via HTTP Basic auth
 * (email + API token) per Atlassian's documented auth scheme for the v3
 * REST API.
 */
export class RealJiraClient implements JiraClient {
  private readonly credentials: JiraCredentials;
  private readonly config: Config;

  // Explicit fields, not TS parameter-property shorthand -- Node's
  // type-stripping mode (used to run src/*.ts directly without a build
  // step) does not support parameter properties.
  constructor(credentials: JiraCredentials, config: Config) {
    this.credentials = credentials;
    this.config = config;
  }

  private authHeader(): string {
    const { email, apiToken } = this.credentials;
    return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.credentials.baseUrl}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw Object.assign(
        new Error(`Jira request failed: ${init.method ?? "GET"} ${path} -> ${response.status} ${response.statusText}. ${body}`),
        { status: response.status, body },
      );
    }
    return response;
  }

  async pollOldestMatching(jql: string): Promise<JiraTicket | null> {
    const response = await this.request("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults: 1,
        fields: ["status", "labels", "assignee"],
      }),
    });
    const data = (await response.json()) as JiraSearchResponse;
    const issue = data.issues[0];
    if (!issue) return null;

    return {
      key: issue.key,
      ...(issue.id !== undefined ? { id: String(issue.id) } : {}),
      status: issue.fields.status.name,
      labels: issue.fields.labels ?? [],
      assignee: issue.fields.assignee?.accountId ?? null,
    };
  }

  async pollAllMatching(jql: string): Promise<JiraTicket[]> {
    const response = await this.request("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        fields: ["status", "labels", "assignee"],
      }),
    });
    const data = (await response.json()) as JiraSearchResponse;
    return data.issues.map((issue) => ({
      key: issue.key,
      ...(issue.id !== undefined ? { id: String(issue.id) } : {}),
      status: issue.fields.status.name,
      labels: issue.fields.labels ?? [],
      assignee: issue.fields.assignee?.accountId ?? null,
    }));
  }

  async claimTicket(ticketKey: string, from: string, to: string): Promise<boolean> {
    const response = await this.request(`/rest/api/3/issue/${ticketKey}/transitions`);
    const data = (await response.json()) as JiraTransitionsResponse;
    const transition = data.transitions.find((t) => t.to.name === to);
    if (!transition) {
      // Ticket is no longer at `from` (or `to` isn't reachable) -- another
      // process already claimed it. Skip, do not throw.
      return false;
    }
    try {
      await this.request(`/rest/api/3/issue/${ticketKey}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: transition.id } }),
      });
    } catch (err) {
      const e = err as { status?: number; body?: string };
      if (e.status === 400) {
        const fields = parseRequiredFields(e.body ?? "");
        if (fields.length > 0) throw new ClaimMissingFieldsError(fields);
      }
      throw err;
    }
    return true;
  }

  async transitionStatus(
    ticketKey: string,
    to: string,
    fields?: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.request(`/rest/api/3/issue/${ticketKey}/transitions`);
    const data = (await response.json()) as JiraTransitionsResponse;
    const transition = data.transitions.find((t) => t.to.name === to);
    if (!transition) {
      throw new Error(
        `RealJiraClient.transitionStatus: no transition to status "${to}" is ` +
          `available for ${ticketKey} from its current status.`,
      );
    }
    await this.request(`/rest/api/3/issue/${ticketKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({
        transition: { id: transition.id },
        ...(fields ? { fields } : {}),
      }),
    });
  }

  async swapLabel(ticketKey: string, from: string, to: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({
        update: { labels: [{ remove: from }, { add: to }] },
      }),
    });
  }

  async removeLabel(ticketKey: string, label: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({ update: { labels: [{ remove: label }] } }),
    });
  }

  async assignTicket(ticketKey: string, accountId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({ fields: { assignee: { accountId } } }),
    });
  }

  async addComment(
    ticketKey: string,
    bodyAdf: Record<string, unknown>,
  ): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: bodyAdf }),
    });
  }

  /** The ticket's current Jira status name. */
  async getStatus(ticketKey: string): Promise<string> {
    const response = await this.request(`/rest/api/3/issue/${ticketKey}?fields=status`);
    const data = (await response.json()) as JiraStatusFieldResponse;
    return data.fields.status.name;
  }

  /** The ticket's status name and whether its statusCategory is "done". */
  async getStatusDetail(ticketKey: string): Promise<{ name: string; done: boolean }> {
    if (!TICKET_KEY.test(ticketKey)) {
      throw new Error(`RealJiraClient.getStatusDetail: invalid ticket key ${JSON.stringify(ticketKey)}`);
    }
    const response = await this.request(`/rest/api/3/issue/${ticketKey}?fields=status`);
    const data = (await response.json()) as JiraStatusFieldResponse;
    return { name: data.fields.status.name, done: data.fields.status.statusCategory.key === "done" };
  }

  /**
   * Close a ticket, walking through up to MAX_INTERMEDIATE_HOPS
   * intermediate forward-progress statuses first when no done-category
   * transition is directly available (e.g. Code Review -> Development
   * Complete -> Deployed to INT -> ... -> Closed). At each step, hops
   * only when exactly one offered transition's target name looks like
   * forward progress (isForwardProgressStatusName) -- an ambiguous choice
   * (more than one candidate) or none at all stops the walk immediately
   * and reports "no-transition" rather than guessing. Generic across
   * every project/issue-type workflow: a Task's short workflow reaches
   * done in 0-1 hops, a Story gated behind several review/deploy statuses
   * (observed live on TARS-1467) needs more -- both are just "keep
   * checking the live transitions list until a done-category one
   * appears, or the unambiguous trail runs out."
   */
  async closeTicket(ticketKey: string): Promise<CloseTicketResult> {
    const statusResponse = await this.request(
      `/rest/api/3/issue/${ticketKey}?fields=status`,
    );
    const statusData = (await statusResponse.json()) as JiraStatusFieldResponse;
    if (statusData.fields.status.statusCategory.key === "done") {
      return { result: "already-done" };
    }

    const hopNames: string[] = [];
    for (let hopCount = 0; hopCount <= MAX_INTERMEDIATE_HOPS; hopCount++) {
      const transitionsData = await this.fetchTransitions(ticketKey);
      const doneTransition = transitionsData.transitions.find(
        (t) => t.to.statusCategory.key === "done",
      );
      if (doneTransition) {
        await this.postTransition(ticketKey, doneTransition.id);
        hopNames.push(doneTransition.to.name);
        return { result: "closed", transitionName: hopNames.join(" -> ") };
      }

      if (hopCount === MAX_INTERMEDIATE_HOPS) {
        return { result: "no-transition" };
      }

      const forwardCandidates = transitionsData.transitions.filter((t) =>
        isForwardProgressStatusName(t.to.name),
      );
      if (forwardCandidates.length !== 1) {
        return { result: "no-transition" };
      }
      const hop = forwardCandidates[0]!;
      await this.postTransition(ticketKey, hop.id);
      hopNames.push(hop.to.name);
    }
    return { result: "no-transition" };
  }

  async getBlockedBy(ticketKey: string): Promise<string[]> {
    if (!TICKET_KEY.test(ticketKey)) {
      throw new Error(`RealJiraClient.getBlockedBy: invalid ticket key ${JSON.stringify(ticketKey)}`);
    }
    const response = await this.request(`/rest/api/3/issue/${ticketKey}?fields=issuelinks`);
    const data = (await response.json()) as JiraIssueLinksResponse;
    const keys: string[] = [];
    for (const link of data.fields?.issuelinks ?? []) {
      if (link.type?.inward !== "is blocked by" || !link.inwardIssue) continue;
      const key = link.inwardIssue.key;
      if (typeof key === "string" && TICKET_KEY.test(key)) keys.push(key);
    }
    return keys;
  }

  async listComments(ticketKey: string): Promise<JiraComment[]> {
    if (!TICKET_KEY.test(ticketKey)) {
      throw new Error(`RealJiraClient.listComments: invalid ticket key ${JSON.stringify(ticketKey)}`);
    }
    const out: JiraComment[] = [];
    let startAt = 0;
    for (;;) {
      const response = await this.request(
        `/rest/api/3/issue/${ticketKey}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
      );
      const data = (await response.json()) as {
        total?: number;
        comments?: Array<{ id: string; created: string; body?: unknown }>;
      };
      const comments = data.comments ?? [];
      for (const c of comments) {
        out.push({
          id: String(c.id),
          created: c.created,
          firstLine: adfFirstLine(c.body),
          url: `${this.credentials.baseUrl}/browse/${ticketKey}?focusedCommentId=${c.id}`,
        });
      }
      startAt += comments.length;
      if (comments.length === 0 || startAt >= (data.total ?? 0)) break;
    }
    return out;
  }

  async deleteComment(ticketKey: string, commentId: string): Promise<void> {
    if (!TICKET_KEY.test(ticketKey)) {
      throw new Error(`RealJiraClient.deleteComment: invalid ticket key ${JSON.stringify(ticketKey)}`);
    }
    if (!/^\d+$/.test(commentId)) {
      throw new Error(`RealJiraClient.deleteComment: invalid comment id ${JSON.stringify(commentId)}`);
    }
    await this.request(`/rest/api/3/issue/${ticketKey}/comment/${commentId}`, { method: "DELETE" });
  }

  async getLabels(ticketKey: string): Promise<string[]> {
    if (!TICKET_KEY.test(ticketKey)) {
      throw new Error(`RealJiraClient.getLabels: invalid ticket key ${JSON.stringify(ticketKey)}`);
    }
    const response = await this.request(`/rest/api/3/issue/${ticketKey}?fields=labels`);
    const data = (await response.json()) as { fields?: { labels?: string[] } };
    return data.fields?.labels ?? [];
  }

  private async fetchTransitions(ticketKey: string): Promise<JiraTransitionsResponse> {
    const response = await this.request(`/rest/api/3/issue/${ticketKey}/transitions`);
    return (await response.json()) as JiraTransitionsResponse;
  }

  private async postTransition(ticketKey: string, transitionId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  }
}

/** The claim transition was rejected because required field(s) are missing. */
export class ClaimMissingFieldsError extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(`Jira requires field(s) to claim: ${fields.join(", ")}`);
    this.name = "ClaimMissingFieldsError";
    this.fields = fields;
  }
}

/** Field names a Jira 400 body says are required, deduped, in order; [] if none/non-JSON. */
export function parseRequiredFields(body: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) return [];
  const { errorMessages, errors } = data as { errorMessages?: unknown; errors?: unknown };
  const out: string[] = [];
  const add = (n: string) => {
    if (!out.includes(n)) out.push(n);
  };
  if (Array.isArray(errorMessages)) {
    for (const m of errorMessages) {
      const hit = typeof m === "string" ? /^Field (.+?) is required\.?$/.exec(m) : null;
      if (hit) add(hit[1]);
    }
  }
  if (typeof errors === "object" && errors !== null) {
    for (const [key, m] of Object.entries(errors)) {
      if (typeof m !== "string") continue;
      const hit = /^(.+?) is required\.?$/i.exec(m);
      if (hit && hit[1].trim().toLowerCase() !== "field") add(hit[1]);
      else if (hit || /^required\.?$/i.test(m.trim())) add(key);
    }
  }
  return out;
}
