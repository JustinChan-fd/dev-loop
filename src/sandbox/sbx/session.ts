// `npm run claude:sbx`: Claude Code on dev-loop's own code, inside an sbx
// sandbox. The pure decisions live here, with tests; scripts/claude-sbx.mjs
// only runs them. Design: docs/superpowers/specs/2026-11-20-claude-sbx-design.md.
//
// The shape, verified live with sbx v0.54.0 (2026-11-20):
// - `--clone`: the sandbox works on its own clone. The host checkout is mounted
//   read-only at /run/sandbox/source, and the host reads the work back through
//   the `sandbox-<name>` git remote (an `sbx upload-pack` fetch, so no hooks run).
//   It must run from the main checkout (sbx refuses a git worktree), and no
//   other mount may sit inside the clone's path.
// - GitHub is denied for this sandbox only (`--deny-network`). The sandbox
//   never pushes; the host re-signs and the user pushes and opens the PR.
// - No signing key inside: commits there are unsigned; sync re-signs them.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { isEnvFile } from "../../core/env-files.ts";
import { redactSensitive } from "../../core/redact.ts";
import { createArgs } from "./adapter.ts";
import { validateSbxConfig, type SbxConfig } from "./config.ts";

/** Every dev-loop session sandbox starts with this (cleanup and sync find them by it). */
export const SESSION_PREFIX = "dl-session-";
/** Where the git-ignored `.overnight/{in,out}` folders appear inside (outside the clone's path). */
export const SANDBOX_OVERNIGHT_DIR = "/home/agent/.dev-loop/overnight";
/** Where each host plugin folder appears inside, read-only. */
export const SANDBOX_PLUGINS_DIR = "/home/agent/.dev-loop/plugins";
/** Must be denied: the sandbox never reaches GitHub (the stored token can't reach this repo anyway). */
const REQUIRED_DENY = ["github.com", "api.github.com"];

export interface SessionConfig {
  sbx: SbxConfig;
  denyNetwork: string[];
  /** Repo paths a sandbox change must not touch without `--allow-protected`. "dir/" is a folder, "x*" a prefix. */
  protectedPaths: string[];
  /** Claude plugins to mount read-only, as `name@marketplace` keys of installed_plugins.json. */
  plugins: string[];
  /** npm registry the sandbox installs from (the lockfile's own host is not allowed there). */
  npmRegistry?: string;
}

const SESSION_KEYS = new Set(["denyNetwork", "protectedPaths", "plugins", "npmRegistry"]);
const HOST = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const PLUGIN_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REL_PATH = /^[A-Za-z0-9._][A-Za-z0-9._\/-]*\*?$/;

const strings = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`session: ${what} must be an array of strings`);
  return [...new Set(v as string[])];
};

/** `sbx.session.config.json` -> config. The sbx block goes through the same validator as a project's. */
export function validateSessionConfig(raw: unknown): SessionConfig {
  const o = (raw ?? {}) as { sandbox?: { sbx?: unknown }; session?: unknown };
  const sbx = validateSbxConfig(o.sandbox?.sbx);
  const s = o.session;
  if (typeof s !== "object" || s === null || Array.isArray(s)) throw new Error("session: block is required");
  const so = s as Record<string, unknown>;
  for (const k of Object.keys(so)) if (!SESSION_KEYS.has(k)) throw new Error(`session: unknown key "${k}"`);

  const denyNetwork = strings(so.denyNetwork ?? [], "denyNetwork");
  for (const h of denyNetwork) if (!HOST.test(h)) throw new Error(`session: denyNetwork entry "${h}" must be a host name`);
  for (const h of REQUIRED_DENY) if (!denyNetwork.includes(h)) throw new Error(`session: denyNetwork must include ${h} (the sandbox never pushes)`);

  const protectedPaths = strings(so.protectedPaths ?? [], "protectedPaths");
  for (const p of protectedPaths) {
    if (!REL_PATH.test(p) || p.split("/").includes("..")) throw new Error(`session: protectedPaths entry "${p}" must be a repo-relative path`);
  }

  const plugins = strings(so.plugins ?? [], "plugins");
  for (const p of plugins) if (!PLUGIN_KEY.test(p)) throw new Error(`session: plugins entry "${p}" must be name@marketplace`);

  const cfg: SessionConfig = { sbx, denyNetwork, protectedPaths, plugins };
  if (so.npmRegistry !== undefined) {
    if (typeof so.npmRegistry !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._\/-]*$/.test(so.npmRegistry)) {
      throw new Error("session: npmRegistry must be an https URL");
    }
    cfg.npmRegistry = so.npmRegistry;
  }
  return cfg;
}

