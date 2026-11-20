#!/usr/bin/env bash
# Eval preflight (Task 16, spec §9.2): refuse to run unless the environment
# is exactly what the evals assume. Read-only; spawns no claude.
#   1. pipeline.eval.config.json loads via the real loader, its github.repo
#      and targetRepo.url are the sandbox, and both pollJql contain
#      `AND labels = "dev-loop-eval"` (evals/config-guard.mjs). Local.
#   2. gh is authenticated and the sandbox repo exists and is private.
#   3. the loop's sandbox clone, if one exists, has the sandbox as origin.
#   4. Jira auth works (evals/jira.mjs auth, read-only).
# Steps 2 and 4 are outward: with DRY_RUN=1 they are printed, not run.
set -u
. "$(dirname "$0")/lib.sh"
cd "$ROOT" || die "cannot cd to the repo root"

node "$EVALS/config-guard.mjs" "$EVAL_CONFIG" || die "preflight: $EVAL_CONFIG is not a safe eval config"
# The app-layout config, rendered for this machine's checkout, gets the same guard.
mkdir -p "$STATE_DIR" || die "cannot create $STATE_DIR"
render_app_config "$EVAL_APP_CHECKOUT" "$STATE_DIR/pipeline.eval-app.config.json"
node "$EVALS/config-guard.mjs" "$STATE_DIR/pipeline.eval-app.config.json" || die "preflight: the app-layout eval config is not safe"

outward gh auth status >/dev/null || die "preflight: gh is not authenticated"
private=$(outward gh repo view "$SANDBOX" --json isPrivate --jq .isPrivate) || die "preflight: sandbox repo $SANDBOX not reachable"
is_dry || [ "$private" = true ] || die "preflight: sandbox repo $SANDBOX is not private"

CLONE="$ROOT/.pipeline/v2/dev-loop-eval-sandbox/repo"
[ -d "$CLONE" ] && assert_clone "$CLONE"

jira auth || die "preflight: Jira auth failed"
log "preflight OK"
