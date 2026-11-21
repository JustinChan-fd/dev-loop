// An eval fixture (evals/fixtures/<name>/): a ticket kept in local files, a
// pinned target-repo commit and the facts to grade. Validators only: they
// never throw, and loadFixture collects every problem so a person fixes the
// fixture in one pass. The runner refuses anything not ok.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURE_NAME, PROJECT_SLUG } from "../core/paths.ts";
import { validateExpectation, type Expectation } from "./grade-fixture.ts";

/** Fixture tickets get fake keys, so nothing can be mistaken for (or written to) a real ticket. */
export const FIXTURE_KEY = /^FX-\d+$/;
/** A plain attachment file name: no path, no leading dot. */
const PLAIN_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/;
const SHA = /^[0-9a-f]{7,40}$/;

export interface FixtureComment {
  id: string;
  author: string;
  /** True for the pipeline's own ✅/❌ research-loop comments. */
  is_pipeline: boolean;
  created: string;
  body: string;
}

export interface FixtureAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface FixtureTicket {
  key: string;
  summary: string;
  issue_type: string;
  description: string;
  comments: FixtureComment[];
  /** The mirror GitHub Issue as the skill would read it. */
  github: { title: string; comments: Array<{ author: string; created: string; body: string }>; not_planned: Array<{ number: number; comments: Array<{ author: string; created: string; body: string }> }> };
  linked: Record<string, { summary: string; description: string; comments: FixtureComment[] }>;
  prior_tickets: Array<{ key: string; summary: string; description: string }>;
  attachments: FixtureAttachment[];
  /** A person read the scrubbed ticket and its attachments (images can't be scrubbed). */
  reviewed: boolean;
}

export interface RepoPin {
  /** A pipeline.<project>.config.json name. */
  project: string;
  /** 7 to 40 lowercase hex; null until known. */
  sha: string | null;
  /** A person confirmed the sha on the host. */
  verified: boolean;
  /** The read-only command that confirms it. */
  verify_cmd?: string;
}

export interface Fixture {
  name: string;
  dir: string;
  ticket: FixtureTicket;
  repo: RepoPin & { sha: string };
  expect: Expectation;
}

type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

function comment(errors: string[], at: string, c: unknown): void {
  if (!isObj(c) || !str(c.id) || !str(c.author) || typeof c.is_pipeline !== "boolean" || !str(c.created) || !str(c.body)) {
    errors.push(`${at} must be {id, author, is_pipeline (boolean), created, body}`);
  }
}

export function validateTicket(raw: unknown): Result<FixtureTicket> {
  if (!isObj(raw)) return { ok: false, errors: ["ticket.json must be a JSON object"] };
  const errors: string[] = [];
  if (!str(raw.key) || !FIXTURE_KEY.test(raw.key)) errors.push(`key must be a fake FX-<n> key, got ${JSON.stringify(raw.key)}`);
  for (const k of ["summary", "issue_type", "description"]) if (!str(raw[k])) errors.push(`${k} must be a string`);
  if (typeof raw.reviewed !== "boolean") errors.push("reviewed must be true or false");
  const comments = raw.comments ?? [];
  if (!Array.isArray(comments)) errors.push("comments must be a list");
  else comments.forEach((c, i) => comment(errors, `comments[${i}]`, c));
  const attachments = raw.attachments ?? [];
  if (!Array.isArray(attachments)) errors.push("attachments must be a list");
  else {
    attachments.forEach((a, i) => {
      if (!isObj(a) || !str(a.id) || !str(a.filename) || !PLAIN_FILE.test(a.filename) || typeof a.size !== "number" || !str(a.mimeType)) {
        errors.push(`attachments[${i}] must be {id, filename (a plain file name), size, mimeType}`);
      }
    });
  }
  const github = raw.github ?? { title: "", comments: [], not_planned: [] };
  if (!isObj(github)) errors.push("github must be {title, comments, not_planned}");
  const linked = raw.linked ?? {};
  if (!isObj(linked)) errors.push("linked must be {KEY: {summary, description, comments}}");
  const prior = raw.prior_tickets ?? [];
  if (!Array.isArray(prior)) errors.push("prior_tickets must be a list");
  if (errors.length > 0) return { ok: false, errors };
  const g = github as Record<string, unknown>;
  return {
    ok: true,
    value: {
      ...(raw as unknown as FixtureTicket),
      comments: comments as FixtureComment[],
      attachments: attachments as FixtureAttachment[],
      github: { title: str(g.title) ? g.title : "", comments: Array.isArray(g.comments) ? (g.comments as never) : [], not_planned: Array.isArray(g.not_planned) ? (g.not_planned as never) : [] },
      linked: linked as FixtureTicket["linked"],
      prior_tickets: prior as FixtureTicket["prior_tickets"],
    },
  };
}