/** `dl-session-YYYYMMDD-HHMMSS` (UTC), so names sort by start time. */
export function sessionName(now: Date): string {
  const iso = now.toISOString(); // 2026-11-20T22:45:01.000Z
  return `${SESSION_PREFIX}${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

export interface Plugin { name: string; dir: string }

/** Each configured plugin's install folder, from ~/.claude/plugins/installed_plugins.json. */
export function resolvePlugins(installed: unknown, keys: string[]): Plugin[] {
  const reg = (installed as { plugins?: Record<string, { installPath?: unknown }[]> } | null)?.plugins;
  if (typeof reg !== "object" || reg === null) throw new Error("could not read ~/.claude/plugins/installed_plugins.json");
  return keys.map((key) => {
    const dir = reg[key]?.find((e) => typeof e?.installPath === "string")?.installPath as string | undefined;
    if (!dir) throw new Error(`plugin ${key} is not installed (claude plugin install ${key}), or drop it from sbx.session.config.json`);
    return { name: key.split("@")[0], dir };
  });
}

/** The `sbx create` argv: the project create args, plus clone mode, the GitHub deny, and the read-only mounts. */
export function sessionCreateArgs(name: string, cfg: SessionConfig, repo: string, plugins: Plugin[]): string[] {
  const base = createArgs(name, cfg.sbx, [repo], [
    `${repo}/.overnight/in:${SANDBOX_OVERNIGHT_DIR}/in:ro`,
    `${repo}/.overnight/out:${SANDBOX_OVERNIGHT_DIR}/out`,
    ...plugins.map((p) => `${p.dir}:${SANDBOX_PLUGINS_DIR}/${p.name}:ro`),
  ]);
  // --clone and the denies are create-time flags; they go before the agent name.
  const at = base.indexOf("claude");
  return [...base.slice(0, at), "--clone", ...cfg.denyNetwork.flatMap((h) => ["--deny-network", h]), ...base.slice(at)];
}

/** Claude's own flags inside the sandbox (after `--`). */
export function claudeArgs(plugins: Plugin[]): string[] {
  return plugins.flatMap((p) => ["--plugin-dir", `${SANDBOX_PLUGINS_DIR}/${p.name}`]);
}

/**
 * The unattended launch: a detached screen running caffeinate (so the Mac
 * stays awake exactly as long as the job), which runs the job and tees its
 * output to a log. The script text is fixed; the prompt and every argument go
 * in as positionals, so nothing from the prompt is ever parsed by a shell.
 */
/**
 * `claude -p` stops its background subagents 10 minutes after its last turn
 * unless this is 0 (found 2026-11-21: the first overnight run spawned two
 * builder subagents, ended its turn, and was cut off at 10 minutes).
 */
const BG_WAIT = "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS";

/**
 * How --overnight shows what it's doing: claude -p streams JSON events; the
 * host pipes them through `script` (scripts/claude-sbx-stream.mjs), which keeps
 * every raw event in `raw` and prints one readable line each (formatStreamLine)
 * to the screen session and the log.
 */
export interface StreamTo { node: string; script: string; raw: string }

export function overnightArgv(o: { name: string; repo: string; env: string[]; agent: string[]; ask: string; log: string; stream: StreamTo }): string[] {
  // Drop a host value passed by name (`-e NAME`); ours wins.
  const env: string[] = [];
  for (let i = 0; i < o.env.length; i++) {
    if (o.env[i] === "-e" && (o.env[i + 1] === BG_WAIT || o.env[i + 1]?.startsWith(`${BG_WAIT}=`))) { i++; continue; }
    env.push(o.env[i]);
  }
  return [
    "screen", "-dmS", o.name, "caffeinate", "-is",
    // stdin from /dev/null: claude -p otherwise waits 3 s for piped input.
    "sh", "-c", 'log="$1"; node="$2"; fmt="$3"; raw="$4"; shift 4; "$@" < /dev/null 2>&1 | "$node" "$fmt" "$raw" | tee -a "$log"',
    "sh", o.log, o.stream.node, o.stream.script, o.stream.raw,
    "sbx", "exec", "-w", o.repo, ...env, "-e", `${BG_WAIT}=0`, o.name,
    "claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", ...o.agent, o.ask,
  ];
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** One printable line: redacted first (a cut secret loses its delimiter), then cut, control chars gone. */
const clip = (v: unknown, n = 160): string => {
  const text = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  const one = redactSensitive(text).replace(CONTROL, "").split("\n").find((l) => l.trim() !== "") ?? "";
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/**
 * One raw line from `claude -p --output-format stream-json` -> the lines a
 * person watching --overnight sees: tool calls, the assistant's words, short
 * results, the final result. Same idea as the loop's --stream
 * (printStreamEvent in src/core/spawn-claude.ts). A subagent's events get ↳.
 * A non-JSON line (sbx's own output) passes through. Never throws.
 */
export function formatStreamLine(line: string, time: string): string[] {
  let ev: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an event");
    ev = parsed as Record<string, unknown>;
  } catch {
    const t = clip(line, 300);
    return t ? [`${time} ${t}`] : [];
  }
  const sub = typeof ev.parent_tool_use_id === "string" ? "↳ " : "";
  const content = (ev.message as { content?: unknown } | undefined)?.content;
  const items = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  const out: string[] = [];
  if (ev.type === "system") return ev.subtype === "init" ? [`${time} started`] : [];
  if (ev.type === "assistant") {
    for (const it of items) {
      if (it?.type === "tool_use") out.push(`${time} ${sub}tool ${clip(it.name, 40)} ${clip(it.input)}`);
      else if (it?.type === "text" && clip(it.text)) out.push(`${time} ${sub}says ${clip(it.text, 200)}`);
    }
  } else if (ev.type === "user") {
    for (const it of items) {
      if (it?.type !== "tool_result") continue;
      const c = Array.isArray(it.content) ? (it.content as { text?: unknown }[]).map((x) => x?.text ?? "").join("\n") : it.content;
      out.push(`${time} ${sub}result ${it.is_error === true ? "✗ " : ""}${clip(c, 120)}`);
    }
  } else if (ev.type === "result") {
    const cost = typeof ev.total_cost_usd === "number" ? ` · $${ev.total_cost_usd.toFixed(2)}` : "";
    const mins = typeof ev.duration_ms === "number" ? ` · ${(ev.duration_ms / 60000).toFixed(1)} min` : "";
    out.push(`${time} DONE ${clip(ev.subtype, 30)} · ${ev.num_turns ?? "?"} turns${cost}${mins}`);
  }
  return out;
}

/**
 * The script `sbx exec` runs to prove the session is really sandboxed. Each
 * line is `key=value`; parseSandboxCheck reads them. The overnight launcher
 * refuses to hand off without a pass.
 */
export const SANDBOX_CHECK_SCRIPT = [
  'echo "os=$(uname -s)"',
  'if [ -d /home/agent ]; then echo home=yes; else echo home=no; fi',
  'n=0; for f in "$HOME"/.ssh/id_*; do case "$f" in *.pub) ;; *) [ -r "$f" ] && n=$((n+1));; esac; done; echo "sshkeys=$n"',
  // The deny works when GitHub answers 403 (the proxy) or not at all.
  'c=$(curl -s -o /dev/null -m 10 -w "%{http_code}" https://api.github.com/ 2>/dev/null); case "$c" in 2??|3??) echo github=open;; *) echo github=blocked;; esac',
  'if [ ! -d /run/sandbox/source ]; then echo source=missing; elif ( : > /run/sandbox/source/.dl-write-probe ) 2>/dev/null; then rm -f /run/sandbox/source/.dl-write-probe; echo source=rw; else echo source=ro; fi',
].join("\n");

export function parseSandboxCheck(out: string): { ok: boolean; reasons: string[] } {
  const kv = new Map(out.split("\n").map((l) => l.trim().split("=", 2) as [string, string]).filter((p) => p.length === 2));
  if (!["os", "home", "sshkeys", "source", "github"].every((k) => kv.has(k))) return { ok: false, reasons: ["check output incomplete"] };
  const reasons: string[] = [];
  if (kv.get("os") !== "Linux") reasons.push(`not Linux (os=${kv.get("os")})`);
  if (kv.get("home") !== "yes") reasons.push("no /home/agent");
  const keys = Number(kv.get("sshkeys"));
  if (!(keys === 0)) reasons.push(`${Number.isNaN(keys) ? "unknown" : keys} readable SSH private keys`);
  if (kv.get("source") === "missing") reasons.push("not a --clone sandbox (no /run/sandbox/source)");
  else if (kv.get("source") !== "ro") reasons.push("the host checkout is writable from inside");
  if (kv.get("github") !== "blocked") reasons.push("GitHub is reachable (it must be denied)");
  return { ok: reasons.length === 0, reasons };
}

/**
 * The overnight prompt must come from `.overnight/in` (the only inputs the
 * sandbox can see besides tracked files). `realpath` resolves symlinks.
 * Returns the absolute host path.
 */
export function overnightPromptFile(repo: string, arg: string, realpath: (p: string) => string): string {
  const inDir = posix.join(repo, ".overnight", "in");
  const abs = posix.resolve(repo, arg);
  const inside = (p: string): boolean => p.startsWith(inDir + "/");
  if (!inside(abs) || !inside(realpath(abs))) throw new Error(`--prompt-file must be a file under .overnight/in (got ${arg})`);
  return abs;
}

/**
 * The changed files that touch a protected path. "dir/" matches the folder; "x*" a prefix; else exact.
 * Compared case-folded and NFC-normalized: on the Mac's case-insensitive disk `claude.md` and
 * `.Claude/settings.json` ARE `CLAUDE.md` and `.claude/settings.json` once checked out.
 */
export function protectedHits(files: string[], patterns: string[]): string[] {
  const fold = (x: string): string => x.normalize("NFC").toLowerCase().replace(/^\.\//, "");
  const ps = patterns.map(fold);
  const hit = (raw: string): boolean => {
    const f = fold(raw);
    return ps.some((p) => (p.endsWith("/") ? f.startsWith(p) : p.endsWith("*") ? f.startsWith(p.slice(0, -1)) : f === p));
  };
  return files.filter(hit);
}

/**
 * A branch name from inside the sandbox is untrusted: it gets printed into
 * commands the user copies. Plain git-safe characters only.
 */
export function isSafeBranchName(b: string): boolean {
  const parts = b.split("/");
  return (
    /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(b) &&
    !b.includes("..") && !b.includes("//") && !b.endsWith("/") && !b.endsWith(".lock") && !b.endsWith(".") &&
    // Never a name git could read as another ref (refs/x, tags/x, x/HEAD).
    !parts.some((p) => p.toUpperCase() === "HEAD") && !["refs", "heads", "remotes", "tags"].includes(parts[0].toLowerCase())
  );
}

/** The first line of the loop's fake .envrc (src/core/fake-env.ts); it holds placeholders only. */
const FAKE_ENV_HEADER = "# dev-loop fake env:";

/**
 * Real env files anywhere in the checkout (any case, any depth), as repo-relative
 * paths. sbx --clone mounts the WHOLE host checkout read-only at /run/sandbox/source,
 * ignored files included, so one there is readable by the sandboxed agent.
 * Skips node_modules, .git and the loop's own fake .envrc. Symlinks are not followed.
 */
export function realEnvFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n === "node_modules" || n === ".git") continue;
      const p = join(dir, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (isEnvFile(n.toLowerCase())) {
        let head = "";
        try { head = readFileSync(p, "utf8").slice(0, FAKE_ENV_HEADER.length); } catch { /* unreadable: still listed */ }
        if (head !== FAKE_ENV_HEADER) out.push(posix.relative(root, p));
      }
    }
  };
  walk(root);
  return out;
}

/** A session sandbox name: it becomes a git remote (`sandbox-<name>`) and a ref folder. */
export function isSafeSessionName(n: string): boolean {
  return n.startsWith(SESSION_PREFIX) && n.length <= 63 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n) && n.length > SESSION_PREFIX.length;
}

/** Report file names from the writable .overnight/out are untrusted; only plain ones are printed. */
export function safeReportNames(names: string[]): string[] {
  return names.filter((n) => /^[A-Za-z0-9._-]+\.md$/.test(n));
}

export interface BranchSync {
  branch: string;
  /** synced: local branch made and re-signed. protected: fetched, not made (needs --allow-protected). exists/failed: left alone. */
  status: "synced" | "protected" | "exists" | "failed";
  commits: number;
  adds: number;
  dels: number;
  files: number;
  hits: string[];
  detail?: string;
  /** The host commit the sandbox's new commits grew from (diff from here to see only them). */
  base?: string;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The summary claude:sbx prints on exit and claude:sbx:sync prints after an overnight run. */
export function renderSyncSummary(name: string, branches: BranchSync[], reports: string[]): string {
  if (branches.length === 0) {
    return [`No new branches in sandbox "${name}".`, ...reports.map((r) => `Report: ${r}`)].join("\n");
  }
  const w = Math.max(...branches.map((b) => b.branch.length));
  const out = [`Synced from sandbox "${name}" (checked and re-signed, nothing pushed):`, ""];
  for (const b of branches) {
    const verdict =
      b.status === "synced" ? "✓ no protected files"
      : b.status === "protected" ? `⚠ ${b.hits.join(", ")} (needs --allow-protected)`
      : `✗ ${b.detail ?? b.status}`;
    out.push(`  ${b.branch.padEnd(w)}  ${plural(b.commits, "commit")}  +${b.adds} −${b.dels}  ${plural(b.files, "file")}  ${verdict}`);
  }
  for (const r of reports) out.push("", `Report: ${r}`);
  const synced = branches.filter((b) => b.status === "synced");
  if (synced.length > 0) {
    out.push("", "Next:");
    for (const b of synced) {
      out.push(`  git diff ${b.base ? `${b.base}..` : "main..."}${b.branch}   # look: only the sandbox's commits`);
      out.push(`  git push -u origin ${b.branch} && gh pr create        # keep: you push, then merge the PR`);
      out.push(`  git branch -D ${b.branch}                             # drop`);
    }
  }
  if (branches.some((b) => b.status === "protected")) {
    out.push("", "Protected files changed. Read every commit first:");
    for (const b of branches.filter((x) => x.status === "protected")) out.push(`  git log -p ${b.base ?? "main"}..sandbox-${name}/${b.branch}`);
    out.push(`Then, only if you approve: npm run claude:sbx:sync -- --name=${name} --allow-protected`);
  }
  return out.join("\n");
}
