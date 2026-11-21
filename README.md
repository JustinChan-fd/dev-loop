# dev-loop

A local agentic Jira pipeline in one repo with two phases. The default worker
(`npm run loop -- --project=<name>`, i.e. `--phase=worker`) runs both on one
session; `--phase=research|dev` runs one. The phases coordinate through Jira
ticket state (labels):

- **research** (formerly the separate `research-loop` repo, "Terminal A")
  refines raw Jira tickets into tickets marked ready for dev.
- **dev** ("Terminal B") picks up ready tickets and lands PRs from them.

One live worker per project (`--session=<name>`, default `dev-<n>`); a second
start on the same project names the live session and exits 1. See
`CLAUDE.md` for working rules and `docs/` for how the pieces fit together.

**New here? Start with the guide:** https://justinchan-fd.github.io/dev-loop/

It's a plain-language, interactive picture of the loop. Pick a repo, a job,
a sandbox and a mode, and it shows what runs where, step by step, plus the
command to run.

## Phase: research (the skeptic)

Per spec sections 5.0/5.1. For each ticket it pulls from Jira, it:

1. **Interprets** the ticket as written.
2. **Grounds** that interpretation against the actual codebase, checking that
   the ticket's assumptions match reality.
3. **Attacks** the ticket's assumptions, looking for gaps, ambiguity, or claims
   that don't hold up.
4. **Writes** the refined ticket, incorporating what it learned.

A passing verdict means the ticket is ready for the human review gate, not
ready for dev directly. Only after human review does a ticket's label swap from
`pipeline:research` to `pipeline:dev`, the label the dev phase polls for. The
skill is `ticket-refine` with subagents `recon-agent`, `devils-advocate-agent`
and `verifier-agent`. It runs from the repo root like dev; its skeptic stance is
`src/roles/research/stance.md` (appended to its system prompt), and the root
`CLAUDE.md` (dev's stance) is excluded from it.

## Phase: dev (the executor)

Per spec section 5.0/5.2:

- It trusts the refined ticket completely: the acceptance criteria are the
  contract, and it does not renegotiate them.
- For each acceptance criterion, it writes a failing test first (**RED**), then
  implements just enough to make it pass (**GREEN**).
- Once all criteria are green, it runs the verification gates (build, lint,
  full test suite, etc.) before opening a PR.
- It **never edits the spec**. If a ticket's spec is wrong, ambiguous, or
  unimplementable as written, it bounces the ticket back with concrete evidence
  rather than silently reinterpreting it.

The skill is `ticket-to-pr` (`.claude/skills/ticket-to-pr/SKILL.md`) with the
`qa-agent` subagent.

## Current status

- The loop-runner's pure functions (config loading, JQL query building,
  verdict parsing, ceiling enforcement, run logging) live in `src/core/` and are
  unit-tested; phase-specific code lives in `src/roles/<phase>/`.
- The Jira client is real (`RealJiraClient`) and bound per project via
  `pipeline.<project>.config.json`. Adding a project means adding a config; see
  `docs/config.md`.
- Both skills and all their subagents are fully authored.
- The run watcher (`npm run dashboard`) shows live and finished runs; see
  below.

## Watching runs (dashboard)

```sh
npm run dashboard                                  # every project
npm run dashboard -- --project=webtarsthree        # one project
npm run dashboard -- --port=5000                   # another port
```

It prints the URL, by default http://127.0.0.1:4317/. Start it next to a
running loop, or on its own to look back through history. It is a local web
page with three views: **Runs** (live and finished runs as cards, each with
its step bar and full log), **Timeline** (by run, by worker, or every
progress line) and **Batch** (empty until batch mode exists).

- **Read-only.** It only reads files. It never writes under `.pipeline/` or
  `runs/`, never touches a session lock, and never calls Jira or GitHub. It
  doesn't start, stop or change any run.
- **v2 logs only:** `runs/v2/<project>.jsonl` and `.pipeline/v2/<project>/`.
  The pre-2.0.0 v1 logs are not shown.
- It listens on 127.0.0.1 only. It loads no env file. Ticket keys link to
  Jira only when `JIRA_BASE_URL` is set in its environment.
- Run from a git worktree, it reads the main checkout's logs (the loop
  writes there; a worktree's own are empty). `--root=<dir>` watches another
  dev-loop checkout's logs.

Design: `docs/superpowers/specs/2026-11-20-run-watcher-design.md`.

## Running tests

```sh
npm install && npm test && npm run test:hooks
```
