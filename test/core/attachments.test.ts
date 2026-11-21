import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchAttachments,
  safeAttachmentName,
  ATTACHMENT_LIMITS,
  type AttachmentMeta,
  type AttachmentDeps,
} from "../../src/core/attachments.ts";

const meta = (id: string, filename: string, size: number, mimeType = "application/octet-stream"): AttachmentMeta => ({ id, filename, size, mimeType });

describe("safeAttachmentName", () => {
  it("keeps a plain name", () => {
    expect(safeAttachmentName("1", "MC-1435-avatar.json")).toBe("MC-1435-avatar.json");
  });
  it("strips any path and unsafe characters, so a name can never leave the folder", () => {
    expect(safeAttachmentName("7", "../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentName("7", "a b/c\\d?.json")).toBe("d_.json");
    expect(safeAttachmentName("7", "..")).toBe("attachment-7");
    expect(safeAttachmentName("7", "")).toBe("attachment-7");
    expect(safeAttachmentName("7", ".envrc")).toBe("attachment-7-.envrc");
  });
  it("caps the length and keeps the extension", () => {
    const n = safeAttachmentName("1", `${"x".repeat(300)}.json`);
    expect(n.length).toBeLessThanOrEqual(120);
    expect(n.endsWith(".json")).toBe(true);
  });
});

describe("fetchAttachments", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "attachments-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function deps(list: AttachmentMeta[], o: Partial<AttachmentDeps> = {}): AttachmentDeps {
    return {
      list: vi.fn(async () => list),
      download: vi.fn(async (a: AttachmentMeta) => Buffer.from(`body of ${a.filename}`)),
      ...o,
    };
  }

  const manifest = async () => JSON.parse(await readFile(join(runDir, "attachments.json"), "utf8"));

  it("downloads allowed types into RUN_DIR/attachments and lists each one as fetched", async () => {
    const d = deps([meta("1", "avatar.json", 300_000, "text/plain"), meta("2", "mockup.png", 400_000, "image/png")]);
    const m = await fetchAttachments("MC-1", runDir, d);

    expect(await readFile(join(runDir, "attachments", "avatar.json"), "utf8")).toBe("body of avatar.json");
    expect(m).toEqual({
      ticket: "MC-1",
      dir: join(runDir, "attachments"),
      attachments: [
        { id: "1", filename: "avatar.json", size: 300_000, status: "fetched", path: join(runDir, "attachments", "avatar.json") },
        { id: "2", filename: "mockup.png", size: 400_000, status: "fetched", path: join(runDir, "attachments", "mockup.png") },
      ],
    });
    expect(await manifest()).toEqual(m);
  });

  it("skips a type outside the list, naming the reason, without downloading it", async () => {
    const d = deps([meta("1", "build.zip", 10, "application/zip"), meta("2", "notes.MD", 10)]);
    const m = await fetchAttachments("MC-1", runDir, d);
    expect(m.attachments[0]).toEqual({ id: "1", filename: "build.zip", size: 10, status: "skipped", reason: "type .zip is not fetched" });
    expect(m.attachments[1].status).toBe("fetched");
    expect(d.download).toHaveBeenCalledTimes(1);
  });

  it("skips a file over the per-file limit", async () => {
    const d = deps([meta("1", "huge.json", ATTACHMENT_LIMITS.maxFileBytes + 1)]);
    const m = await fetchAttachments("MC-1", runDir, d);
    expect(m.attachments[0]).toMatchObject({ status: "skipped", reason: `larger than ${ATTACHMENT_LIMITS.maxFileBytes} bytes` });
    expect(d.download).not.toHaveBeenCalled();
  });

  it("stops fetching once the per-ticket total would pass its limit", async () => {
    const big = ATTACHMENT_LIMITS.maxFileBytes;
    const n = Math.floor(ATTACHMENT_LIMITS.maxTotalBytes / big);
    const list = Array.from({ length: n + 1 }, (_, i) => meta(String(i), `f${i}.json`, big));
    const m = await fetchAttachments("MC-1", runDir, deps(list));
    expect(m.attachments.filter((a) => a.status === "fetched")).toHaveLength(n);
    expect(m.attachments.at(-1)).toMatchObject({ status: "skipped", reason: `the ticket's attachments pass ${ATTACHMENT_LIMITS.maxTotalBytes} bytes` });
  });

  it("a download larger than its listed size is refused, not written", async () => {
    const d = deps([meta("1", "a.json", 5)], { download: vi.fn(async () => Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1)) });
    const m = await fetchAttachments("MC-1", runDir, d);
    expect(m.attachments[0]).toMatchObject({ status: "failed", error: `download was larger than ${ATTACHMENT_LIMITS.maxFileBytes} bytes` });
    expect(await readdir(join(runDir, "attachments"))).toEqual([]);
  });

  it("a failed download is listed as failed with its error, and the others still fetch", async () => {
    const d = deps([meta("1", "a.json", 5), meta("2", "b.json", 5)], {
      download: vi.fn(async (a: AttachmentMeta) => {
        if (a.id === "1") throw new Error("Jira request failed: 403");
        return Buffer.from("ok");
      }),
    });
    const m = await fetchAttachments("MC-1", runDir, d);
    expect(m.attachments.map((a) => a.status)).toEqual(["failed", "fetched"]);
    expect(m.attachments[0]).toMatchObject({ error: "Jira request failed: 403" });
  });

  it("two attachments with the same name get distinct files", async () => {
    const m = await fetchAttachments("MC-1", runDir, deps([meta("1", "a.json", 5), meta("2", "a.json", 5)]));
    const paths = m.attachments.map((a) => (a.status === "fetched" ? a.path : ""));
    expect(new Set(paths).size).toBe(2);
    expect(paths[1]).toBe(join(runDir, "attachments", "2-a.json"));
  });

  it("a ticket with no attachments writes an empty manifest", async () => {
    const m = await fetchAttachments("MC-1", runDir, deps([]));
    expect(m.attachments).toEqual([]);
    expect(await manifest()).toEqual(m);
  });

  it("a failed listing writes a manifest with the error and never throws", async () => {
    const m = await fetchAttachments("MC-1", runDir, deps([], { list: vi.fn(async () => { throw new Error("Jira 503"); }) }));
    expect(m).toEqual({ ticket: "MC-1", dir: join(runDir, "attachments"), attachments: [], error: "Jira 503" });
    expect(await manifest()).toEqual(m);
  });

  it("clears files left from an earlier run in the same dir", async () => {
    await fetchAttachments("MC-1", runDir, deps([meta("1", "old.json", 5)]));
    await fetchAttachments("MC-1", runDir, deps([meta("2", "new.json", 5)]));
    expect(await readdir(join(runDir, "attachments"))).toEqual(["new.json"]);
  });

  it("redacts and caps error text", async () => {
    const d = deps([meta("1", "a.json", 5)], {
      download: vi.fn(async () => { throw new Error(`token=ghp_${"a".repeat(36)} ${"x".repeat(500)}`); }),
    });
    const m = await fetchAttachments("MC-1", runDir, d);
    const e = m.attachments[0].status === "failed" ? m.attachments[0].error : "";
    expect(e).not.toContain("ghp_aaaa");
    expect(e.length).toBeLessThanOrEqual(200);
  });
});
