import { describe, expect, it } from "vitest";
import { adfToText, readTicket, type JiraGet } from "../../src/eval/jira-read.ts";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...t: string[]) => ({ type: "paragraph", content: t.map((text) => ({ type: "text", text })) });

describe("adfToText", () => {
  it("paragraphs become lines, headings get #, list items get -, code blocks get fences", () => {
    const t = adfToText(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
        p("Hello ", "world"),
        { type: "bulletList", content: [{ type: "listItem", content: [p("one")] }, { type: "listItem", content: [p("two")] }] },
        { type: "codeBlock", content: [{ type: "text", text: "x = 1" }] },
      ),
    );
    expect(t).toBe("## Title\n\nHello world\n\n- one\n- two\n\n```\nx = 1\n```");
  });
  it("hard breaks, mentions and links", () => {
    const t = adfToText(doc({ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "mention", attrs: { text: "@Jane" } }, { type: "text", text: " see", marks: [{ type: "link", attrs: { href: "https://x.y" } }] }] }));
    expect(t).toBe("a\n@Jane see (https://x.y)");
  });
  it("a plain string or nothing", () => {
    expect(adfToText("plain")).toBe("plain");
    expect(adfToText(null)).toBe("");
  });
});

describe("readTicket", () => {
  it("reads fields, every comment page and each link, with GETs only", async () => {
    const calls: string[] = [];
    const get: JiraGet = async (path) => {
      calls.push(path);
      if (path.startsWith("/rest/api/3/issue/MC-1?")) {
        return {
          key: "MC-1",
          fields: {
            summary: "S", issuetype: { name: "Story" }, description: doc(p("D")),
            attachment: [{ id: "5", filename: "a.json", size: 3, mimeType: "application/json" }],
            issuelinks: [{ type: { inward: "is blocked by" }, inwardIssue: { key: "MC-2" } }],
          },
        };
      }
      if (path.startsWith("/rest/api/3/issue/MC-1/comment?startAt=0")) return { total: 2, comments: [{ id: "1", created: "c1", author: { displayName: "Jane" }, body: doc(p("first")) }] };
      if (path.startsWith("/rest/api/3/issue/MC-1/comment?startAt=1")) return { total: 2, comments: [{ id: "2", created: "c2", author: { displayName: "Bob" }, body: doc(p("second")) }] };
      if (path.startsWith("/rest/api/3/issue/MC-2?")) return { key: "MC-2", fields: { summary: "L", description: doc(p("LD")) } };
      if (path.startsWith("/rest/api/3/issue/MC-2/comment")) return { total: 0, comments: [] };
      throw new Error(`unexpected ${path}`);
    };
    const t = await readTicket("MC-1", get);
    expect(t).toEqual({
      key: "MC-1", summary: "S", issueType: "Story", description: "D",
      comments: [{ id: "1", author: "Jane", created: "c1", body: "first" }, { id: "2", author: "Bob", created: "c2", body: "second" }],
      attachments: [{ id: "5", filename: "a.json", size: 3, mimeType: "application/json" }],
      links: [{ key: "MC-2", summary: "L", description: "LD", comments: [] }],
    });
  });
  it("refuses a bad key before any call", async () => {
    await expect(readTicket("x/../y", async () => ({}))).rejects.toThrow(/key/);
  });
});
