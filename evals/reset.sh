#!/usr/bin/env bash
# Clean up after evals (Task 16, spec §9.2). Prints what it would close and
# closes nothing unless --write is passed:
#   bash evals/reset.sh            list only
#   bash evals/reset.sh --write    close them
#
# A Jira ticket is eligible only if ALL hold: its key is in
# $STATE_DIR/keys (written by run.sh), it carries the dev-loop-eval label,
# and its summary starts with [dev-loop-eval] (checked live by
# `jira.mjs eligible`; `jira.mjs close` re-checks before writing). Open
# sandbox PRs whose head branch starts with an eligible key are closed,
# open mirror Issues whose title starts "<KEY>:" are closed as not planned,
# and branches named "<KEY>" or "<KEY>-*" are deleted, all only on the sandbox
# repo, behind assert_repo. Nothing else is touched; master never matches;
# the keys file is kept (append-only history). The clean-app canary files
# ($EVAL_APP_CHECKOUT/app/.env.local and .envrc) are removed with --write.
set -u
. "$(dirname "$0")/lib.sh"
cd "$ROOT" || die "cannot cd to the repo root"

WRITE=0
case "${1:-}" in
  "") ;;
  --write) WRITE=1 ;;
  *) die "usage: bash evals/reset.sh [--write]" ;;
esac

KEYS_FILE="$STATE_DIR/keys"
[ -f "$KEYS_FILE" ] || { log "no $KEYS_FILE: nothing to reset"; exit 0; }

ELIGIBLE=""
for key in $(sort -u "$KEYS_FILE"); do
  if ! valid_key "$key"; then
    log "skipping a malformed line in the keys file"
    continue
  fi
  if jira eligible "$key"; then
    ELIGIBLE="$ELIGIBLE $key"
  else
    log "$key: not an eval ticket (label/prefix missing): skipped"
  fi
done
log "eligible:${ELIGIBLE:- none}$(is_dry && echo ' (DRY_RUN: eligibility not checked)')"

assert_repo "$EVAL_REPO"
PRS=$(api GET "pulls?state=open&per_page=100" --jq '.[] | "\(.number) \(.head.ref)"') || die "listing sandbox PRs failed"
CLOSE_PRS=""
for key in $ELIGIBLE; do
  while read -r n ref; do
    [ -n "${n:-}" ] || continue
    case "$ref" in "$key"|"$key"-*) CLOSE_PRS="$CLOSE_PRS $n" ;; esac
  done <<EOF
$PRS
EOF
done
log "sandbox PRs:${CLOSE_PRS:- none}"

# Every run also leaves a mirror Issue ("<KEY>: ...") and a pushed branch (TARS-1642).
ISSUES=$(api GET "issues?state=open&per_page=100" --jq '.[] | select(.pull_request == null) | "\(.number) \(.title)"') || die "listing sandbox Issues failed"
BRANCHES=$(api GET "branches?per_page=100" --jq '.[].name') || die "listing sandbox branches failed"
CLOSE_ISSUES=""
DELETE_BRANCHES=""
for key in $ELIGIBLE; do
  while read -r n title; do
    [ -n "${n:-}" ] || continue
    case "$title" in "$key:"*) CLOSE_ISSUES="$CLOSE_ISSUES $n" ;; esac
  done <<EOF
$ISSUES
EOF
  while read -r b; do
    [ -n "${b:-}" ] || continue
    case "$b" in "$key"|"$key"-*) DELETE_BRANCHES="$DELETE_BRANCHES $b" ;; esac
  done <<EOF
$BRANCHES
EOF
done
log "sandbox Issues:${CLOSE_ISSUES:- none}"
log "sandbox branches:${DELETE_BRANCHES:- none}"

if [ "$WRITE" -ne 1 ]; then
  log "list only; pass --write to close the tickets, PRs and Issues and delete the branches above"
  exit 0
fi

# The canary files clean-app planted in its checkout (local only).
for f in "$EVAL_APP_CHECKOUT/app/.env.local" "$EVAL_APP_CHECKOUT/.envrc"; do
  if is_dry || [ -f "$f" ]; then outward rm -f "$f" || log "$f: remove failed"; fi
done

for key in $ELIGIBLE; do jira close "$key" || log "$key: close failed"; done
for n in $CLOSE_PRS; do
  assert_repo "$EVAL_REPO"
  api PATCH "pulls/$n" -f state=closed >/dev/null || log "PR #$n: close failed"
done
for n in $CLOSE_ISSUES; do
  assert_repo "$EVAL_REPO"
  api PATCH "issues/$n" -f state=closed -f state_reason=not_planned >/dev/null || log "Issue #$n: close failed"
done
for b in $DELETE_BRANCHES; do
  assert_repo "$EVAL_REPO"
  valid_branch_for_reset "$b" || { log "branch $b: refused (unexpected name)"; continue; }
  api DELETE "git/refs/heads/$b" >/dev/null || log "branch $b: delete failed"
done
log "reset done"
