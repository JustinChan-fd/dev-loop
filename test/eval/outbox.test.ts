import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboxJiraClient, readOutbox } from "../../src/eval/outbox.ts";

describe("OutboxJiraClient", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "outbox-"));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("addComment and transitionStatus go to numbered outbox/loop-*.json files, nothing else", async () => {
    const c = new OutboxJiraClient(dir, "FX-1");
    await c.addComment("FX-1", { type: "doc", version: 1, content: [] });
    await c.transitionStatus("FX-1", "Blocked");
    const files = (await readdir(join(dir, "outbox"))).sort();
    expect(files).toEqual(["loop-001-comment.json", "loop-002-transition.json"]);
    expect(JSON.parse(await readFile(join(dir, "outbox", "loop-002-transition.json"), "utf8"))).toEqual({ surface: "jira", action: "transition", target: "FX-1", to: "Blocked" });
    expect(c.writes).toHaveLength(2);
  });

  it("refuses a write to any key but the fixture's", async () => {
    const c = new OutboxJiraClient(dir, "FX-1");
    await expect(c.addComment("MC-1435", {})).rejects.toThrow(/FX-1/);
  });

  it("every other method throws, naming fixture mode", async () => {
    const c = new OutboxJiraClient(dir, "FX-1");
    for (const call of [() => c.claimTicket("FX-1", "a", "b"), () => c.swapLabel("FX-1", "a", "b"), () => c.pollOldestMatching("x"), () => c.getStatus("FX-1"), () => c.listComments("FX-1"), () => c.closeTicket("FX-1")]) {
      await expect(call()).rejects.toThrow(/fixture mode/);
    }
  });

  it("readOutbox returns every outbox file's text, sorted, and [] when there is none", async () => {
    expect(await readOutbox(dir)).toEqual([]);
    const c = new OutboxJiraClient(dir, "FX-1");
    await c.transitionStatus("FX-1", "Blocked");
    const ob = await readOutbox(dir);
    expect(ob.map((o) => o.file)).toEqual(["loop-001-transition.json"]);
    expect(ob[0]!.text).toContain("Blocked");
  });
});
