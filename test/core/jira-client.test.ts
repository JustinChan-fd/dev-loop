import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RealJiraClient,
  ClaimMissingFieldsError,
  parseRequiredFields,
  StubJiraClient,
  credentialsFromEnv,
  assigneeAccountIdFromEnv,
  type JiraCredentials,
} from "../../src/core/jira-client.ts";
import type { Config } from "../../src/core/types.ts";
import { makeV2Config } from "../fixtures/config.ts";
import { readFileSync } from "node:fs";

const ISSUELINKS_FIXTURE = readFileSync(
  new URL("../fixtures/jira-issuelinks.json", import.meta.url),
  "utf8",
);

function makeConfig(): Config {
  return makeV2Config((c) => {
    c.github.repo = "fandango/webtarsthree";
  });
}

const CREDENTIALS: JiraCredentials = {
  baseUrl: "https://example.atlassian.net",
  email: "bot@example.com",
  apiToken: "fake-token",
};

describe("credentialsFromEnv", () => {
  it("reads all three vars when present", () => {
    const creds = credentialsFromEnv({
      JIRA_BASE_URL: "https://x.atlassian.net",
      JIRA_EMAIL: "a@b.com",
      JIRA_API_TOKEN: "tok",
    } as NodeJS.ProcessEnv);
    expect(creds).toEqual({
      baseUrl: "https://x.atlassian.net",
      email: "a@b.com",
      apiToken: "tok",
    });
  });

  it("throws naming every missing var", () => {
    expect(() => credentialsFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /JIRA_BASE_URL.*JIRA_EMAIL.*JIRA_API_TOKEN/s,
    );
  });

  it("names DEVLOOP_ENV_FILE as the way to keep the env file outside the repo", () => {
    expect(() => credentialsFromEnv({} as NodeJS.ProcessEnv)).toThrow(/DEVLOOP_ENV_FILE/);
  });
});

describe("assigneeAccountIdFromEnv", () => {
  it("returns the value when present", () => {
    const accountId = assigneeAccountIdFromEnv({
      JIRA_ASSIGNEE_ACCOUNT_ID: "user-123",
    } as NodeJS.ProcessEnv);
    expect(accountId).toBe("user-123");
  });

  it("throws when missing", () => {
    expect(() => assigneeAccountIdFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /JIRA_ASSIGNEE_ACCOUNT_ID/,
    );
  });

  it("names DEVLOOP_ENV_FILE as the way to keep the env file outside the repo", () => {
    expect(() => assigneeAccountIdFromEnv({} as NodeJS.ProcessEnv)).toThrow(/DEVLOOP_ENV_FILE/);
  });
});

