# Setting up the sbx sandbox

The `sbx` adapter runs each agent in a Docker Sandbox. The agent sees only
the folders the loop mounts (dev-loop and the target repo), reaches only
allowed network hosts, and gets credentials through a proxy that adds them
to each request. The agent never holds a token.

**Access grants are yours.** dev-loop never runs `sbx policy allow`,
`sbx secret set` or `sbx policy approval respond`, and no npm script wraps
them. It prints the command; you decide and type it.

**Opt-in per run.** The project config holds the sbx settings but no
`adapter` line, so a plain run uses no sandbox. Add `--sandbox=sbx`:

```
npm run loop -- --project=webtarsthree --sandbox=sbx --once --stream
```

On macOS, with you at the terminal, that also opens the live dashboard
(`npm run sbx:dashboard`) in a new Terminal window once preflight passes,
unless one is already open. `--no-dashboard` skips it. The first time,
macOS asks whether Terminal may control Terminal: allow it. If the window
can't open, the loop prints why and carries on.

Config keys: [config.md](config.md). First set up on 2026-11-16 against
sbx v0.54.0.

## Commands

| Command | What it does |
|---|---|
| `npm run sbx:status` | sandboxes, secrets (names only), policies, pending approvals, templates |
| `npm run sbx:dashboard` | sbx's live dashboard (`sbx tui`); loop sandboxes appear and disappear here |
| `npm run sbx:preflight` | the loop's startup checks, then exit; touches no ticket |
| `npm run sbx:smoke` | one sandbox built from the loop's create args (dev-loop folder only), one tiny `claude -p` (haiku), then removed; a few cents |
| `npm run sbx:cleanup` | removes this project's leftover `dl-*` sandboxes |
| `npm run sbx:template:build -- --tag=v3` | rebuilds the template from `sandbox/sbx/template.sh` ([templates.md](adapters/sbx/templates.md)) |
| `npm run sandbox:approvals` | what a discover run was refused, with the allow lines to review |
| `npm run claude:sbx` | Claude Code on dev-loop itself, inside a sandbox ([Dev-loop sessions](#dev-loop-sessions)) |
| `npm run claude:sbx:sync` | bring a session sandbox's branches back, re-signed; never pushes |

`cleanup`, `smoke` and `template:build` take `-- --project=<name>` (default
`webtarsthree`); `sbx:preflight` is fixed to webtarsthree and passes
`--sandbox=sbx`. The loop runs
`claude -p` headless, so there is no Claude screen to attach to: watch
the dashboard (opened for you) and run the loop with `--stream`.

## 1. Template: node, jq, direnv, the HTTPS rewrite

The kit is a `FROM scratch` mixin, so it can't supply tools. A saved
template does. Build one:

```
sbx policy allow network deb.nodesource.com     # once, yourself
npm run sbx:template:build -- --tag=v1
```

Then set
`"template": "docker.io/library/dev-loop-sbx:v1"` in the project's
`sandbox.sbx` block. Packages live in `sandbox/sbx/template.sh`. Updating,
upgrading node and rolling back:
[adapters/sbx/templates.md](adapters/sbx/templates.md).
The image's Node must match the project's (its `targetRepo.local.node.versionFile`),
not the host's; a project on another major gets its own image (one per major).

## 2. GitHub token

```
sbx secret set github      # paste the token; sbx secret ls shows (stored)
```

Used: a fine-grained token, resource owner **fandango**, repos webtarsthree,
catalog-ui-management and catalog-ui-public, expiry 366 days. Permissions:

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | `git push` of the feature branch |
| Pull requests | Read and write | `gh pr create / view / edit / review` |
| Issues | Read and write | the GitHub issue mirror (`gh issue ...`) |
| Actions | Read | read CI runs |
| Commit statuses | Read | `gh pr checks` |
| Metadata | Read | required |

Leave **Workflows** off, so a push that touches `.github/workflows/` is
refused: a free safety net. Leave admin, secrets, variables, environments,
webhooks, deployments, pages and every account permission off.

The org requires approval ("Generate token and request access"). The
`dev-loop-sbx` token was approved on 2026-11-17 and regenerated the same
day; it expires **2027-11-18**. Until a token is
approved, private repos answer 404 and preflight says "the sandbox's
GitHub token cannot see ...". Personal repos are out of reach; dev-loop
works only on fandango repos. When the token expires, preflight fails the
same way: renew it and run `sbx secret set github` again.

Alternatives if a fine-grained token is not possible:

- **Host `gh` login:** `sbx secret set github --command '/opt/homebrew/bin/gh auth token'`.
  It works at once, but reaches every repo your `gh` login can reach.
  Only for attended runs.
- **Classic token** with only `repo`: no repo limit either.

## 3. Network: allow GitHub

The sandbox blocks hosts by default. `gh` reports a blocked host as "token
invalid"; the real message is `403 ... Approval required for api.github.com`.
An approval from `sbx policy approval ls` covers only the sandbox that
asked. The loop makes a new sandbox per run, so allow these globally:

```
sbx policy allow network api.github.com,github.com
```

## 4. The kit credential

Run once: `sbx run claude --kit ~/Desktop/Repos/keystone-bedrock-kit ~/Desktop/Repos/dev-loop`,
and choose "Approve all" if asked. If it doesn't ask, it is already
approved. An unapproved credential is silently absent inside the sandbox,
and every run then fails with a gateway auth error (an agent error, not a
park). `npm run sbx:smoke` catches this.

## 5. Model names

The `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` aliases come from the
`env` block of `~/.claude/settings.json` (the source of truth) when the
loop's env lacks them; a value in your shell or `DEVLOOP_ENV_FILE` wins.
Only those three names are read from that file, and their values go into
the sandbox by name (`sbx exec -e NAME`). The sandbox never sees the file.

## 6. Only these folders are visible

The sandbox mounts dev-loop's folder and the target repo, nothing else:
not `~/.zshrc`, `~/.claude`, `~/.ssh`, `~/.aws`, your other projects or
your Desktop. The one exception is `sandbox.sbx.hostSkills`: each of your
own skills listed there (webtarsthree: `push-branch`) is mounted
**read-only** at `/home/agent/.dev-loop/skills/<name>`, and dev is told
that path. Without it, a sandboxed dev run bounces `env_setup` at the PR
step, because `~/.claude/skills/push-branch/SKILL.md` doesn't exist in
the sandbox. A run on the host (no `--sandbox`) is unchanged: it reads
`~/.claude/skills/push-branch/SKILL.md` as always.

Anything inside the mounts is readable by the agent, so:

- Keep dev-loop's env file out of the repo:
  `DEVLOOP_ENV_FILE=$HOME/.config/dev-loop/.env`, exported in `~/.zshrc`.
  Preflight **refuses** a `.env`, `.envrc` or `.env.*` (except `*.example`)
  at the top of dev-loop's folder.
- The target repo's **top folder is never mounted**, so its real `.envrc`,
  `.env` and `.env.*` are not in the sandbox at all. Only `<repo>/.git` and
  `<repo>/.claude/worktrees` are mounted: the robot's worktrees live there.
  The robot's `direnv exec <worktree>` loads the loop's fake env,
  `<repo>/.claude/worktrees/.envrc`, built from the committed
  `.envrc.example` with placeholder values (`src/core/fake-env.ts`).
  - A read-only file mounted over `.envrc` is not enough: the Mac's disk
    is case-insensitive, and `.ENVRC` reached the real file (checked
    2026-11-17).
  - Preflight refuses to start if any env file, in any case, is visible at
    the repo's top inside a sandbox, or if the fake is missing.
  - Each run's sandbox allows only the fake, and trusts the repo for git
    (`safe.directory`, since its top folder is root-owned inside).
  - Only host push uses the real `.envrc`, on your Mac.
  - The v2 clone (no `targetRepo.path`) sits inside dev-loop's folder, so
    its top can't be left out. There, preflight refuses any env file in it.
- The dev-loop folder check applies only to its top. A secret deeper in,
  such as `config/secrets.json`, is not caught.

## 7. Check, then run in discover mode

```
npm run sbx:preflight     # tools, GitHub reachability, env files; free
npm run sbx:smoke         # a real claude -p in a real sandbox; a few cents
```

Preflight's GitHub step names the cause: a firewall approval (`sbx policy
approval ls` or `sbx policy allow network <host>`), token access, or a
template without the HTTPS rewrite.

With `"mode": "discover"`, a blocked host gets a 403 and the run carries on.
Afterwards, `npm run sandbox:approvals` lists each blocked host with a
`sbx policy allow network <host>` line. Review them and run the ones you
approve yourself. webtarsthree installs packages from a private npm
registry (`nexus3.mgo.com`), which will likely show up here. When a run is
clean, switch to `"mode": "enforce"`.

An infra failure (daemon down, prepare failed) parks the ticket and pauses
the worker in both modes.

## 8. Real-case paths

The container is case-sensitive: preflight refuses a mount or cwd whose
case differs from the disk (`.../repos/...` when the disk says `Repos`).
If it comes from `targetRepo.path`, fix the config; if it is the cwd, `cd`
into the real path.

## 9. Atlassian MCP (Jira for the agent)

The skills read and write Jira through the Atlassian MCP. Your home Claude
config isn't mounted, so the sandbox gets it from sbx's MCP gateway
instead. Register it and sign in once, yourself:

```
sbx mcp add atlassian --url https://mcp.atlassian.com/v2/mcp
sbx mcp auth atlassian        # browser sign-in; sbx mcp ls shows "ready"
```

`"mcp": ["atlassian"]` in `sandbox.sbx` makes each sandbox start with it
(`sbx create --static-mcp atlassian`). Preflight checks `sbx mcp ls` before
creating anything and stops with the command to run when a listed server
is missing or not ready. Without it, research fails at intake with "Jira
access unavailable (MCP gateway permission denied)" (seen on the first
run, 2026-11-16). Verified: a haiku `claude -p` in a sandbox read
TARS-1634 through it.

**Tool names inside the sandbox.** sbx serves every static MCP server as one
server named `mcp-gateway`, and Atlassian's `/v2/mcp` renamed some tools, so
the agent sees `mcp__mcp-gateway__addOrEditJiraIssueComment` where your host
session sees `mcp__atlassian__addCommentToJiraIssue`. The second sandboxed
run (TARS-1634, 2026-11-16) failed at intake because the allowlist only named
the host form. `src/core/atlassian-tools.ts` is now the one list of Atlassian
tools: each role's allowlist is built from it, in the host form or, when the
adapter proxies Atlassian (`atlassianMcp`), the gateway form. Only the same
tools are allowed under either name; the generic `executeWrite` /
`executeDestructive` / `transitionJiraIssue` are never allowed. Dev's
`createIssueLink` has no v2 tool, so a dev run on the newer server files a
follow-up ticket and records the link in its description instead. With no
sandbox, the host connector may be either version (`claude mcp get atlassian`
shows its URL), so the host allowlist has both namings. The hooks in `.claude/settings.json` match the tool
name under any server (`mcp__.+__(...)`), and `test/core/atlassian-tools.test.ts`
fails if a write tool is missing from them. `npm run sbx:smoke` calls
`getAccessibleAtlassianResources` by its gateway name, so a mismatch shows up
there for a few cents.

## 10. Signed commits

**Why.** The sandbox has no signing key, and the target repo requires signed
commits. TARS-1634's dev run (2026-11-17) pushed unsigned commits and GitHub
rejected the push with GH013.

**Flow.** When the sandbox can't sign, the loop passes `push=host` to
`ticket-to-pr`. The skill finishes Phase 4, checks the tree is clean, and
writes a verdict with `outcome: "ready_to_push"` (`branch`, `pr_title`,
`pr_body`) instead of pushing. The host loop then makes a fresh worktree,
re-signs only the unpushed commits as the operator, runs `npm ci`, and runs
`push-branch` unchanged on haiku. An unpushed branch is re-signed on top of
its fork point (`git merge-base HEAD origin/<default>`), so a default branch
that moved since is never replayed onto. A pushed branch is re-signed on top
of `origin/<branch>`, and only if that is still an ancestor of HEAD. It
refuses if any commit in the range is already on origin. push-branch may rename the branch (version guard); the
loop reads the final branch name to find the PR.

**On failure.** If signing or the push fails, the work stays committed
locally and the run bounces `env_setup`. A failed re-sign restores the
branch to its old tip exactly. A retry finds the same branch and, if the PR
exists, push-branch updates it.

**Host requirements.** The operator's ssh-agent (or other signing key) must
be unlocked and usable non-interactively when the loop runs: no passphrase
or touch prompt. A locked agent bounces the run.

**Hooks run, every time.** Re-signing runs webtarsthree's pre-commit suite
once per commit. It is never skipped (no `--no-verify`). A hook that fails
on commit 2 of 3 bounces the run. Each worktree git call has a 60 minute
timeout.

**The host runs the branch's code.** The pre-commit and pre-push hooks run
the branch's tests, and that branch was written in the sandbox. So the
host runs sandbox-written code, outside the sandbox. This is accepted
because hooks can't be skipped (signed commits need them), and a guard
covers the worst paths: before `npm ci`, the loop lists the files the branch
changed since its fork point. If any is `package.json`, `package-lock.json`,
`npm-shrinkwrap.json`, `.npmrc` or under `.husky/`, the run bounces before
anything is installed or run. Review that branch and push it by hand.

**Startup checks.** With host push on, the loop checks two things before it
polls, and won't start if either fails. The target repo's `.envrc` must be
allowed (`direnv status` shows `Found RC allowed 0`; no `.envrc` is fine).
The loop never allows it for you: run `direnv allow <repoDir>` yourself
once. And `~/.claude/skills/push-branch/SKILL.md` must exist.

## 11. Tests run inside the sandbox

The sandbox is Linux; your checkout's `node_modules` are macOS builds. So
dev installs the packages in its own worktree (`npm ci`, ticket-to-pr
"Install the target repo's packages") and never reuses the checkout's.
Checked live 2026-11-17: in a sandbox on a fresh webtarsthree worktree,
`npm ci` pulled the Linux build of rollup from `nexus3.mgo.com`, and
`vitest run` ran 8013 tests (7844 passed, 1 known failure on master:
`placements-body-limit.integration.test.js`). The TARS-1634 run that called
vitest "not runnable" had skipped this install.

## Dev-loop sessions

The sections above run the *robot* on a target repo. This one is for working
on dev-loop's own code with Claude Code inside sbx. There are two ways to start:

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
| Real env files | readable (deny rules only) | not there (the clone has tracked files only) |
| Plugins (superpowers) | yes | yes (read-only) |
| Survives a closed terminal | no | with `--overnight` (screen + caffeinate) |
| Getting work back | it's already there | automatic when you exit; `npm run claude:sbx:sync` after `--overnight` |
| Use it for | attended work you're watching | unattended or long runs, or untrusted input |

Choosing which one is your call, each session. Long unattended work (an
overnight build, a long eval) is offered `claude:sbx` first; the overnight
launcher only starts inside a sandbox.

### What `npm run claude:sbx` sets up

Config: `sbx.session.config.json` at the repo root (the same `sandbox.sbx`
fields and checks as a project, plus a `session` block; see
[config.md](config.md#dev-loop-session-sandbox-sbxsessionconfigjson)).

- **Its own clone.** `sbx create --clone`: the sandbox works on a private
  clone; your checkout is mounted read-only at `/run/sandbox/source` and is
  never written. Only committed files are cloned, so `.env` files, `runs/`,
  `.pipeline/` and anything uncommitted are not there. Run it from the main
  checkout: sbx refuses `--clone` from a git worktree. A branch you have only
  in a worktree is still in the clone (same repo): `git checkout <branch>`.
- **GitHub blocked for this sandbox only** (`--deny-network github.com` and
  `api.github.com`). The robot's sandboxes are unchanged. The stored sbx
  `github` token is fandango-scoped anyway: `JustinChan-fd/dev-loop` is owned
  by a user account, not the fandango org, so the token can't reach it.
- **No signing key.** Commits inside are unsigned. Your Mac re-signs them at
  sync with its own key and identity.
- **npm** installs from `nexus3.mgo.com` (`~/.npmrc` with
  `replace-registry-host=always`): the lockfile names `npm.fandango.com`, which
  the sandbox policy doesn't allow. If an install is still blocked, review it
  and allow it yourself: `sbx policy allow network npm.fandango.com`.
  `npm ci` installs the Linux builds (rolldown, TypeScript 7 native).
- **Plugins.** Each `session.plugins` entry (superpowers) is mounted
  read-only from `~/.claude/plugins` and loaded with `--plugin-dir`.
- **Overnight inputs and outputs.** `.overnight/in` (git-ignored) is mounted
  read-only at `/home/agent/.dev-loop/overnight/in`; `.overnight/out` is
  writable at `/home/agent/.dev-loop/overnight/out`, for the report only.
  They sit outside the clone's path because sbx refuses a mount inside it.
- **A real sandbox check** before Claude starts: Linux, `/home/agent`, no
  readable SSH private key, and a read-only `/run/sandbox/source`. A sandbox
  that fails is removed. `npm run claude:sbx -- --check` runs the same check
  from inside.

### Unattended

```sh
npm run claude:sbx -- --overnight --prompt-file=.overnight/in/<file>.md
screen -r <name>                        # watch; Ctrl-a d detaches again
```

The prompt file must be under `.overnight/in`. It runs `claude -p` in a
detached `screen`, under `caffeinate` (the Mac stays awake for as long as the
job runs), logging to `.overnight/out/<name>.log`.

### Getting the work back: `claude:sbx:sync`

An attended `claude:sbx` syncs when you exit Claude. After `--overnight`, run
`npm run claude:sbx:sync` (add `-- --name=<sandbox>` when more than one
`dl-session-*` sandbox exists). It fetches the `sandbox-<name>` git remote and,
for each branch with new commits:

- refuses an unsafe branch name, a merge commit, and commits on `main` (your
  `main` is never moved);
- lists the protected files it touches (`session.protectedPaths`). Such a
  branch is fetched but **not** made into a local branch until you have read
  the diff and rerun with `--allow-protected`;
- rebuilds each commit with your key (`git commit-tree -S`: same tree, same
  message, your identity), checks the tree is unchanged and every commit is
  signed, then creates the local branch. An existing local branch is never
  moved.

It never pushes or checks anything out. It prints:

```
Synced from sandbox "dl-session-20261120-224501" (checked and re-signed, nothing pushed):

  feat/run-watcher  3 commits  +120 −4  7 files  ✓ no protected files

Report: .overnight/out/report.md

Next:
  git diff main..feat/run-watcher                            # look
  git push -u origin feat/run-watcher && gh pr create        # keep: you push, then merge the PR
  git branch -D feat/run-watcher                             # drop
```

`main` on GitHub requires a PR (no direct pushes, no force-push, enforced for
admins too), so every change reaches `main` through a PR you merge. Remove the
sandbox when you're done: `sbx rm <name>`.

Checked live 2026-11-20 (sbx v0.54.0): the clone, the read-only source, the
GitHub deny (403 from inside), nexus3 `npm ci` plus the vitest and tsc runs
inside, the superpowers plugin through `--plugin-dir`, and a sync that
re-signed one branch and held back one that touched `CLAUDE.md`.
