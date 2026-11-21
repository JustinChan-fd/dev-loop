// fixture:save (eval fixtures): turn a real Jira ticket into a fixture's
// ticket.json + attachments/, read-only. It never writes to Jira and never
// runs git (a person reviews and commits). Scrubbing:
//   - redactSensitive on every text (emails, secret-shaped values);
//   - the home folder and any other absolute /Users|/home path made relative;
//   - each distinct author becomes user-N, in first-seen order;
//   - the real key becomes FX-<n> everywhere;
//   - pipeline comments (✅/❌ research-loop -) are marked is_pipeline.
// A text attachment that looks like it holds a secret refuses the whole save.
// Images can't be scrubbed, so the ticket is written reviewed: false and the
// runner refuses it until a person flips that.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { containsSecret, redactSensitive } from "../core/redact.ts";
import { FIXTURE_NAME, TICKET_KEY } from "../core/paths.ts";
import { FlagError } from "../core/flags.ts";
import { safeAttachmentName, type AttachmentMeta } from "../core/attachments.ts";
import { CONTRACT } from "../core/contract.ts";
import type { FixtureComment, FixtureTicket } from "./fixture.ts";

export interface RawComment {
  id: string;
  author: string;
  created: string;
  body: string;
}

export interface RawTicket {
  key: string;
  summary: string;
  issueType: string;
  description: string;
  comments: RawComment[];
  attachments: AttachmentMeta[];
  links: Array<{ key: string; summary: string; description: string; comments: RawComment[] }>;
}

const TEXT_EXT = new Set([".json", ".html", ".htm", ".txt", ".md", ".csv", ".xml", ".yaml", ".yml", ".log", ".svg"]);
const ABS_USER_PATH = /\/(?:Users|home)\/[^/\s"'`]+/g;

export function scrubText(text: string, o: { realKey: string; fxKey: string; home: string }): string {
  let t = o.home ? text.split(o.home).join("~") : text;
  t = t.replace(ABS_USER_PATH, "~");
  t = redactSensitive(t);
  return t.split(o.realKey).join(o.fxKey);
}

const isPipeline = (body: string): boolean => {
  const first = body.trimStart();
  return first.startsWith(CONTRACT.researchPass) || first.startsWith(CONTRACT.researchFail) || first.startsWith(`## ${CONTRACT.researchPass}`) || first.startsWith(`## ${CONTRACT.researchFail}`);
};

export function scrubTicket(raw: RawTicket, o: { fxNumber: number; home: string }): FixtureTicket {
  const fxKey = `FX-${o.fxNumber}`;
  const s = (t: string) => scrubText(t, { realKey: raw.key, fxKey, home: o.home });
  const authors = new Map<string, string>();
  const author = (a: string) => {
    if (!authors.has(a)) authors.set(a, `user-${authors.size + 1}`);
    return authors.get(a)!;
  };
  const comment = (c: RawComment): FixtureComment => ({ id: c.id, author: author(c.author), is_pipeline: isPipeline(c.body), created: c.created, body: s(c.body) });
  const comments = raw.comments.map(comment);
  const linked: FixtureTicket["linked"] = {};
  for (const l of raw.links) linked[l.key] = { summary: s(l.summary), description: s(l.description), comments: l.comments.map(comment) };
  return {
    key: fxKey,
    summary: s(raw.summary),
    issue_type: raw.issueType,
    description: s(raw.description),
    comments,
    github: { title: "", comments: [], not_planned: [] },
    linked,
    prior_tickets: [],
    attachments: raw.attachments.map((a) => ({ id: String(a.id), filename: safeAttachmentName(String(a.id), a.filename), size: a.size, mimeType: a.mimeType })),
    reviewed: false,
  };
}

export interface SaveArgs {
  key: string;
  name: string;
  fx: number;
  force: boolean;
}

export function parseSaveArgs(argv: string[]): SaveArgs {
  let key: string | undefined;
  let name: string | undefined;
  let fx = 1;
  let force = false;
  for (const a of argv) {
    if (a === "--force") force = true;
    else if (a.startsWith("--name=")) name = a.slice(7);
    else if (a.startsWith("--fx=")) {
      fx = Number(a.slice(5));
      if (!Number.isInteger(fx) || fx < 1) throw new FlagError(`--fx must be a whole number >= 1, got ${JSON.stringify(a.slice(5))}`);
    } else if (!a.startsWith("--") && key === undefined) key = a;
    else throw new FlagError(`unknown argument ${JSON.stringify(a)} (usage: <KEY> --name=<fixture> [--fx=<n>] [--force])`);
  }
  if (key === undefined || !TICKET_KEY.test(key)) throw new FlagError(`a Jira key is required (e.g. MC-1718), got ${JSON.stringify(key)}`);
  if (name === undefined || !FIXTURE_NAME.test(name)) throw new FlagError(`--name=<fixture> is required and must match ${FIXTURE_NAME}`);
  return { key, name, fx, force };
}

export interface SaveDeps {
  fixturesDir: string;
  home: string;
  /** Read-only Jira read of the ticket (jira-read.ts in production). */
  read: (key: string) => Promise<RawTicket>;
  download: (a: AttachmentMeta) => Promise<Buffer>;
  log: (m: string) => void;
}

export async function saveFixture(a: SaveArgs, d: SaveDeps): Promise<{ ok: true; dir: string; missing: string[] } | { ok: false; error: string }> {
  const dir = join(d.fixturesDir, a.name);
  if (existsSync(join(dir, "ticket.json")) && !a.force) return { ok: false, error: `${a.name}/ticket.json already exists; pass --force to replace it` };
  const raw = await d.read(a.key);
  const ticket = scrubTicket(raw, { fxNumber: a.fx, home: d.home });
  const fxKey = ticket.key;

  // Download and scrub everything in memory first: a refused save writes nothing.
  const files: Array<{ name: string; body: Buffer }> = [];
  const missing: string[] = [];
  for (let i = 0; i < raw.attachments.length; i++) {
    const meta = raw.attachments[i]!;
    const name = ticket.attachments[i]!.filename;
    let body: Buffer;
    try {
      body = await d.download(meta);
    } catch (err) {
      missing.push(name);
      d.log(`[fixture:save] ${name}: not downloaded (${err instanceof Error ? err.message : String(err)}); it stays in ticket.json as a failed entry`);
      continue;
    }
    if (TEXT_EXT.has(extname(name).toLowerCase())) {
      const text = body.toString("utf8");
      if (containsSecret(text)) return { ok: false, error: `attachment ${name} looks like it holds a secret; refusing the save (nothing written). Remove it from the ticket or save by hand.` };
      body = Buffer.from(scrubText(text, { realKey: a.key, fxKey, home: d.home }));
    }
    files.push({ name, body });
  }

  await mkdir(dir, { recursive: true });
  await rm(join(dir, "attachments"), { recursive: true, force: true });
  await mkdir(join(dir, "attachments"));
  for (const f of files) await writeFile(join(dir, "attachments", f.name), f.body);
  await writeFile(join(dir, "ticket.json"), JSON.stringify(ticket, null, 2) + "\n");
  d.log(`[fixture:save] wrote ${a.name}/ticket.json (${fxKey}, reviewed: false) and ${files.length} attachment(s). Read them, set reviewed: true, then git add by hand.`);
  return { ok: true, dir, missing };
}