describe("RealJiraClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pollOldestMatching sends Basic auth and parses the first issue", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issues: [
            {
              id: "10042",
              key: "PROJ-1",
              fields: {
                status: { name: "Backlog" },
                labels: ["auto-promote"],
                assignee: { accountId: "user-123" },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const ticket = await client.pollOldestMatching("labels = pipeline:dev");

    expect(ticket).toEqual({
      key: "PROJ-1",
      id: "10042",
      status: "Backlog",
      assignee: "user-123",
      labels: ["auto-promote"],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/search/jql");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("bot@example.com:fake-token").toString("base64")}`,
    );
    expect(JSON.parse(init.body as string).fields).toEqual(["status", "labels", "assignee"]);
  });

  it("pollOldestMatching returns the issue id as a string (numeric ids too); absent id -> undefined", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [{ id: 777, key: "PROJ-1", fields: { status: { name: "x" }, assignee: null } }] }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [{ key: "PROJ-1", fields: { status: { name: "x" }, assignee: null } }] }), { status: 200 }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    expect((await client.pollOldestMatching("x"))?.id).toBe("777");
    expect((await client.pollOldestMatching("x"))?.id).toBeUndefined();
  });

  it("pollOldestMatching maps a missing labels field to an empty array", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issues: [{ key: "PROJ-3", fields: { status: { name: "Backlog" }, assignee: null } }],
        }),
        { status: 200 },
      ),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const ticket = await client.pollOldestMatching("labels = pipeline:research");

    expect(ticket?.labels).toEqual([]);
  });

  it("pollOldestMatching maps a null assignee to null (unassigned ticket)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issues: [
            {
              key: "PROJ-2",
              fields: {
                status: { name: "Backlog" },
                assignee: null,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const ticket = await client.pollOldestMatching("epic in (EPIC-1)");

    expect(ticket?.assignee).toBeNull();
  });

  it("pollOldestMatching returns null when no issues match", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [] }), { status: 200 }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const ticket = await client.pollOldestMatching("epic in (EPIC-1)");
    expect(ticket).toBeNull();
  });

  it("claimTicket returns false (never throws) when the target transition is unavailable -- a race", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ transitions: [{ id: "1", to: { name: "Done" } }] }),
        { status: 200 },
      ),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    let claimed: boolean | undefined;
    await expect(
      (async () => {
        claimed = await client.claimTicket("PROJ-1", "Backlog", "In Progress");
      })(),
    ).resolves.not.toThrow();

    expect(claimed).toBe(false);
    // Only the GET to list transitions should have happened -- no POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("claimTicket throws (not false) when Jira rejects the transition POST -- callers must treat this as a per-ticket skip, not a race", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ transitions: [{ id: "42", to: { name: "In Progress" } }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response('{"errors":{"customfield_1":"required"}}', {
          status: 400,
          statusText: "Bad Request",
        }),
      );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const err = await client.claimTicket("PROJ-1", "Backlog", "In Progress").catch((e) => e);
    expect(err).toBeInstanceOf(ClaimMissingFieldsError);
    expect((err as ClaimMissingFieldsError).fields).toEqual(["customfield_1"]);
    expect((err as Error).message).toBe("Jira requires field(s) to claim: customfield_1");
  });

  it("claimTicket 400 with an unparseable body, and a 500, still throw a plain Error", async () => {
    for (const [status, text, re] of [
      [400, "nope", /400 Bad Request/],
      [500, '{"errorMessages":["Field Story Points is required."]}', /500/],
    ] as const) {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ transitions: [{ id: "42", to: { name: "In Progress" } }] }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(text, { status, statusText: status === 400 ? "Bad Request" : "Server Error" }));
      const client = new RealJiraClient(CREDENTIALS, makeConfig());
      const err = await client.claimTicket("PROJ-1", "Backlog", "In Progress").catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ClaimMissingFieldsError);
      expect((err as Error).message).toMatch(re);
    }
  });

  it("claimTicket 400 with errorMessages 'Field X is required.' throws ClaimMissingFieldsError", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transitions: [{ id: "42", to: { name: "In Progress" } }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response('{"errorMessages":["Field Story Points is required."],"errors":{}}', {
          status: 400,
          statusText: "Bad Request",
        }),
      );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const err = await client.claimTicket("PROJ-1", "Backlog", "In Progress").catch((e) => e);
    expect(err).toBeInstanceOf(ClaimMissingFieldsError);
    expect((err as ClaimMissingFieldsError).fields).toEqual(["Story Points"]);
    expect((err as Error).name).toBe("ClaimMissingFieldsError");
  });

  it("claimTicket posts the matching transition and returns true on success", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [{ id: "42", to: { name: "In Progress" } }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const claimed = await client.claimTicket("PROJ-1", "Backlog", "In Progress");

    expect(claimed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, postInit] = fetchMock.mock.calls[1];
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "42" },
    });
  });

  it("transitionStatus posts the given fields alongside the transition, when provided", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [{ id: "21", to: { name: "Code Review" } }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await client.transitionStatus("PROJ-1", "Code Review", {
      customfield_13504: [{ id: "14310" }],
      customfield_14226: "PR: https://github.com/org/repo/pull/1",
    });

    const [, postInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "21" },
      fields: {
        customfield_13504: [{ id: "14310" }],
        customfield_14226: "PR: https://github.com/org/repo/pull/1",
      },
    });
  });

  it("transitionStatus omits the fields key entirely when no fields are given", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ transitions: [{ id: "31", to: { name: "Blocked" } }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await client.transitionStatus("PROJ-1", "Blocked");

    const [, postInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "31" },
    });
  });

  it("getStatus GETs the status field and returns the status name", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ fields: { status: { name: "Blocked", statusCategory: { key: "indeterminate" } } } }), { status: 200 }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    await expect(client.getStatus("PROJ-1")).resolves.toBe("Blocked");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-1?fields=status");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("getStatusDetail returns the status name and whether its category is done", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ fields: { status: { name: "Closed", statusCategory: { key: "done" } } } }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ fields: { status: { name: "Deployed to INT", statusCategory: { key: "indeterminate" } } } }), { status: 200 }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    await expect(client.getStatusDetail("MC-1")).resolves.toEqual({ name: "Closed", done: true });
    await expect(client.getStatusDetail("MC-2")).resolves.toEqual({ name: "Deployed to INT", done: false });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://example.atlassian.net/rest/api/3/issue/MC-1?fields=status");
  });

  it("getStatusDetail refuses an invalid key without a request", async () => {
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await expect(client.getStatusDetail("../x")).rejects.toThrow(/invalid ticket key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getStatus rejects on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await expect(client.getStatus("PROJ-1")).rejects.toThrow();
  });

  it("StubJiraClient.getStatus throws not-configured", async () => {
    await expect(new StubJiraClient({ blockedBy: {} }).getStatus("PROJ-1")).rejects.toThrow(/getStatus/);
  });

  it("swapLabel PUTs the labels field with a remove/add op pair", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    await client.swapLabel("PROJ-1", "pipeline:research", "pipeline:dev");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      update: {
        labels: [{ remove: "pipeline:research" }, { add: "pipeline:dev" }],
      },
    });
  });

  it("removeLabel PUTs the labels field with a single remove op", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    await client.removeLabel("PROJ-1", "pipeline:dev");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      update: { labels: [{ remove: "pipeline:dev" }] },
    });
  });

  it("assignTicket PUTs the assignee field with the given accountId", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    await client.assignTicket("PROJ-1", "user-123");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      fields: { assignee: { accountId: "user-123" } },
    });
  });

  it("throws a descriptive error when a request fails with a non-OK status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await expect(client.pollOldestMatching("epic in (EPIC-1)")).rejects.toThrow(
      /401/,
    );
  });

  it("addComment POSTs the given ADF body to the issue's comment endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const bodyAdf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Bounced." }] }],
    };
    await client.addComment("PROJ-1", bodyAdf);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://example.atlassian.net/rest/api/3/issue/PROJ-1/comment",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ body: bodyAdf });
  });

  it("closeTicket returns 'already-done' without calling transitions when the ticket's current status is already in the done category", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fields: { status: { name: "Closed", statusCategory: { key: "done" } } },
        }),
        { status: 200 },
      ),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "already-done" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://example.atlassian.net/rest/api/3/issue/PROJ-1?fields=status",
    );
  });

  it("closeTicket transitions to the first done-category transition and reports its name", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "41", to: { name: "Blocked", statusCategory: { key: "new" } } },
              { id: "201", to: { name: "Close", statusCategory: { key: "done" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "closed", transitionName: "Close" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, postInit] = fetchMock.mock.calls[2];
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "201" },
    });
  });

  it("closeTicket picks the FIRST done-category transition when multiple are offered", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "10", to: { name: "Won't Do", statusCategory: { key: "done" } } },
              { id: "20", to: { name: "Done", statusCategory: { key: "done" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "closed", transitionName: "Won't Do" });
    const [, postInit] = fetchMock.mock.calls[2];
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "10" },
    });
  });

  it("closeTicket returns 'no-transition' when the ticket isn't done and no done-category transition is offered, and no single forward-progress hop is available either", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "41", to: { name: "Blocked", statusCategory: { key: "new" } } },
            ],
          }),
          { status: 200 },
        ),
      );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "no-transition" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closeTicket hops through a single unambiguous forward-progress transition when no done-category transition is offered directly", async () => {
    fetchMock
      // 1. current status: Code Review, not done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      // 2. transitions from Code Review: no done-category, but exactly one
      //    forward-progress-looking hop ("Review Complete" -> "Development Complete")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "41", to: { name: "Blocked", statusCategory: { key: "new" } } },
              { id: "271", to: { name: "Review Complete", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      // 3. POST the hop transition
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // 4. transitions from the new status (Development Complete): one done-category
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "300", to: { name: "Closed", statusCategory: { key: "done" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      // 5. POST the done transition
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({
      result: "closed",
      transitionName: "Review Complete -> Closed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const [, hopInit] = fetchMock.mock.calls[2];
    expect(JSON.parse(hopInit.body as string)).toEqual({ transition: { id: "271" } });
    const [, doneInit] = fetchMock.mock.calls[4];
    expect(JSON.parse(doneInit.body as string)).toEqual({ transition: { id: "300" } });
  });

  it("closeTicket refuses to hop when more than one forward-progress-looking transition is offered (never guesses)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "271", to: { name: "Review Complete", statusCategory: { key: "indeterminate" } } },
              { id: "272", to: { name: "Ready for Release", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "no-transition" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closeTicket does not hop through a transition that looks like a step backward (Blocked/Rejected/Reopened)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "41", to: { name: "Blocked", statusCategory: { key: "new" } } },
              { id: "131", to: { name: "Rejected", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "no-transition" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closeTicket walks multiple unambiguous intermediate hops before reaching a done-category transition", async () => {
    fetchMock
      // status: Code Review, not done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      // hop 1: Code Review -> Development Complete (unambiguous)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "271", to: { name: "Development Complete", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // hop 2: Development Complete -> Deployed to INT (unambiguous)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "51", to: { name: "Deployed to INT", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // from Deployed to INT: a done-category transition is finally offered
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "300", to: { name: "Closed", statusCategory: { key: "done" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({
      result: "closed",
      transitionName: "Development Complete -> Deployed to INT -> Closed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("closeTicket stops and reports 'no-transition' once MAX_INTERMEDIATE_HOPS unambiguous hops are exhausted without reaching a done-category status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
        }),
        { status: 200 },
      ),
    );
    // 5 unambiguous forward-progress-looking hops in a row, each still not
    // done-category -- exceeds the bound (4 intermediate hops: hopCount
    // 0..3 each hop once, then hopCount 4 sees a 5th non-done status and
    // gives up without a 5th hop), so the walk must stop and report
    // no-transition rather than hop indefinitely.
    const hopNames = [
      "Ready for Review",
      "Ready for QA",
      "Ready for Deploy",
      "Deployed to Staging",
      "Deployed to Prod",
    ];
    for (let i = 0; i < hopNames.length; i++) {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: `hop-${i}`, to: { name: hopNames[i], statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      );
      if (i < hopNames.length - 1) {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      }
    }
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "no-transition" });
    // 1 status GET + 5 fetchTransitions (hopCount 0..4) + 4 postTransition (hopCount 0..3)
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});

describe("RealJiraClient.pollAllMatching", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns every matching ticket, not just the oldest", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                status: { name: "Code Review" },
                labels: ["pipeline:dev"],
                assignee: { accountId: "user-123" },
              },
            },
            {
              key: "PROJ-2",
              fields: {
                status: { name: "Code Review" },
                assignee: null,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const tickets = await client.pollAllMatching('labels = "pipeline:dev"');

    expect(tickets).toEqual([
      { key: "PROJ-1", status: "Code Review", assignee: "user-123", labels: ["pipeline:dev"] },
      { key: "PROJ-2", status: "Code Review", assignee: null, labels: [] },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/search/jql");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      jql: 'labels = "pipeline:dev"',
      fields: ["status", "labels", "assignee"],
    });
  });

  it("returns an empty array when nothing matches", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [] }), { status: 200 }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const tickets = await client.pollAllMatching('labels = "pipeline:dev"');

    expect(tickets).toEqual([]);
  });
});

