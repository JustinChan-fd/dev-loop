import { describe, expect, it, vi } from "vitest";
import { runDevPhase } from "../../../src/roles/dev/phase.ts";
import type { DevPhaseDeps } from "../../../src/roles/dev/phase.ts";
import { buildQaNotesAdf, buildBounceCommentAdf } from "../../../src/roles/dev/code-review.ts";
import type { JiraClient, JiraTicket } from "../../../src/core/jira-client.ts";
import type { GitHubClient } from "../../../src/core/github-client.ts";
import type { RunSkillFn, RunSkillResult } from "../../../src/core/run-skill.ts";
import type { DevView, ExecutorVerdict } from "../../../src/core/types.ts";
import { roleView } from "../../../src/core/config.ts";
import { makeV2Config } from "../../fixtures/config.ts";

/** The dev role's settings, built the way the cycle builds them: roleView over a v2 Config. */
function makeView(): DevView {
  return roleView(makeV2Config(), "dev");
}

function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return { key: "PROJ-1", status: "In Progress", assignee: "user-123", labels: [], ...overrides };
}

function makeMockJiraClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => null),
    pollAllMatching: vi.fn(async () => []),
    claimTicket: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => {}),
    swapLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    assignTicket: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
    getBlockedBy: vi.fn(async () => []),
    ...overrides,
  };
}

function makeMockGitHubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "https://github.com/org/repo/issues/42", state: "OPEN" as const })),
    createIssue: vi.fn(),
    addComment: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    closePr: vi.fn(async () => "already-closed" as const),
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<ExecutorVerdict> = {}): ExecutorVerdict {
  return {
    outcome: "landed",
    phase_reached: "pr",
    failure_category: null,
    detail: "Implemented cleanly.",
    red_confirmed: true,
    verify_loops: 1,
    retries: 0,
    skill_version: "abc1234",
    model: "sonnet",
    pr: "https://github.com/org/repo/pull/1",
    cost_usd: 1.0,
    tokens: { in: 1000, out: 100 },
    ...overrides,
  };
}

/** Measured usage, deliberately different from any verdict.cost_usd / verdict.tokens, so reading the self-report shows up. */
const MEASURED = { costUsd: 3.25, tokens: { in: 1234, out: 567 } };

function skillReturning(verdict: ExecutorVerdict | string | undefined, o: Partial<RunSkillResult> = {}): RunSkillFn & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    verdictRaw: typeof verdict === "object" ? JSON.stringify(verdict) : verdict,
    started: "2026-08-16T14:02:11.000Z",
    ended: "2026-08-16T14:19:40.000Z",
    skillVersion: "sha-skill",
    model: "sonnet",
    ...MEASURED,
    ...o,
  })) as unknown as RunSkillFn & ReturnType<typeof vi.fn>;
}

function makeDeps(o: Partial<DevPhaseDeps> = {}): DevPhaseDeps {
  return {
    jira: makeMockJiraClient(),
    github: makeMockGitHubClient(),
    view: makeView(),
    runSkill: skillReturning(makeVerdict()),
    runDir: ".pipeline/v2/repo/dev-1/PROJ-1/dev-20260816T140211Z",
    maxBudgetUsd: 20,
    session: "dev-1",
    now: () => new Date("2026-08-16T14:00:00.000Z"),
    ...o,
  };
}

const bounceNoPr = (detail = "AC2 and AC4 pass against unmodified baseline code.") =>
  makeVerdict({ outcome: "bounced", failure_category: "spec_ambiguous", detail, pr: null });

