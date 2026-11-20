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

## How it was verified

Pending: the four live runs (`clean` and `clean-app`, each with no sandbox
and `EVAL_SANDBOX=sbx`), run by a person from their own shell.

## Known drift

`eval.enhancements.md` (phase 2).
