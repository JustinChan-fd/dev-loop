# catalog-ui-management

The media catalog admin UI (MC tickets). Onboarded by the project-profiles
change (2026-11-20).

| | |
|---|---|
| Config | `pipeline.catalog-ui-management.config.json` |
| Default branch | `main` |
| Layout | `package.json` under `app/` (`appDir` `app`); git, `CLAUDE.md` and `AGENTS.md` at the root |
| Node | `app/.nvmrc` = 26 (`engines >=26`); the loop puts the host's nvm v26 on the robot's `PATH` |
| Env template | `app/.env.example`, plain `NAME=value` (`format: "dotenv"`) |
| Real env | `app/.env.local`, read by the BFF (`node --env-file-if-exists`) and Vite's `loadEnv` (denied to the robot; `realEnvFiles`) |
| Dev server | `npm run dev` in `app/`: Vite on `:3000`, BFF on `:4001` |
| Login | a login form (`LoginPage.jsx`, `AuthContext.jsx`); there is no bypass in code. Anything behind it is **unverified (needs human)** in QA |
| Git hooks | husky in `app/.husky`: pre-commit validators, pre-push `cd app && npm run test:coverage` |
| sbx template | `docker.io/library/dev-loop-sbx:v2-node26` (`npm run sbx:template:build -- --tag=v2-node26 --node=26`) |

## The repo's own rules (the robot follows them)

From its `CLAUDE.md`, which the skills read and follow:

- Generators first (`node tools/run.mjs <generator>`; see `tools/registry.json`).
- Never `fireEvent`: `userEvent.setup()` then `await user.click(...)`. The pre-commit hook blocks it.
- Tests follow the scaffold in `docs/testing/README.md`; the pre-commit hook blocks a test file missing its sections.
- No `--no-verify`, no force push. A hook failure the robot can't fix within the ticket is a bounce.

## Known quirks

- **`.env.local` wins over the fake for Vite.** `vite.config.ts` copies
  `process.env`, then overwrites `AUTH_*`/`DD_*`/`SERVER_*` from
  `.env.local`. Robot worktrees never have one (it isn't committed), and the
  robot must never create one.
- **The person handover.** The repo has no root `.envrc`, so the fake
  exports nothing in a shell without `DEVLOOP_ROBOT_ENV` (a person's own
  worktree, e.g. `mc-1232-link-cast-crew`), and their `app/.env.local` wins.
- MC-1336 still carries the old `pipeline:research` label; harmless, left alone.

## How it was verified

- 2026-11-20: `--preflight-only` passes with no sandbox:
  `project: app folder app, node 26 (app/.nvmrc)`,
  `robot env: 6 fake setting(s) from app/.env.example`.
- The `v2-node26` image was built. The sbx preflight still waits on
  `sbx mcp auth atlassian`.
- First landed PR: pending (then flip the README row to supported).

## Known drift

`catalog-ui-management.enhancements.md` (phase 2).
