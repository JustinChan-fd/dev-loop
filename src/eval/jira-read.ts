// fixture:save's read-only Jira reader (eval fixtures): the issue's fields,
// every comment (paged) and each linked issue, as plain text. GETs only,
// through an injected `get`, so the JiraClient interface the worker uses is
// unchanged and nothing here can write.

import { TICKET_KEY } from "../core/paths.ts";
import type { RawComment, RawTicket } from "./fixture-save.ts";

/** GET a Jira REST path (starting with /rest/api/3/) and return the parsed JSON. */
export type JiraGet = (path: string) => Promise<unknown>;

type Node = { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown>; marks?: Array<{ type?: string; attrs?: Record<string, unknown> }> };

function inline(n: Node): string {
  if (n.type === "text") {
    const link = n.marks?.find((m) => m.type === "link")?.attrs?.href;
    return `${n.text ?? ""}${typeof link === "string" ? ` (${link})` : ""}`;
  }
  if (n.type === "hardBreak") return "\n";
  if (n.type === "mention" || n.type === "emoji") return String(n.attrs?.text ?? "");
  if (n.type === "inlineCard") return String(n.attrs?.url ?? "");
  return (n.content ?? []).map((c) => inline(c as Node)).join("");
}

function block(n: Node, prefix = ""): string {
  switch (n.type) {
    case "heading":
      return `${"#".repeat(Number(n.attrs?.level) || 1)} ${inline(n)}`;
    case "bulletList":
    case "orderedList":
      return (n.content ?? []).map((li, i) => block(li as Node, n.type === "orderedList" ? `${i + 1}. ` : "- ")).join("\n");
    case "listItem":
      return prefix + (n.content ?? []).map((c) => block(c as Node)).join("\n  ");
    case "codeBlock":
      return "```\n" + inline(n) + "\n```";
    case "rule":
      return "---";
    case "paragraph":
      return inline(n);
    default:
      return n.content ? (n.content as Node[]).map((c) => (c.type === "text" ? inline(c) : block(c))).join("\n") : inline(n);
  }
}

/** ADF (or a plain string) as markdown-ish text. Never throws. */
export function adfToText(adf: unknown): string {
  if (typeof adf === "string") return adf;
  if (!adf || typeof adf !== "object") return "";
  const content = ((adf as Node).content ?? []) as Node[];
  return content.map((b) => block(b)).filter((s) => s !== "").join("\n\n");
}

async function comments(key: string, get: JiraGet): Promise<RawComment[]> {
  const out: RawComment[] = [];
  for (let startAt = 0; ; ) {
    const d = (await get(`/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`)) as { total?: number; comments?: Array<{ id: unknown; created?: unknown; author?: { displayName?: unknown }; body?: unknown }> };
    const page = d.comments ?? [];
    for (const c of page) out.push({ id: String(c.id), author: String(c.author?.displayName ?? "unknown"), created: String(c.created ?? ""), body: adfToText(c.body) });
    startAt += page.length;
    if (page.length === 0 || startAt >= (d.total ?? 0)) return out;
  }
}

type IssueFields = {
  summary?: unknown;
  issuetype?: { name?: unknown };
  description?: unknown;
  attachment?: Array<{ id?: unknown; filename?: unknown; size?: unknown; mimeType?: unknown }>;
  issuelinks?: Array<{ inwardIssue?: { key?: unknown }; outwardIssue?: { key?: unknown } }>;
};

export async function readTicket(key: string, get: JiraGet): Promise<RawTicket> {
  if (!TICKET_KEY.test(key)) throw new Error(`readTicket: invalid ticket key ${JSON.stringify(key)}`);
  const issue = (await get(`/rest/api/3/issue/${key}?fields=summary,issuetype,description,attachment,issuelinks`)) as { fields?: IssueFields };
  const f = issue.fields ?? {};
  const linkKeys = [...new Set((f.issuelinks ?? []).map((l) => String(l.inwardIssue?.key ?? l.outwardIssue?.key ?? "")).filter((k) => TICKET_KEY.test(k)))];
  const links: RawTicket["links"] = [];
  for (const lk of linkKeys) {
    const li = (await get(`/rest/api/3/issue/${lk}?fields=summary,description`)) as { fields?: IssueFields };
    links.push({ key: lk, summary: String(li.fields?.summary ?? ""), description: adfToText(li.fields?.description), comments: await comments(lk, get) });
  }
  return {
    key,
    summary: String(f.summary ?? ""),
    issueType: String(f.issuetype?.name ?? ""),
    description: adfToText(f.description),
    comments: await comments(key, get),
    attachments: (f.attachment ?? [])
      .filter((a) => /^\d+$/.test(String(a.id)))
      .map((a) => ({ id: String(a.id), filename: String(a.filename ?? ""), size: Number(a.size) || 0, mimeType: String(a.mimeType ?? "") })),
    links,
  };
}
