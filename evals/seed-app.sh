#!/usr/bin/env bash
# Seed the sandbox repo with the app-layout sub-project (clean-app):
# copies evals/sandbox-app/ to app/ in a temp clone of the sandbox, commits
# and pushes to master. Outward: dry by default (prints every git/gh call),
# DRY_RUN=0 to push. Ask before running it live.
#   bash evals/seed-app.sh
set -u
. "$(dirname "$0")/lib.sh"
assert_repo "$EVAL_REPO"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/seed-app.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$TMP"' EXIT
CLONE="$TMP/sandbox"

outward gh repo clone "$EVAL_REPO" "$CLONE" || die "clone failed"
if ! is_dry; then
  assert_clone "$CLONE"
  [ ! -e "$CLONE/app" ] || die "the sandbox already has app/: nothing to seed (remove it by hand first if you mean to reseed)"
  mkdir -p "$CLONE/app" && cp -R "$EVALS/sandbox-app/." "$CLONE/app/" || die "copy failed"
fi
outward git -C "$CLONE" add app || die "git add failed"
outward git -C "$CLONE" commit -m "chore: app/ sub-project for the clean-app eval (dev-loop project profiles)" || die "commit failed"
outward git -C "$CLONE" push origin master || die "push failed"
log "seeded app/ into $EVAL_REPO$(is_dry && echo ' (dry: nothing pushed)')"
