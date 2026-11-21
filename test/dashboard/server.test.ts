import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, defaultRoot, parseDashboardArgs, startDashboard } from "../../src/dashboard/server.ts";

let root: string;
let srv: { url: string; port: number; close: () => Promise<void> } | null = null;
const RD = ".pipeline/v2/web/dev-1/TARS-1/dev-20261121T010000Z";
const jl = (...xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
const rec = (ticket: string, runDir: string) => ({
  ticket, session: "dev-1", started: "2026-11-21T01:00:00Z", ended: "2026-11-21T01:10:00Z", outcome: "landed",
  phases: [{ role: "dev", skill: "ticket-to-pr", started: "2026-11-21T01:00:00Z", ended: "2026-11-21T01:10:00Z", outcome: "landed",
    phase_reached: "pr", cost_usd: 1, failure_category: null, detail: "PR opened", pr: null, run_dir: runDir }],
});

async function put(rel: string, body: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), body);
}

/** GET with a chosen Host header (fetch can't set one). */
function get(path: string, host?: string, method = "GET"): Promise<{ status: number; type: string; body: string }> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port: srv!.port, path, method, headers: host ? { Host: host } : {} }, (m) => {
      let body = "";
      m.setEncoding("utf8");
      m.on("data", (c) => (body += c));
      m.on("end", () => res({ status: m.statusCode ?? 0, type: String(m.headers["content-type"] ?? ""), body }));
    });
    r.on("error", rej);
    r.end();
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dash-srv-"));
  await put("pipeline.web.config.json", JSON.stringify({ targetRepo: { url: "git@github.com:org/web.git" }, github: { repo: "org/web" } }));
  await put("runs/v2/web.jsonl", jl(rec("TARS-1", RD)));
  await put(`${RD}/progress.jsonl`, jl({ ts: "2026-11-21T01:00:10Z", phase: "intake", event: "phase_start", detail: "intake <b>x</b>" }));
  srv = await startDashboard({ root, port: 0, pollMs: 100, jiraBase: null });
});
afterEach(async () => {
  await srv?.close();
  srv = null;
  await rm(root, { recursive: true, force: true });
});

describe("parseDashboardArgs", () => {
  it("defaults: port 4317, every project, this checkout's root", () => {
    const a = parseDashboardArgs([]);
    expect(DEFAULT_PORT).toBe(4317);
    expect(a.port).toBe(4317);
    expect(a.project).toBeUndefined();
    expect(a.root).toMatch(/run-watcher$|dev-loop$/);
  });
  it("reads --project, --port and --root", () => {
    expect(parseDashboardArgs(["--project=web", "--port=5000", "--root=/tmp/x"])).toEqual({ project: "web", port: 5000, root: "/tmp/x" });
  });
  it("refuses a bad port, the old --key value form and unknown flags", () => {
    for (const argv of [["--port=abc"], ["--port=0"], ["--port=70000"], ["--port", "5000"], ["--watch"]]) {
      expect(() => parseDashboardArgs(argv)).toThrow();
    }
  });
});

