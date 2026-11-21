# dev-loop-eval-sandbox

The eval harness's target (`evals/`), `JustinChan-fd/dev-loop-eval-sandbox`.
Two configs point at it:

| | Root layout (`pipeline.eval.config.json`) | App layout (`evals/pipeline.eval-app.config.template.json`) |
|---|---|---|
| Scenarios | `clean`, `ambiguous`, `dev-bounce`, `blocked`, `queue` | `clean-app` |
| Layout | `package.json` at the root, like webtarsthree | `app/` sub-project, like catalog (seeded from `evals/sandbox-app/`) |
| Node | host | `app/.nvmrc` = 24 (dev-loop's minimum, behind the latest LTS) |
| Env template | root `.envrc.example` | `app/.env.example`, plain dotenv |
| Hooks | none | `app/.husky/pre-push`: `cd app && npm test` |
| Checkout | the v2 clone | `${EVAL_APP_CHECKOUT:-$HOME/.cache/dev-loop-eval/sandbox}`, outside dev-loop's folder (the sbx preflight refuses a planted `.envrc` inside it) |
| sbx template | `dev-loop-sbx:v2` | `dev-loop-sbx:v2` |

`EVAL_SANDBOX=none|sbx` picks the sandbox for any scenario.

## How it differs from webtarsthree and catalog

It is a test repo, and it behaves differently from the real ones:

- **Jira label.** Its tickets carry `repo:dev-loop-eval` and the
  `dev-loop-eval` label. The eval config's pollJql requires
  `labels = "dev-loop-eval"`. The real repos' queries exclude it
  (`labels != "dev-loop-eval"`), so an eval ticket can never be picked up by
  a real worker. `evals/preflight.sh` refuses a config that breaks either rule.
- **Default branch: `master`**, not `main` (catalog is `main`).
- **Two layouts in one repo.** Root (`package.json` at the top, like
  webtarsthree) and `app/` (like catalog), picked by the config, as in the
  table above.
- **No real product or CI behind it.** A PR here proves the loop worked, not
  that a feature shipped. Nothing deploys and no CI gates it; the graders
  in `evals/check-*.mjs` are the only judge.
- **Fixtures pin other repos, not this one.** Fixture evals
  (`evals/README.md`, "Fixture evals") never use the sandbox repo. Each
  fixture's `repo.json` names a real project and a commit, for example
  catalog-ui-management at `3be2731f` for `mc-1435-xl`. The loop runs on a
  detached worktree at that commit, and no ticket, PR or comment is created
  anywhere.

## How it was verified

- **Config and guard:** `test/evals/harness.test.ts` loads
  `pipeline.eval.config.json` through the real loader, and checks that the
  guard refuses a non-sandbox repo or a JQL without the eval label.
- **Dry runs:** every scenario and `--fixture=<name>` dry-run in `npm test`
  with stub `gh`/`claude`/`curl`/`npm` on PATH, and no stub is called.
- **Fixture replays:** four real catalog research runs (MC-1435 ×3, MC-1718)
  replay through the loop's verdict check in `npm test`.
- **Live runs:** still pending. That means the four scenario runs (`clean`
  and `clean-app`, each with no sandbox and `EVAL_SANDBOX=sbx`) run by a
  person from their own shell, and the first live fixture run, which is
  refused until its guard hook lands.

## Known drift

`eval.enhancements.md` (phase 2).
