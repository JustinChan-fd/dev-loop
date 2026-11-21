/**
 * The run watcher: a local, read-only live page of dev-loop's v2 runs.
 *
 *   npm run dashboard [-- --project=<name>] [--port=<n>] [--root=<dir>]
 *
 * A thin shell over read.ts (disk, read-only) and model.ts (pure). It binds
 * to 127.0.0.1, serves one HTML page, `/snapshot` (JSON), `/events` (SSE: the
 * snapshot again whenever it changes) and `/log?run=<run dir>` (one run's
 * grouped log, only for a run in the current snapshot). It watches
 * `runs/v2`, each project's `sessions/` dir and every live run dir with
 * fs.watch, and re-reads every POLL_MS as a fallback. It never writes a
 * file, touches a lock, or calls Jira or GitHub. Spec:
 * docs/superpowers/specs/2026-11-20-run-watcher-design.md.
 */

import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { FlagError, parseFlags } from "../core/flags.ts";
import { v2RunsLog, v2SessionsDir } from "../core/paths.ts";
import { isProcessAlive } from "../core/session.ts";
import { jiraBaseFrom, liveDirs, loadProjects, readRunLog, readSnapshot, readStepLists, type ProgressCache, type Snapshot } from "./read.ts";

export const DEFAULT_PORT = 4317;
const HOST = "127.0.0.1";
const POLL_MS = 2000;
const HEARTBEAT_MS = 15_000;
const REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Where the runs are when --root isn't given: this checkout, or, from a git
 * worktree (.git is a file), the main checkout the worktree belongs to. A
 * worktree's own runs/ and .pipeline/ are empty; the loop writes to the main one.
 */
export function defaultRoot(checkout: string): string {
  try {
    const dotGit = join(checkout, ".git");
    if (statSync(dotGit).isDirectory()) return checkout;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    const i = m ? m[1].lastIndexOf("/.git/worktrees/") : -1;
    return i > 0 ? m![1].slice(0, i) : checkout;
  } catch {
    return checkout;
  }
}

export interface DashboardArgs {
  project?: string;
  port: number;
  root: string;
}

/** `--project=<name> --port=<n> --root=<dir>`; throws FlagError on anything else. */
export function parseDashboardArgs(argv: readonly string[]): DashboardArgs {
  const f = parseFlags(argv, { values: ["--project", "--port", "--root"], bools: [] }, "dashboard");
  const portRaw = f.values["--port"];
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FlagError(`dashboard: --port=${portRaw} must be a port number (1-65535)`);
  const out: DashboardArgs = { port, root: resolve(f.values["--root"] ?? defaultRoot(REPO_ROOT)) };
  if (f.values["--project"] !== undefined) out.project = f.values["--project"];
  return out;
}

export interface DashboardOptions {
  root: string;
  project?: string;
  /** 0 picks a free port (tests). */
  port: number;
  pollMs?: number;
  /** The Jira site for ticket links; defaults to JIRA_BASE_URL from the environment. */
  jiraBase?: string | null;
  log?: (m: string) => void;
}

export interface Dashboard {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** The snapshot without its clock, to tell whether anything changed. */
const fingerprint = (s: Snapshot) => JSON.stringify({ ...s, now: 0 });

export async function startDashboard(o: DashboardOptions): Promise<Dashboard> {
  const log = o.log ?? (() => {});
  const { projects, warnings: projectWarnings } = await loadProjects(o.root, o.project);
  const steps = await readStepLists(o.root);
  const jiraBase = o.jiraBase !== undefined ? o.jiraBase : jiraBaseFrom(process.env.JIRA_BASE_URL);
  const page = await readFile(join(import.meta.dirname, "page.html"), "utf8");
  const cache: ProgressCache = new Map();

  let snap: Snapshot | null = null;
  let last = "";
  let reading: Promise<void> | null = null;
  let again = false;
  const clients = new Set<ServerResponse>();
  const watchers = new Map<string, FSWatcher>();

  const send = (res: ServerResponse, s: Snapshot) => res.write(`data: ${JSON.stringify(s)}\n\n`);

  function watchDir(dir: string): void {
    if (watchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, () => refresh());
      w.on("error", () => {
        w.close();
        watchers.delete(dir);
      });
      watchers.set(dir, w);
    } catch {
      // Not there yet (no runs, or no sessions dir): the poll covers it, and a later refresh retries.
    }
  }

  function syncWatches(s: Snapshot): void {
    const want = new Set([
      ...projects.map((p) => join(o.root, dirname(v2RunsLog(p.slug)))),
      ...projects.map((p) => join(o.root, v2SessionsDir(p.slug))),
      ...liveDirs(s, o.root),
    ]);
    for (const [dir, w] of watchers) if (!want.has(dir)) (w.close(), watchers.delete(dir));
    for (const dir of want) watchDir(dir);
  }

  async function readOnce(): Promise<void> {
    const s = await readSnapshot({ root: o.root, projects, steps, now: Date.now(), isAlive: isProcessAlive, jiraBase, cache });
    s.warnings = [...projectWarnings, ...s.warnings];
    snap = s;
    syncWatches(s);
    const fp = fingerprint(s);
    if (fp === last) return;
    last = fp;
    for (const c of clients) send(c, s);
  }

  /** Re-read now; events that arrive mid-read coalesce into one more read. */
  function refresh(): Promise<void> {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      try {
        do {
          again = false;
          await readOnce();
        } while (again);
      } catch (e) {
        log(`[dashboard] read failed: ${(e as Error).message}`);
      } finally {
        reading = null;
      }
    })();
    return reading;
  }

  await refresh();
  const poll = setInterval(() => void refresh(), o.pollMs ?? POLL_MS);
  const beat = setInterval(() => {
    for (const c of clients) c.write(": keep-alive\n\n");
  }, HEARTBEAT_MS);

  let port = o.port;
  const hostOk = (h: string | undefined) => h === `${HOST}:${port}` || h === `localhost:${port}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!hostOk(req.headers.host)) return void res.writeHead(403).end("forbidden host\n");
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { Allow: "GET" }).end();
    const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      });
      return void res.end(page);
    }
    if (url.pathname === "/snapshot") {
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(snap));
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      clients.add(res);
      req.on("close", () => clients.delete(res));
      if (snap) send(res, snap);
      return;
    }
    if (url.pathname === "/log") {
      const id = url.searchParams.get("run");
      const body = id && snap ? await readRunLog(snap, o.root, id, Date.now()) : null;
      if (!body) return void res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"no such run"}');
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    }
    res.writeHead(404).end("not found\n");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`[dashboard] ${req.url}: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(o.port, HOST, () => ok());
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : o.port;

  return {
    url: `http://${HOST}:${port}/`,
    port,
    close: async () => {
      clearInterval(poll);
      clearInterval(beat);
      for (const w of watchers.values()) w.close();
      watchers.clear();
      for (const c of clients) c.end();
      clients.clear();
      await new Promise<void>((ok) => server.close(() => ok()));
      server.closeAllConnections();
    },
  };
}

async function main(): Promise<void> {
  let args: DashboardArgs;
  try {
    args = parseDashboardArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof FlagError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
  let d: Dashboard;
  try {
    d = await startDashboard({ ...args, log: (m) => console.error(m) });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    console.error(code === "EADDRINUSE" ? `[dashboard] port ${args.port} is in use; try --port=<n>` : `[dashboard] ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`[dashboard] run watcher at ${d.url} (read-only; v2 logs under ${args.root}; Ctrl-C to stop)`);
  const stop = () => void d.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