describe("runDevPhase", () => {
  it("calls runSkill with role dev, the ticket key, the run dir and the budget, and never claims or polls", async () => {
    const deps = makeDeps();
    await runDevPhase(makeTicket(), deps);
    expect(deps.runSkill).toHaveBeenCalledWith({
      role: "dev",
      ticketKey: "PROJ-1",
      runDir: ".pipeline/v2/repo/dev-1/PROJ-1/dev-20260816T140211Z",
      maxBudgetUsd: 20,
    });
    expect(deps.jira.claimTicket).not.toHaveBeenCalled();
    expect(deps.jira.pollOldestMatching).not.toHaveBeenCalled();
    expect(deps.jira.assignTicket).not.toHaveBeenCalled();
  });

  it("returns a PhaseEntry with the MEASURED cost/tokens (never the verdict's self-report) and the run dir", async () => {
    const entry = await runDevPhase(makeTicket(), makeDeps());
    expect(entry).toMatchObject({
      role: "dev",
      skill: "ticket-to-pr",
      skill_version: "sha-skill",
      model: "sonnet",
      started: "2026-08-16T14:02:11.000Z",
      ended: "2026-08-16T14:19:40.000Z",
      outcome: "landed",
      phase_reached: "pr",
      cost_usd: 3.25,
      tokens: { in: 1234, out: 567 },
      failure_category: null,
      pr: "https://github.com/org/repo/pull/1",
      run_dir: ".pipeline/v2/repo/dev-1/PROJ-1/dev-20260816T140211Z",
      red_confirmed: true,
      verify_loops: 1,
      retries: 0,
    });
    expect(entry.jira_sync_error).toBeUndefined();
  });

  it("carries preexisting_failures into the PhaseEntry only when the skill reported some (Ruling 29)", async () => {
    const failing = ["src/server/x.integration.test.js > accepts a ~200KB body"];
    const withFailures = await runDevPhase(
      makeTicket(),
      makeDeps({ runSkill: skillReturning(makeVerdict({ preexisting_failures: failing })) }),
    );
    expect(withFailures.preexisting_failures).toEqual(failing);

    const without = await runDevPhase(makeTicket(), makeDeps());
    expect("preexisting_failures" in without).toBe(false);

    const empty = await runDevPhase(
      makeTicket(),
      makeDeps({ runSkill: skillReturning(makeVerdict({ preexisting_failures: [] })) }),
    );
    expect("preexisting_failures" in empty).toBe(false);
  });

  it("carries follow_up into the PhaseEntry only when the skill reported one (Ruling 30)", async () => {
    const fu = { ticket: "PROJ-9", pr: "https://github.com/org/repo/pull/2" };
    const entry = await runDevPhase(makeTicket(), makeDeps({ runSkill: skillReturning(makeVerdict({ follow_up: fu })) }));
    expect(entry.follow_up).toEqual(fu);
    const without = await runDevPhase(makeTicket(), makeDeps());
    expect("follow_up" in without).toBe(false);
  });

  it("malformed or missing verdict.json → outcome error / agent_error", async () => {
    for (const raw of ["{not json", undefined]) {
      const entry = await runDevPhase(makeTicket(), makeDeps({ runSkill: skillReturning(raw) }));
      expect(entry.outcome).toBe("error");
      expect(entry.failure_category).toBe("agent_error");
      expect(entry.cost_usd).toBe(3.25);
    }
  });

  it("runSkill throws → error entry with agent_error, no throw", async () => {
    const runSkill = vi.fn(async () => {
      throw new Error("spawn exploded");
    }) as unknown as RunSkillFn;
    const entry = await runDevPhase(makeTicket(), makeDeps({ runSkill }));
    expect(entry.outcome).toBe("error");
    expect(entry.failure_category).toBe("agent_error");
    expect(entry.detail).toMatch(/spawn exploded/);
    expect(entry.started).toBe("2026-08-16T14:00:00.000Z");
  });

  it("landed → transitions to Code Review with the required PII/QA-notes screen fields; no comment, no label swap", async () => {
    const jira = makeMockJiraClient();
    await runDevPhase(makeTicket(), makeDeps({ jira }));
    expect(jira.transitionStatus).toHaveBeenCalledWith("PROJ-1", "Code Review", {
      customfield_13504: [{ id: "14310" }],
      customfield_14226: buildQaNotesAdf(makeVerdict()),
    });
    expect(jira.addComment).not.toHaveBeenCalled();
    expect(jira.swapLabel).not.toHaveBeenCalled();
  });

  it("landed → posts PR/verify-loop detail to the mirror GitHub Issue, ending with the session suffix", async () => {
    const github = makeMockGitHubClient();
    await runDevPhase(makeTicket(), makeDeps({ github, runSkill: skillReturning(makeVerdict({ pr: "https://github.com/org/repo/pull/9" })) }));
    expect(github.findIssueByJiraKey).toHaveBeenCalledWith("PROJ-1");
    const body = (github.addComment as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(body).toContain("https://github.com/org/repo/pull/9");
    expect(body.endsWith("\n\n— dev-1")).toBe(true);
  });

  it("a Code Review transition failure never throws: surfaced via jira_sync_error, outcome unchanged", async () => {
    const jira = makeMockJiraClient({
      transitionStatus: vi.fn(async () => {
        throw new Error("Jira 400: field required");
      }),
    });
    const entry = await runDevPhase(makeTicket(), makeDeps({ jira }));
    expect(entry.outcome).toBe("landed");
    expect(entry.jira_sync_error).toMatch(/field required/);
  });

  it("genuine bounce (no PR) → evidence comment (with session suffix) BEFORE the Blocked transition", async () => {
    const jira = makeMockJiraClient();
    const entry = await runDevPhase(makeTicket({ key: "PROJ-7" }), makeDeps({ jira, runSkill: skillReturning(bounceNoPr()) }));
    expect(entry.outcome).toBe("bounced");
    const [key, body] = (jira.addComment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(key).toBe("PROJ-7");
    expect(body).toEqual(buildBounceCommentAdf(bounceNoPr(), "dev-1"));
    expect(JSON.stringify(body)).toContain("spec_ambiguous");
    expect(jira.transitionStatus).toHaveBeenCalledWith("PROJ-7", "Blocked");
    const c = (jira.addComment as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const t = (jira.transitionStatus as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(c).toBeLessThan(t);
    expect(jira.swapLabel).not.toHaveBeenCalled();
  });

  it("genuine bounce → the full detail also goes to the mirror GitHub Issue", async () => {
    const github = makeMockGitHubClient();
    await runDevPhase(makeTicket(), makeDeps({ github, runSkill: skillReturning(bounceNoPr("the full bounce detail")) }));
    expect(github.addComment).toHaveBeenCalledWith(42, expect.stringContaining("the full bounce detail"));
  });

  it("a bounce-comment failure never blocks the Blocked transition; surfaced via jira_sync_error", async () => {
    const jira = makeMockJiraClient({
      addComment: vi.fn(async () => {
        throw new Error("comment 500");
      }),
    });
    const entry = await runDevPhase(makeTicket(), makeDeps({ jira, runSkill: skillReturning(bounceNoPr()) }));
    expect(jira.transitionStatus).toHaveBeenCalledWith("PROJ-1", "Blocked");
    expect(entry.jira_sync_error).toMatch(/comment 500/);
  });

  it("no mirror Issue → the GitHub write is skipped silently; a GitHub failure is surfaced, the Jira work still completes", async () => {
    const quiet = makeMockGitHubClient({ findIssueByJiraKey: vi.fn(async () => null) });
    const e1 = await runDevPhase(makeTicket(), makeDeps({ github: quiet }));
    expect(quiet.addComment).not.toHaveBeenCalled();
    expect(e1.jira_sync_error).toBeUndefined();

    const jira = makeMockJiraClient();
    const broken = makeMockGitHubClient({
      addComment: vi.fn(async () => {
        throw new Error("gh 502");
      }),
    });
    const e2 = await runDevPhase(makeTicket(), makeDeps({ jira, github: broken }));
    expect(e2.jira_sync_error).toMatch(/gh 502/);
    expect(jira.transitionStatus).toHaveBeenCalledWith("PROJ-1", "Code Review", expect.anything());
  });

  it("bounced WITH an existing PR (work already landed) → never Blocked; self-heals to Code Review when not already there", async () => {
    const verdict = makeVerdict({ outcome: "bounced", failure_category: "blocked", detail: "already landed", pr: "https://github.com/org/repo/pull/431" });
    const jira = makeMockJiraClient();
    await runDevPhase(makeTicket({ status: "In Progress" }), makeDeps({ jira, runSkill: skillReturning(verdict) }));
    expect(jira.transitionStatus).toHaveBeenCalledTimes(1);
    expect(jira.transitionStatus).toHaveBeenCalledWith("PROJ-1", "Code Review", {
      customfield_13504: [{ id: "14310" }],
      customfield_14226: buildQaNotesAdf(verdict),
    });
    expect(jira.addComment).not.toHaveBeenCalled();
  });

  it("bounced WITH an existing PR, already at Code Review → no re-transition (idempotent self-heal)", async () => {
    const verdict = makeVerdict({ outcome: "bounced", pr: "https://github.com/org/repo/pull/431" });
    const jira = makeMockJiraClient();
    await runDevPhase(makeTicket({ status: "Code Review" }), makeDeps({ jira, runSkill: skillReturning(verdict) }));
    expect(jira.transitionStatus).not.toHaveBeenCalled();
  });

  it("landed run records diff_stats from the PR", async () => {
    const prDiffStats = vi.fn(async () => ({ files: 3, additions: 40, deletions: 2 }));
    const e = await runDevPhase(makeTicket(), makeDeps({ prDiffStats }));
    expect(e.diff_stats).toEqual({ files: 3, additions: 40, deletions: 2 });
    expect(prDiffStats).toHaveBeenCalledWith("https://github.com/org/repo/pull/1");
  });

  it("a bounced run never asks for diff stats", async () => {
    const prDiffStats = vi.fn(async () => ({ files: 3, additions: 40, deletions: 2 }));
    const e = await runDevPhase(makeTicket(), makeDeps({ prDiffStats, runSkill: skillReturning(makeVerdict({ outcome: "bounced", failure_category: "spec_ambiguous", pr: null })) }));
    expect(prDiffStats).not.toHaveBeenCalled();
    expect(e.diff_stats).toBeUndefined();
  });

  it("prDiffStats returning null leaves no diff_stats and still lands", async () => {
    const e = await runDevPhase(makeTicket(), makeDeps({ prDiffStats: vi.fn(async () => null) }));
    expect(e.outcome).toBe("landed");
    expect("diff_stats" in e).toBe(false);
  });

  it("prDiffStats throwing leaves no diff_stats, still lands, and adds nothing to jira_sync_error", async () => {
    const e = await runDevPhase(makeTicket(), makeDeps({ prDiffStats: vi.fn(async () => { throw new Error("boom"); }) }));
    expect(e.outcome).toBe("landed");
    expect("diff_stats" in e).toBe(false);
    expect(e.jira_sync_error).toBeUndefined();
  });

  it("error / killed outcomes make no Jira write (the cycle's attempt cap handles repeats)", async () => {
    for (const outcome of ["error", "killed"] as const) {
      const jira = makeMockJiraClient();
      await runDevPhase(makeTicket(), makeDeps({ jira, runSkill: skillReturning(makeVerdict({ outcome, pr: null, failure_category: "agent_error" })) }));
      expect(jira.transitionStatus).not.toHaveBeenCalled();
      expect(jira.addComment).not.toHaveBeenCalled();
    }
  });
});

describe("buildBounceCommentAdf", () => {
  it("opens with the '{icon} dev-loop - <short context>' convention as its bold first line, not the old 'Bounced (<category>):' prefix", () => {
    const adf = buildBounceCommentAdf(
      makeVerdict({
        outcome: "bounced",
        failure_category: "spec_ambiguous",
        detail: "AC 3's assertion strategy is unspecified.",
      }),
    );

    const firstParagraph = (adf.content as Array<Record<string, unknown>>)[0];
    const firstTextNode = (firstParagraph.content as Array<Record<string, unknown>>)[0];
    expect(firstTextNode.text).toBe("❌ dev-loop - spec_ambiguous: ");
    expect((firstTextNode.marks as Array<{ type: string }>)[0].type).toBe("strong");
  });

  it("still includes the verdict's own detail text as the comment body, unchanged", () => {
    const adf = buildBounceCommentAdf(
      makeVerdict({ outcome: "bounced", failure_category: "blocked", detail: "Needs a human call." }),
    );
    const firstParagraph = (adf.content as Array<Record<string, unknown>>)[0];
    const detailTextNode = (firstParagraph.content as Array<Record<string, unknown>>)[1];
    expect(detailTextNode.text).toBe("Needs a human call.");
  });
});

describe("buildQaNotesAdf", () => {
  it("with qa_notes set: builds a bold 'Manual testing steps:' header followed by an ordered list, one listItem per entry, with Expected: entries bold-marked -- matching the retired interactive qa-notes/push-branch skills' ADF shape, not the PR-link stub", () => {
    const verdict = makeVerdict({
      qa_notes: [
        "Navigate to `/rotten-tomatoes/critics?query=tina+kakad`",
        "Expected: the Self-Service badge appears next to the critic's name",
      ],
    });

    const adf = buildQaNotesAdf(verdict) as {
      type: string;
      content: Array<Record<string, unknown>>;
    };

    expect(adf.type).toBe("doc");
    expect(adf.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Manual testing steps:", marks: [{ type: "strong" }] }],
    });

    const orderedList = adf.content[1] as {
      type: string;
      attrs: { order: number };
      content: Array<Record<string, unknown>>;
    };
    expect(orderedList.type).toBe("orderedList");
    expect(orderedList.content).toHaveLength(2);

    // Plain step: no bold mark.
    expect(orderedList.content[0]).toEqual({
      type: "listItem",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Navigate to `/rotten-tomatoes/critics?query=tina+kakad`" },
          ],
        },
      ],
    });

    // "Expected:" step: that prefix is bold-marked, rest is plain.
    expect(orderedList.content[1]).toEqual({
      type: "listItem",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Expected:", marks: [{ type: "strong" }] },
            {
              type: "text",
              text: " the Self-Service badge appears next to the critic's name",
            },
          ],
        },
      ],
    });
  });

  it("with qa_notes absent: falls back to the existing PR-link stub, unchanged -- regression guard for verdicts that predate this field or a bounce with no notes to give", () => {
    const verdict = makeVerdict({ pr: "https://github.com/org/repo/pull/42", verify_loops: 2 });
    delete (verdict as Partial<ExecutorVerdict>).qa_notes;

    const adf = buildQaNotesAdf(verdict) as {
      type: string;
      content: Array<Record<string, unknown>>;
    };

    expect(adf).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "PR: https://github.com/org/repo/pull/42" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Verify loops: 2" }],
        },
      ],
    });
  });

  it("with qa_notes an empty array: falls back to the PR-link stub, same as absent", () => {
    const verdict = makeVerdict({ qa_notes: [] });

    const adf = buildQaNotesAdf(verdict) as { content: Array<Record<string, unknown>> };

    expect(adf.content).toHaveLength(2);
    expect(adf.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: expect.stringContaining("PR:") }],
    });
  });
});