describe("RealJiraClient.getBlockedBy", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a recorded issuelinks fixture: keeps only inward 'is blocked by' links", async () => {
    fetchMock.mockResolvedValueOnce(new Response(ISSUELINKS_FIXTURE, { status: 200 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const keys = await client.getBlockedBy("TARS-5");

    expect(keys).toEqual(["TARS-1"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/issue/TARS-5?fields=issuelinks");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("drops a linked key that fails the ticket-key regex", async () => {
    const body = {
      fields: {
        issuelinks: [
          { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "TARS-2" } },
          { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "../evil" } },
          { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: {} },
        ],
      },
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    expect(await client.getBlockedBy("TARS-5")).toEqual(["TARS-2"]);
  });

  it("returns [] when the issue has no issuelinks field", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fields: {} }), { status: 200 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    expect(await client.getBlockedBy("TARS-5")).toEqual([]);
  });

  it("rejects an invalid ticket key before building any URL", async () => {
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    await expect(client.getBlockedBy("TARS-5/../x")).rejects.toThrow(/invalid ticket key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("StubJiraClient.getBlockedBy", () => {
  it("returns the configured blockers, [] for an unlisted key", async () => {
    const client = new StubJiraClient({ blockedBy: { "TARS-5": ["TARS-1", "TARS-2"] } });

    expect(await client.getBlockedBy("TARS-5")).toEqual(["TARS-1", "TARS-2"]);
    expect(await client.getBlockedBy("TARS-6")).toEqual([]);
  });
});

describe("StubJiraClient", () => {
  it("throws a not-configured error on every method", async () => {
    const client = new StubJiraClient();
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["pollOldestMatching", () => client.pollOldestMatching("x")],
      ["pollAllMatching", () => client.pollAllMatching("x")],
      ["claimTicket", () => client.claimTicket("PROJ-1", "A", "B")],
      ["transitionStatus", () => client.transitionStatus("PROJ-1", "B", { f: 1 })],
      ["swapLabel", () => client.swapLabel("PROJ-1", "a", "b")],
      ["removeLabel", () => client.removeLabel("PROJ-1", "a")],
      ["assignTicket", () => client.assignTicket("PROJ-1", "acct")],
      ["addComment", () => client.addComment("PROJ-1", { type: "doc", version: 1, content: [] })],
      ["closeTicket", () => client.closeTicket("PROJ-1")],
      ["getBlockedBy", () => client.getBlockedBy("PROJ-1")],
    ];
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toThrow(new RegExp(`${name}.*not configured`));
    }
  });
});

describe("parseRequiredFields", () => {
  it("reads errorMessages 'Field X is required.' (with or without the period)", () => {
    expect(
      parseRequiredFields('{"errorMessages":["Field Story Points is required.","Field Sprint is required"],"errors":{}}'),
    ).toEqual(["Story Points", "Sprint"]);
  });
  it("reads errors{} messages, falling back to the key when no name is usable", () => {
    expect(
      parseRequiredFields(
        '{"errors":{"customfield_1":"Story Points is required.","customfield_10002":"required","customfield_3":"Field is required"}}',
      ),
    ).toEqual(["Story Points", "customfield_10002", "customfield_3"]);
  });
  it("mixes both shapes in order and dedupes", () => {
    expect(
      parseRequiredFields(
        '{"errorMessages":["Field Story Points is required.","Something else"],"errors":{"a":"Story Points is required.","b":"Team is required"}}',
      ),
    ).toEqual(["Story Points", "Team"]);
  });
  it("returns [] for non-JSON or nothing matching", () => {
    expect(parseRequiredFields("<html>")).toEqual([]);
    expect(parseRequiredFields('{"errorMessages":["boom"],"errors":{"x":"invalid"}}')).toEqual([]);
    expect(parseRequiredFields("null")).toEqual([]);
  });
});

describe("RealJiraClient comments and labels", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

  it("listComments pages until total and extracts the first line", async () => {
    const first = {
      id: "1",
      created: "2026-01-01T00:00:00.000+0000",
      body: {
        type: "doc",
        content: [
          { type: "heading", content: [{ type: "text", text: "\u2705 research-loop - " }, { type: "text", text: "refined" }] },
        ],
      },
    };
    const page1 = Array.from({ length: 100 }, (_, i) => (i === 0 ? first : { id: String(i + 1), created: "c", body: { type: "doc", content: [] } }));
    const page2 = [{ id: "200", created: "c2", body: { type: "doc", content: [{ type: "paragraph", content: [] }, { type: "paragraph", content: [{ type: "text", text: "  second  " }] }] } }];
    fetchMock.mockResolvedValueOnce(json({ startAt: 0, total: 101, comments: page1 }));
    fetchMock.mockResolvedValueOnce(json({ startAt: 100, total: 101, comments: page2 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const out = await client.listComments("TARS-1");

    expect(out).toHaveLength(101);
    expect(out[0]).toEqual({
      id: "1",
      created: "2026-01-01T00:00:00.000+0000",
      firstLine: "\u2705 research-loop - refined",
      url: "https://example.atlassian.net/browse/TARS-1?focusedCommentId=1",
    });
    expect(out[1]!.firstLine).toBe("");
    expect(out[100]!.firstLine).toBe("second");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/rest/api/3/issue/TARS-1/comment?startAt=0&maxResults=100&orderBy=created");
    expect(String(fetchMock.mock.calls[1][0])).toContain("startAt=100");
  });

  it("listComments caps firstLine at 120 chars", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ total: 1, comments: [{ id: "1", created: "c", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(300) }] }] } }] }),
    );
    const out = await new RealJiraClient(CREDENTIALS, makeConfig()).listComments("TARS-1");
    expect(out[0]!.firstLine).toHaveLength(120);
  });

  it("deleteComment sends DELETE to the comment path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await new RealJiraClient(CREDENTIALS, makeConfig()).deleteComment("TARS-1", "42");
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/rest/api/3/issue/TARS-1/comment/42");
    expect(init.method).toBe("DELETE");
  });

  it("deleteComment surfaces a 403 with its status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    await expect(new RealJiraClient(CREDENTIALS, makeConfig()).deleteComment("TARS-1", "42")).rejects.toMatchObject({ status: 403 });
  });

  it("getLabels returns fields.labels", async () => {
    fetchMock.mockResolvedValueOnce(json({ fields: { labels: ["pipeline:v2"] } }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await expect(client.getLabels("TARS-1")).resolves.toEqual(["pipeline:v2"]);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://example.atlassian.net/rest/api/3/issue/TARS-1?fields=labels");
    fetchMock.mockResolvedValueOnce(json({ fields: {} }));
    await expect(client.getLabels("TARS-1")).resolves.toEqual([]);
  });

  it("listComments reads an ADF emoji node's attrs.text into the first line", async () => {
    const body = { type: "doc", content: [{ type: "paragraph", content: [
      { type: "emoji", attrs: { shortName: ":white_check_mark:", text: "\u2705" } },
      { type: "text", text: " research-loop - refined" },
    ] }] };
    fetchMock.mockResolvedValueOnce(json({ total: 1, comments: [{ id: "1", created: "c", body }] }));
    const out = await new RealJiraClient(CREDENTIALS, makeConfig()).listComments("TARS-1");
    expect(out[0]!.firstLine).toBe("\u2705 research-loop - refined");
  });

  it("listComments maps an ADF emoji node with only a shortName", async () => {
    const para = (shortName: string, rest: string) => ({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "emoji", attrs: { shortName } },
      { type: "text", text: rest },
    ] }] });
    fetchMock.mockResolvedValueOnce(json({ total: 4, comments: [
      { id: "1", created: "c", body: para(":white_check_mark:", " research-loop - refined") },
      { id: "2", created: "c", body: para(":x:", " dev-loop - bounced") },
      { id: "3", created: "c", body: para(":warning:", " heads up") },
      { id: "4", created: "c", body: para(":tada:", "party") },
    ] }));
    const out = await new RealJiraClient(CREDENTIALS, makeConfig()).listComments("TARS-1");
    expect(out.map((c) => c.firstLine)).toEqual([
      "\u2705 research-loop - refined",
      "\u274c dev-loop - bounced",
      "\u26a0\ufe0f heads up",
      "party",
    ]);
  });

  it("deleteComment refuses a bad ticket key or a non-numeric comment id before any request", async () => {
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await expect(client.deleteComment("../x", "42")).rejects.toThrow(/invalid ticket key/);
    await expect(client.deleteComment("TARS-1", "42/../../x")).rejects.toThrow(/invalid comment id/);
    await expect(client.deleteComment("TARS-1", "")).rejects.toThrow(/invalid comment id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getLabels refuses a bad ticket key before any request", async () => {
    await expect(new RealJiraClient(CREDENTIALS, makeConfig()).getLabels("TARS-1?x=1")).rejects.toThrow(/invalid ticket key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("StubJiraClient throws not-configured for the new methods", async () => {
    const stub = new StubJiraClient({ blockedBy: {} });
    await expect(stub.listComments("A-1")).rejects.toThrow(/listComments/);
    await expect(stub.deleteComment("A-1", "1")).rejects.toThrow(/deleteComment/);
    await expect(stub.getLabels("A-1")).rejects.toThrow(/getLabels/);
  });
});
