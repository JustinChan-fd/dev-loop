/**
 * Ticket attachments for the agents (both roles, every project).
 *
 * Before each spawn the loop downloads the ticket's Jira attachments on the
 * host, with the Jira credentials it already holds, into
 * `RUN_DIR/attachments/`, and writes `RUN_DIR/attachments.json` naming every
 * attachment as fetched (with its path), skipped (with the reason) or failed
 * (with the error). The agent reads plain files: no new tool, network rule
 * or token reaches it, and it works the same with or without a sandbox.
 *
 * Mechanical and fixed: only the types in FETCHED_EXTENSIONS, at most
 * maxFileBytes each and maxTotalBytes per ticket. Never throws: a failed
 * listing or download is written into the manifest, and the agent decides
 * whether the ticket still holds without it (a bounce beats a guess).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { redactSensitive } from "./redact.ts";

export const ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
});

/** Text-like files and images the agents can read. Compared lowercase. */
export const FETCHED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".json", ".html", ".htm", ".txt", ".md", ".csv", ".xml", ".yaml", ".yml", ".log",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
]);

const MAX_NAME = 120;
const MAX_ERROR = 200;

export interface AttachmentMeta {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
}

export type AttachmentEntry =
  | { id: string; filename: string; size: number; status: "fetched"; path: string }
  | { id: string; filename: string; size: number; status: "skipped"; reason: string }
  | { id: string; filename: string; size: number; status: "failed"; error: string };

export interface AttachmentManifest {
  ticket: string;
  dir: string;
  attachments: AttachmentEntry[];
  /** Set when the attachment list itself could not be read. */
  error?: string;
}

export interface AttachmentDeps {
  list: (ticketKey: string) => Promise<AttachmentMeta[]>;
  download: (a: AttachmentMeta) => Promise<Buffer>;
}

const errorText = (err: unknown): string =>
  redactSensitive(err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR);

/**
 * A file name that stays inside the attachments folder: the last path
 * segment only, unsafe characters as "_", no leading dot (so no .envrc), at
 * most MAX_NAME chars with the extension kept. Empty or "."/".." falls back
 * to `attachment-<id>`.
 */
export function safeAttachmentName(id: string, filename: string): string {
  const last = basename(String(filename).replace(/\\/g, "/"));
  let name = last.replace(/[^A-Za-z0-9._-]/g, "_");
  if (name === "" || /^\.+$/.test(name)) return `attachment-${id}`;
  if (name.startsWith(".")) name = `attachment-${id}-${name}`;
  if (name.length > MAX_NAME) {
    const ext = extname(name).slice(0, 16);
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  return name;
}

export async function fetchAttachments(ticketKey: string, runDir: string, deps: AttachmentDeps): Promise<AttachmentManifest> {
  const dir = join(runDir, "attachments");
  const manifest: AttachmentManifest = { ticket: ticketKey, dir, attachments: [] };
  const write = async () => {
    await writeFile(join(runDir, "attachments.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  };

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  let list: AttachmentMeta[];
  try {
    list = await deps.list(ticketKey);
  } catch (err) {
    manifest.error = errorText(err);
    return write();
  }

  const used = new Set<string>();
  let total = 0;
  for (const a of list) {
    const base = { id: String(a.id), filename: String(a.filename), size: Number(a.size) || 0 };
    const ext = extname(base.filename).toLowerCase();
    if (!FETCHED_EXTENSIONS.has(ext)) {
      manifest.attachments.push({ ...base, status: "skipped", reason: `type ${ext || "(none)"} is not fetched` });
      continue;
    }
    if (base.size > ATTACHMENT_LIMITS.maxFileBytes) {
      manifest.attachments.push({ ...base, status: "skipped", reason: `larger than ${ATTACHMENT_LIMITS.maxFileBytes} bytes` });
      continue;
    }
    if (total + base.size > ATTACHMENT_LIMITS.maxTotalBytes) {
      manifest.attachments.push({ ...base, status: "skipped", reason: `the ticket's attachments pass ${ATTACHMENT_LIMITS.maxTotalBytes} bytes` });
      continue;
    }

    let name = safeAttachmentName(base.id, base.filename);
    if (used.has(name)) name = safeAttachmentName(base.id, `${base.id}-${name}`);
    try {
      const body = await deps.download(a);
      if (body.length > ATTACHMENT_LIMITS.maxFileBytes) throw new Error(`download was larger than ${ATTACHMENT_LIMITS.maxFileBytes} bytes`);
      const path = join(dir, name);
      await writeFile(path, body);
      used.add(name);
      total += Math.max(body.length, base.size);
      manifest.attachments.push({ ...base, status: "fetched", path });
    } catch (err) {
      manifest.attachments.push({ ...base, status: "failed", error: errorText(err) });
    }
  }
  return write();
}