describe("buildBounceCommentAdf session suffix", () => {
  it("with a session, the last paragraph is '— <session>'; without one, unchanged (single paragraph)", () => {
    const v = makeVerdict({ outcome: "bounced", failure_category: "blocked", detail: "x" });
    const withS = buildBounceCommentAdf(v, "dev-2") as { content: Array<{ content: Array<{ text: string }> }> };
    expect(withS.content).toHaveLength(2);
    expect(withS.content[1].content[0].text).toBe("— dev-2");
    expect((buildBounceCommentAdf(v) as { content: unknown[] }).content).toHaveLength(1);
  });
});

describe("runDevPhase ready_to_push", () => {
  const ready = { branch: "PROJ-1-x", pr_title: "t", pr_body: "b" };
  const rtp = () => makeVerdict({ outcome: "ready_to_push", pr: null, ...ready, detail: "Done." } as Partial<ExecutorVerdict>);
  const okRes = { ok: true as const, pr: "https://github.com/org/repo/pull/9", branch: "feat/PROJ-1-x", signed: 2, oldTip: "aaaaaaa1111", newTip: "bbbbbbb2222", costUsd: 0.5 };

  it("hostPush ok lands: Code Review transition, host PR, summed cost, Host-signed detail", async () => {
    const hostPush = vi.fn(async () => okRes);
    const deps = makeDeps({ runSkill: skillReturning(rtp()), hostPush });
    const entry = await runDevPhase(makeTicket(), deps);
    expect(hostPush).toHaveBeenCalledWith(ready);
    expect(deps.jira.transitionStatus).toHaveBeenCalledWith("PROJ-1", deps.view.statusNames.prOpen, expect.anything());
    expect(entry.outcome).toBe("landed");
    expect(entry.pr).toBe(okRes.pr);
    expect(entry.cost_usd).toBeCloseTo(3.75);
    expect(entry.detail).toBe("Done. Host-signed 2 commit(s) (aaaaaaa→bbbbbbb) and pushed feat/PROJ-1-x.");
  });

  it.each([
    ["fails", async () => ({ ok: false as const, detail: "signing failed: x", costUsd: 0.5 }), 3.75, "host push failed: signing failed: x. Work committed locally on PROJ-1-x, not pushed."],
    ["throws", async () => { throw new Error("boom"); }, 3.25, "host push failed: boom. Work committed locally on PROJ-1-x, not pushed."],
  ])("hostPush %s bounces env_setup", async (_n, impl, cost, detail) => {
    const deps = makeDeps({ runSkill: skillReturning(rtp()), hostPush: vi.fn(impl) });
    const entry = await runDevPhase(makeTicket(), deps);
    expect(entry.outcome).toBe("bounced");
    expect(entry.failure_category).toBe("env_setup");
    expect(entry.pr).toBeNull();
    expect(entry.detail).toBe(detail);
    expect(entry.cost_usd).toBeCloseTo(cost);
    expect(deps.jira.addComment).toHaveBeenCalled();
    expect(deps.jira.transitionStatus).toHaveBeenCalledWith("PROJ-1", deps.view.statusNames.bounced);
  });

  it("F8: bounce detail uses the host-reported branch and pre-sign tip", async () => {
    const hostPush = vi.fn(async () => ({ ok: false as const, detail: "no PR", costUsd: 0, branch: "feat/PROJ-1-x", oldTip: "cccccccdddd" }));
    const entry = await runDevPhase(makeTicket(), makeDeps({ runSkill: skillReturning(rtp()), hostPush }));
    expect(entry.detail).toBe("host push failed: no PR. Work committed locally on feat/PROJ-1-x, not pushed. Pre-sign tip ccccccc.");
  });

  it("a failure after the push says the branch IS on origin (never 'not pushed')", async () => {
    const hostPush = vi.fn(async () => ({ ok: false as const, detail: "no PR", costUsd: 0, branch: "PROJ-1-x", oldTip: "cccccccdddd", pushed: true }));
    const entry = await runDevPhase(makeTicket(), makeDeps({ runSkill: skillReturning(rtp()), hostPush }));
    expect(entry.detail).toBe("host push failed: no PR. Branch PROJ-1-x is pushed to origin (signed); no PR yet. Pre-sign tip ccccccc.");
  });

  it("without hostPush is an agent_error and writes nothing to Jira", async () => {
    const deps = makeDeps({ runSkill: skillReturning(rtp()) });
    const entry = await runDevPhase(makeTicket(), deps);
    expect(entry.outcome).toBe("error");
    expect(entry.failure_category).toBe("agent_error");
    expect(entry.detail).toContain("ready_to_push but this run has no host push");
    expect(deps.jira.transitionStatus).not.toHaveBeenCalled();
  });
});
