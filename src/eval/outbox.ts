// The Jira client a fixture run hands runResearchPhase (eval fixtures). The
// loop's own writes (a refused-verdict comment, the blocked comment, the
// bounce transition) land in RUN_DIR/outbox/loop-NNN-<action>.json instead of
// Jira; every other method throws. Writes to any key but the fixture's are
// refused, so a stray real key can never reach anything.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StubJiraClient } from "../core/jira-client.ts";

export interface OutboxWrite {
  surface: "jira";
  action: "comment" | "transition";
  target: string;
  body?: Record<string, unknown>;
  to?: string;
}

export class OutboxJiraClient extends StubJiraClient {
  readonly writes: OutboxWrite[] = [];
  private readonly runDir: string;
  private readonly key: string;

  constructor(runDir: string, key: string) {
    super();
    this.runDir = runDir;
    this.key = key;
  }

  private async put(w: OutboxWrite): Promise<void> {
    if (w.target !== this.key) throw new Error(`OutboxJiraClient: fixture mode writes only to ${this.key}, not ${JSON.stringify(w.target)}`);
    const dir = join(this.runDir, "outbox");
    await mkdir(dir, { recursive: true });
    this.writes.push(w);
    const seq = String(this.writes.length).padStart(3, "0");
    await writeFile(join(dir, `loop-${seq}-${w.action}.json`), JSON.stringify(w, null, 2) + "\n");
  }

  override async addComment(ticketKey: string, body: Record<string, unknown>): Promise<void> {
    await this.put({ surface: "jira", action: "comment", target: ticketKey, body });
  }

  override async transitionStatus(ticketKey: string, to: string): Promise<void> {
    await this.put({ surface: "jira", action: "transition", target: ticketKey, to });
  }
}

// Every other JiraClient method: a fixture run has no Jira.
for (const m of ["pollOldestMatching", "pollAllMatching", "claimTicket", "swapLabel", "removeLabel", "assignTicket", "closeTicket", "getStatus", "getStatusDetail", "getBlockedBy", "listComments", "deleteComment", "getLabels"] as const) {
  Object.defineProperty(OutboxJiraClient.prototype, m, {
    value: async () => {
      throw new Error(`OutboxJiraClient.${m}: not available in fixture mode (no Jira)`);
    },
    writable: true,
    configurable: true,
  });
}

/** Every file in RUN_DIR/outbox (the skill's and the loop's), sorted by name; [] when there is none. */
export async function readOutbox(runDir: string): Promise<Array<{ file: string; text: string }>> {
  const dir = join(runDir, "outbox");
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (file) => ({ file, text: await readFile(join(dir, file), "utf8") })));
}
