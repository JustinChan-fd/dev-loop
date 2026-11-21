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

## Starting a session

Two ways to start Claude on dev-loop itself:

```sh
claude --dangerously-skip-permissions   # normal session, unchanged
npm run claude:sbx                      # same, but inside the sandbox
```

| | `claude --dangerously-skip-permissions` | `npm run claude:sbx` |
|---|---|---|
| Runs on | your Mac | a Docker sbx sandbox (Linux) |
| Repo it edits | your checkout | its own clone (`sbx --clone`); your checkout is untouched |
| GitHub / push | yes, your `gh` login | blocked; you push after sync |
| Jira MCP | yes | no |
| Commit signing | your SSH key | unsigned inside; re-signed on your Mac at sync |
| Real env files | readable (deny rules only) | refused: it won't start while one is anywhere in the checkout |
| Plugins (superpowers) | yes | yes (read-only) |
| Survives a closed terminal | no | with `--overnight` (screen + caffeinate) |
| Getting work back | it's already there | automatic when you exit; `npm run claude:sbx:sync` after `--overnight` |
| Use it for | attended work you're watching | unattended or long runs, or untrusted input |

Choosing which one is your call, each session. Long unattended work is
offered `claude:sbx` first (the pillar in `CLAUDE.md`). Run it from the main
checkout (`~/Desktop/Repos/dev-loop`): sbx can't clone from a git worktree.

```sh
npm run claude:sbx -- --overnight --prompt-file=.overnight/in/<file>.md
                                        # unattended; prints screen -r <name> to watch
npm run claude:sbx:sync                 # after it: branches come back signed; nothing is pushed
```

Sync prints each branch with its commits, size and whether any commit touched
a protected file (`.claude/` (settings, hooks, skills, agents), `CLAUDE.md`, `scripts/check-*`, `.github/`, `.mcp.json`, `package.json`, `package-lock.json`, `.npmrc`, `sbx.session.config.json`), then the `git diff` / `git push` /
`git branch -D` lines to look, keep or drop it. Every change reaches `main`
through a PR you merge. The protected list is a speed bump, not the control:
anything synced runs on your Mac the moment you run `npm test` there, so read
the whole diff (`git log -p main..<branch>`) before you run or push it.
Details: [docs/sandbox-sbx.md, "Dev-loop sessions"](docs/sandbox-sbx.md#dev-loop-sessions).

## Current status

- The loop-runner's pure functions (config loading, JQL query building,
  verdict parsing, ceiling enforcement, run logging) live in `src/core/` and are
  unit-tested; phase-specific code lives in `src/roles/<phase>/`.
- The Jira client is real (`RealJiraClient`) and bound per project via
  `pipeline.<project>.config.json`. Adding a project means adding a config; see
  `docs/config.md`.
- Both skills and all their subagents are fully authored.
- Not yet built: the live dashboard.

## Running tests

```sh
npm install && npm test && npm run test:hooks
```