export function validateRepoPin(raw: unknown): Result<RepoPin> {
  if (!isObj(raw)) return { ok: false, errors: ["repo.json must be a JSON object"] };
  const errors: string[] = [];
  if (!str(raw.project) || !PROJECT_SLUG.test(raw.project)) errors.push(`project must be a project name, got ${JSON.stringify(raw.project)}`);
  if (raw.sha !== null && (!str(raw.sha) || !SHA.test(raw.sha))) errors.push(`sha must be 7 to 40 lowercase hex characters or null, got ${JSON.stringify(raw.sha)}`);
  if (typeof raw.verified !== "boolean") errors.push("verified must be true or false");
  if (raw.verified === true && raw.sha === null) errors.push("verified is true but sha is null");
  if (raw.verify_cmd !== undefined && !str(raw.verify_cmd)) errors.push("verify_cmd must be a string");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: raw as unknown as RepoPin };
}

async function readJson(path: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, error: "missing" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
}

/** Reads evals/fixtures/<name>/ (under `root`) and refuses anything the runner must not run. */
export async function loadFixture(root: string, name: string): Promise<{ ok: true; fixture: Fixture } | { ok: false; problems: string[] }> {
  if (!FIXTURE_NAME.test(name)) return { ok: false, problems: [`fixture name ${JSON.stringify(name)} must match ${FIXTURE_NAME}`] };
  const dir = join(root, name);
  const problems: string[] = [];

  let ticket: FixtureTicket | undefined;
  const t = await readJson(join(dir, "ticket.json"));
  if (!t.ok) problems.push(`ticket.json: ${t.error}. Save it with \`npm run fixture:save -- <KEY> --name=${name}\` (see evals/README.md, "Fixture evals")`);
  else {
    const v = validateTicket(t.value);
    if (!v.ok) problems.push(...v.errors.map((e) => `ticket.json: ${e}`));
    else if (!v.value.reviewed) problems.push("ticket.json: reviewed is false. Read the scrubbed ticket and its attachments, then set reviewed: true");
    else ticket = v.value;
  }

  let repo: RepoPin | undefined;
  const r = await readJson(join(dir, "repo.json"));
  if (!r.ok) problems.push(`repo.json: ${r.error}`);
  else {
    const v = validateRepoPin(r.value);
    if (!v.ok) problems.push(...v.errors.map((e) => `repo.json: ${e}`));
    else if (!v.value.verified || v.value.sha === null) {
      problems.push(`repo.json: the pin is UNVERIFIED (sha ${v.value.sha ?? "null"}). Confirm it on the host: ${v.value.verify_cmd ?? "(no verify_cmd)"}`);
    } else repo = v.value;
  }

  let exp: Expectation | undefined;
  const e = await readJson(join(dir, "expect.json"));
  if (!e.ok) problems.push(`expect.json: ${e.error}`);
  else {
    const v = validateExpectation(e.value);
    if (!v.ok) problems.push(...v.errors.map((x) => `expect.json: ${x}`));
    else exp = v.expectation;
  }

  if (problems.length > 0 || !ticket || !repo || !exp) return { ok: false, problems };
  return { ok: true, fixture: { name, dir, ticket, repo: repo as RepoPin & { sha: string }, expect: exp } };
}
