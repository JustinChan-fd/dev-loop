/**
 * `npm run fixture:save -- <KEY> --name=<fixture> [--fx=<n>] [--force]`
 * Read-only: GETs the ticket, its comments, links and attachments from Jira
 * with the loop's credentials (JIRA_* from the env file npm passes), scrubs
 * them (fixture-save.ts) and writes evals/fixtures/<name>/ticket.json and
 * attachments/. Never writes to Jira, never runs git. The untested
 * composition root; the logic is fixture-save.ts and jira-read.ts.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { credentialsFromEnv } from "../core/jira-client.ts";
import { ATTACHMENT_LIMITS } from "../core/attachments.ts";
import { redactSensitive } from "../core/redact.ts";
import { FlagError } from "../core/flags.ts";
import { parseSaveArgs, saveFixture } from "./fixture-save.ts";
import { readTicket } from "./jira-read.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

async function main(): Promise<number> {
  const args = parseSaveArgs(process.argv.slice(2));
  const c = credentialsFromEnv();
  const auth = `Basic ${Buffer.from(`${c.email}:${c.apiToken}`).toString("base64")}`;
  const request = async (path: string, accept: string): Promise<Response> => {
    const r = await fetch(`${c.baseUrl}${path}`, { method: "GET", headers: { Authorization: auth, Accept: accept }, redirect: "follow" });
    if (!r.ok) throw new Error(`Jira GET ${path} -> ${r.status} ${r.statusText}`);
    return r;
  };
  const r = await saveFixture(args, {
    fixturesDir: join(REPO_ROOT, "evals", "fixtures"),
    home: homedir(),
    read: (key) => readTicket(key, async (p) => (await request(p, "application/json")).json()),
    download: async (a) => {
      if (!/^\d+$/.test(a.id)) throw new Error(`invalid attachment id ${JSON.stringify(a.id)}`);
      if (a.size > ATTACHMENT_LIMITS.maxFileBytes) throw new Error(`larger than ${ATTACHMENT_LIMITS.maxFileBytes} bytes`);
      return Buffer.from(await (await request(`/rest/api/3/attachment/content/${a.id}`, "*/*")).arrayBuffer());
    },
    log: (m) => console.log(redactSensitive(m)),
  });
  if (!r.ok) {
    console.error(redactSensitive(`[fixture:save] refused: ${r.error}`));
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof FlagError) console.error(err.message);
    else console.error(redactSensitive(`[fixture:save] fatal: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  },
);