describe("startDashboard", () => {
  it("binds to 127.0.0.1", () => {
    expect(srv!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("serves the page, with no mockup demo data or chrome", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/text\/html/);
    expect(r.body).toContain("Run watcher");
    for (const demo of ["your-site.atlassian.net", "const REPO", "const ISSUE", "Pause demo", "data-theme", "fonts.googleapis", "seedToday", "Scenario"]) {
      expect(r.body).not.toContain(demo);
    }
  });

  it("serves the snapshot as JSON", async () => {
    const r = await get("/snapshot");
    expect(r.status).toBe(200);
    const s = JSON.parse(r.body);
    expect(s.runs.map((x: { ticket: string }) => x.ticket)).toEqual(["TARS-1"]);
    expect(s.projects).toEqual([{ name: "web", slug: "web", repo: "org/web" }]);
  });

  it("serves one run's log, and 404s a run that isn't in the snapshot", async () => {
    const ok = await get(`/log?run=${encodeURIComponent(RD)}`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).groups[0].lines[0].detail).toBe("intake <b>x</b>");
    expect((await get(`/log?run=${encodeURIComponent("../../.env")}`)).status).toBe(404);
    expect((await get("/log")).status).toBe(404);
  });

  it("refuses a foreign Host (DNS rebinding), other methods and unknown paths", async () => {
    expect((await get("/snapshot", "evil.example:80")).status).toBe(403);
    expect((await get("/snapshot", `localhost:${srv!.port}`)).status).toBe(200);
    expect((await get("/snapshot", undefined, "POST")).status).toBe(405);
    expect((await get("/nope")).status).toBe(404);
  });

  it("pushes the snapshot over SSE, and again when the log changes", async () => {
    const events: string[] = [];
    const done = new Promise<void>((res, rej) => {
      const r = request({ host: "127.0.0.1", port: srv!.port, path: "/events" }, (m) => {
        expect(m.headers["content-type"]).toMatch(/text\/event-stream/);
        let buf = "";
        m.setEncoding("utf8");
        m.on("data", async (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const msg = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!msg.startsWith("data: ")) continue;
            events.push(msg);
            const n = JSON.parse(msg.slice(6)).runs.length;
            if (events.length === 1) {
              expect(n).toBe(1);
              await appendFile(join(root, "runs/v2/web.jsonl"), jl(rec("TARS-2", ".pipeline/v2/web/dev-1/TARS-2/dev-20261121T010000Z")));
            } else if (n === 2) {
              r.destroy();
              res();
            }
          }
        });
      });
      r.on("error", (e) => (events.length ? undefined : rej(e)));
      r.end();
    });
    await done;
    expect(events.length).toBeGreaterThanOrEqual(2);
  }, 10_000);
});

describe("defaultRoot", () => {
  let base: string;
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "dash-root-")); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it("in the main checkout (.git is a folder), is that checkout", async () => {
    await mkdir(join(base, "main/.git"), { recursive: true });
    expect(defaultRoot(join(base, "main"))).toBe(join(base, "main"));
  });
  it("in a worktree (.git is a file), is the main checkout, where the runs are", async () => {
    await mkdir(join(base, "main/.git/worktrees/run-watcher"), { recursive: true });
    await mkdir(join(base, "main/.worktrees/run-watcher"), { recursive: true });
    await writeFile(join(base, "main/.worktrees/run-watcher/.git"), `gitdir: ${join(base, "main/.git/worktrees/run-watcher")}\n`);
    expect(defaultRoot(join(base, "main/.worktrees/run-watcher"))).toBe(join(base, "main"));
  });
  it("falls back to the checkout itself when .git is missing or unreadable", async () => {
    await mkdir(join(base, "plain"), { recursive: true });
    expect(defaultRoot(join(base, "plain"))).toBe(join(base, "plain"));
    await writeFile(join(base, "plain/.git"), "not a gitdir line\n");
    expect(defaultRoot(join(base, "plain"))).toBe(join(base, "plain"));
  });
});

describe("the page's run summary", () => {
  it("clamps the text inside the box, so a long note never shows a cut-off line", async () => {
    const r = await get("/");
    const css = r.body.match(/<style>([\s\S]*?)<\/style>/)![1];
    const rule = (sel: string) => css.match(new RegExp(sel.replace(/[.]/g, "\\.") + "\\{([^}]*)\\}"))?.[1] ?? "";
    expect(rule(".card .note")).not.toMatch(/line-clamp/);
    expect(rule(".card .note .txt")).toMatch(/line-clamp:2/);
    expect(r.body).toMatch(/<span class="txt">/);
  });
  it("opens the full note on click and closes it again", async () => {
    const r = await get("/");
    expect(r.body).toMatch(/data-note=/);
    expect(r.body).toMatch(/\.card \.note\.full \.txt\{[^}]*line-clamp:unset/);
  });
});
