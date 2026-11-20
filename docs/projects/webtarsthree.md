# webtarsthree

The project dev-loop was built against. Its profile is the defaults, so its
config has no `targetRepo.local` block.

| | |
|---|---|
| Config | `pipeline.webtarsthree.config.json` |
| Default branch | `master` |
| Layout | `package.json` at the repo root (`appDir` `.`) |
| Node | the host's (no version file); 24 today |
| Env template | root `.envrc.example`, `export NAME=value` |
| Real env | root `.envrc`, loaded by direnv (denied to the robot) |
| Dev server | `npm run dev`, `http://localhost:3000` |
| Login | a login form locally; anything behind it is **unverified (needs human)** in QA |
| Git hooks | none |
| Repo rules | none beyond its own conventions |
| sbx template | `docker.io/library/dev-loop-sbx:v2` (Node 24) |

## Known quirks

- A person's own worktree under `.claude/worktrees/` (e.g. `okta-wave-1`)
  gets their real root `.envrc` through the fake's handover, never the
  fake values.

## How it was verified

Landed PRs through v2 with no sandbox and with sbx (e.g. TARS-1634, PR #587).

## Known drift

`webtarsthree.enhancements.md` (phase 2).
