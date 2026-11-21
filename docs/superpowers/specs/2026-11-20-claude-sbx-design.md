# claude:sbx — dev-loop sessions inside sbx (2026-11-20)

Status: built on `feat/claude-sbx` (on top of `feat/guide-versioning`); merge
pending the user's smoke run and review.

## Why
The robot runs in sbx for target repos, but work on dev-loop's own code
(interactive Claude Code, and an unattended overnight build with permissions
bypassed) ran on the host. The user called that backwards: "silly to make the
dev-loop repos working with the sandbox but the actual iteration of the
dev-loop itself doesn't use sbx."

## Decisions (the user's, 2026-11-20)
- Plain `claude --dangerously-skip-permissions` stays as it is. `npm run
  claude:sbx` is "same, but inside the sandbox". Choosing between them is the
  user's call each session.
- New pillar: long unattended work is offered the sandbox first, and the
  overnight launcher only starts in a sandbox.
- The user is the final approver. `main` is PR-only on GitHub. The sandbox
  never pushes.
- No "adopt" step. When an attended `claude:sbx` exits it syncs, and
  `npm run claude:sbx:sync` syncs after `--overnight`. Sync output is in
  sandbox-sbx.md.
- No npm package split for now (future-enhancements has the trigger).
- The guide gets pillar 06 and section 05 (v1.1.0), in this change.

## Shape (verified live, sbx v0.54.0)
- `sbx create --clone`: a private clone. The host checkout is read-only at
  `/run/sandbox/source`. The host fetches through `sandbox-<name>`, which is
  `sbx upload-pack` and needs the sandbox running.
  - sbx refuses `--clone` from a git worktree, so the launcher resolves the
    main checkout.
  - sbx refuses a mount inside the clone's path, so `.overnight/{in,out}`
    mount at `/home/agent/.dev-loop/overnight/{in,out}`.
- `--deny-network github.com --deny-network api.github.com`: from inside,
  `curl api.github.com` returned 403 and `git ls-remote` was refused.
- npm: `~/.npmrc` points at nexus3 with `replace-registry-host=always`.
  `npm ci` took 46 s, and vitest and tsc are green inside.
- superpowers loads from a read-only mount through `--plugin-dir` (all its
  skills were listed).
- The sandbox already defaults to `bypassPermissions`. The launcher also
  passes `--dangerously-skip-permissions`.
- Sandbox check: `uname`, `/home/agent`, no readable `~/.ssh/id_*`, and a
  read-only `/run/sandbox/source`.

## Sync (the pillar: mechanical, in TypeScript, with tests)
`src/sandbox/sbx/session-sync.ts`, tested against real git:
- fetch;
- per branch with new commits:
  - refuse unsafe names, merges and `main`;
  - hold protected paths unless `--allow-protected`;
  - rebuild each commit with `git commit-tree -S` (the host's key and
    identity, the same tree and message). This needs no worktree, so no
    hooks run;
  - check the trees and that every signature is `G`;
  - create the branch, create-only.
- A marker ref (`refs/dl-sync/<name>/<branch>`) makes a rerun report
  "synced" instead of "exists".
- It never pushes or checks anything out.

## Calls I made (for review)
- **The protected-path check happens at sync, not as read-only mounts.**
  With `--clone` there is no host path to cover. Widened after review to
  `.claude/` (settings, hooks, skills, agents), `CLAUDE.md`, `scripts/check-*`, `.github/`, `.mcp.json`, `package.json`, `package-lock.json`, `.npmrc`, `sbx.session.config.json`, because anything there runs or configures the host after
  sync. Every commit is checked (not only the net diff), case-folded. It is a
  speed bump; reading the diff is the control.
- **The whole checkout is readable inside** (`/run/sandbox/source`, ignored
  files included; verified). Accepted for run logs and eval state, which are
  not secrets. Real env files are refused anywhere in the tree.
- **The overnight log is host-only** (`.overnight/logs/`), never in the
  writable `.overnight/out`, where a planted symlink could redirect it.
- **Re-sign with `commit-tree`, not `host-sign.ts`'s rebase.** The rebase
  needs a worktree and runs hooks. `commit-tree` keeps the trees identical
  by construction.
- **The sandbox is kept after exit** (its clone holds the work). The summary
  prints `sbx rm <name>`.
- **The overnight run is `screen -dmS <name> caffeinate -is sh -c '…tee log'`**,
  so caffeinate lives exactly as long as the job. The prompt is passed as an
  argument, never as shell text.
- **Model names** come from the host's `~/.claude/settings.json` env, as with
  sbx:smoke.
