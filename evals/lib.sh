#!/usr/bin/env bash
# Shared helpers for the eval harness (Task 16, spec §9.2). Source this
# file; do not execute it. Ported from poc-stacked-prs/harness/lib.sh.
# Bash 3.2 compatible (macOS default): no associative arrays, no mapfile.
#
# Every outward command (GitHub, Jira, the paid loop) goes through ONE
# function, `outward`. In dry mode it prints `DRY: <cmd>` on stderr and
# runs nothing, so dry-run coverage is structural: a test greps evals/*.sh
# for any gh/curl/npm/claude call that does not start with `outward`.
#
# Dry is the DEFAULT. The mode comes from DRY_RUN:
#   unset, empty or 1  -> dry  (prints, runs nothing)
#   exactly 0          -> live (real Jira writes, real sandbox PRs, paid runs)
#   anything else      -> refused (exit 1): DRY_RUN=true is NOT live.
# It is checked when this file is sourced and again on every `outward`
# call, so a value changed after sourcing cannot turn a call live.

SANDBOX="JustinChan-fd/dev-loop-eval-sandbox"
# The repo `api` calls. Overridable only so a test can prove assert_repo
# guards it; any value but $SANDBOX is refused before a call.
EVAL_REPO="${EVAL_REPO:-$SANDBOX}"
SANDBOX_URLS="git@github.com:${SANDBOX}.git https://github.com/${SANDBOX}.git https://github.com/${SANDBOX}"
EVALS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$EVALS/.." && pwd -P)"
STATE_DIR="${EVAL_STATE_DIR:-$EVALS/.state}"
EVAL_CONFIG="${EVAL_CONFIG:-pipeline.eval.config.json}"
EVAL_LABEL="dev-loop-eval"
EVAL_PREFIX="[dev-loop-eval]"
KEY_RE='^[A-Z][A-Z0-9_]+-[0-9]+$'

log() { printf '[eval] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# Prints dry|live, or fails (non-zero, nothing printed on stdout) on a bad value.
eval_mode() {
  case "${DRY_RUN-}" in
    ""|1) echo dry ;;
    0) echo live ;;
    *)
      printf '[eval] FATAL: DRY_RUN must be unset/empty/1 (dry) or exactly 0 (live); got %s. Refusing.\n' "\"${DRY_RUN}\"" >&2
      return 1
      ;;
  esac
}

EVAL_MODE=$(eval_mode) || exit 1

is_dry() { [ "$(eval_mode)" = dry ]; }

# The one gate for every outward command. Re-parses DRY_RUN each call:
# a bad value refuses, and only exactly 0 runs the command.
outward() {
  local mode
  mode=$(eval_mode) || exit 1
  if [ "$mode" = dry ]; then
    printf 'DRY: %s\n' "$*" >&2
    return 0
  fi
  "$@"
}

# macOS has no timeout(1). Run a command with a wall-clock limit (seconds)
# that stops the whole process tree, not just the direct child (final review
# I2: `npm run loop` forwards only SIGINT/SIGTERM, so an alarm on npm left
# `node src/main.ts` and its `claude -p` child running). The command runs in
# its own process group; on timeout the group gets SIGTERM (main.ts's
# handler stops its claude child and marks the flight interrupted), then
# SIGKILL if anything in it is still alive after RUN_TO_GRACE_S seconds
# (default 40: above main.ts's KILL_GRACE_MS + POST_KILL_GRACE_MS). A
# SIGINT/SIGTERM/SIGHUP to run_to itself is forwarded to the group (it is no
# longer the terminal's foreground group). Exit status: the command's own,
# or 124 on timeout. Plain perl (core modules only), bash 3.2.
run_to() {
  local s=$1; shift
  perl -MPOSIX=WNOHANG -MTime::HiRes=sleep,time -e '
    my ($limit, $grace) = (shift, shift);
    my $pid = fork;
    die "run_to: fork failed: $!\n" unless defined $pid;
    if ($pid == 0) { setpgrp(0, 0); exec @ARGV or die "run_to: exec failed: $!\n"; }
    setpgrp($pid, $pid); # also from the parent, so the group exists before any kill
    my $status;
    my $reap = sub { my $r = waitpid($pid, WNOHANG); $status = $? if $r == $pid; return defined $status; };
    my $stop = sub {
      kill "TERM", -$pid;
      my $end = time + $grace;
      while (time < $end) { $reap->(); last unless kill 0, -$pid; sleep 0.1; }
      kill "KILL", -$pid if kill 0, -$pid;
      waitpid($pid, 0) unless defined $status;
    };
    for my $sig (qw(INT TERM HUP)) { $SIG{$sig} = sub { $stop->(); exit 128 + ($sig eq "INT" ? 2 : $sig eq "TERM" ? 15 : 1); }; }
    my $end = time + $limit;
    until ($reap->()) {
      if (time >= $end) { print STDERR "[eval] run_to: wall-clock limit ${limit}s reached; stopping the process group\n"; $stop->(); exit 124; }
      sleep 0.2;
    }
    exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
  ' "$s" "${RUN_TO_GRACE_S:-40}" "$@"
}

# run_to_log <log> <seconds> <cmd...> : run_to, with stdout+stderr also appended to <log>.
run_to_log() {
  local logf=$1; shift
  set -o pipefail
  run_to "$@" 2>&1 | tee -a "$logf"
  local rc=$?
  set +o pipefail
  return $rc
}

# Every GitHub REST call is pinned to the sandbox repo: the repo it uses
# ($EVAL_REPO) is asserted before each call.
api() { local m=$1 p=$2; shift 2; assert_repo "$EVAL_REPO"; outward gh api -X "$m" "repos/$EVAL_REPO/$p" "$@"; }

# The Jira helper, with the env file the loop uses (never read here).
jira() { outward node --env-file="${DEVLOOP_ENV_FILE:-.env}" "$EVALS/jira.mjs" "$@"; }

# A branch reset may delete: <TICKET> or <TICKET>-<slug>, plain characters only, never master.
valid_branch_for_reset() {
  case "$1" in master|main|"") return 1 ;; esac
  printf '%s' "$1" | grep -qE '^[A-Z][A-Z0-9]*-[0-9]+(-[A-Za-z0-9._-]+)?$'
}

# Refuse anything but the sandbox repo slug.
assert_repo() {
  [ "${1:-}" = "$SANDBOX" ] || die "repo is not the sandbox ($SANDBOX): ${1:-<empty>}"
}

is_sandbox_url() { local u; for u in $SANDBOX_URLS; do [ "$1" = "$u" ] && return 0; done; return 1; }

# Refuse git work anywhere except a clone whose origin (fetch AND push URL)
# is the sandbox.
assert_clone() {
  local d=$1 top prefix url push
  top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || die "not a git repo: $d"
  # d must BE the repo root, not a folder inside some other repo. Ask git
  # (an empty prefix means the root) instead of comparing path spellings:
  # on case-insensitive macOS ~/Desktop/repos and ~/Desktop/Repos are one
  # folder, and pwd -P keeps whichever case the caller typed.
  prefix=$(git -C "$d" rev-parse --show-prefix 2>/dev/null) || die "not a git repo: $d"
  [ -z "$prefix" ] || die "git root mismatch for $d (it is $prefix inside $top)"
  url=$(git -C "$d" remote get-url origin 2>/dev/null) || die "no origin in $d"
  is_sandbox_url "$url" || die "origin of $d is not the sandbox repo: $url"
  push=$(git -C "$d" remote get-url --push origin 2>/dev/null) || die "no origin push URL in $d"
  is_sandbox_url "$push" || die "origin push URL of $d is not the sandbox repo: $push"
}

valid_key() { printf '%s' "$1" | grep -Eq "$KEY_RE"; }

# The app-layout scenario's checkout (clean-app): outside dev-loop's folder,
# because the sbx preflight refuses a planted .envrc in a repo inside it.
EVAL_APP_CHECKOUT="${EVAL_APP_CHECKOUT:-$HOME/.cache/dev-loop-eval/sandbox}"
APP_CONFIG_TEMPLATE="$EVALS/pipeline.eval-app.config.template.json"

# render_app_config <checkout> <out> : the eval-app config with its
# targetRepo.path filled in (a committed config can't hold a per-machine path).
# Local file write only. The checkout must be a plain absolute path.
render_app_config() {
  case "$1" in /*) ;; *) die "app checkout must be an absolute path: $1" ;; esac
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9@._/+-]+$' || die "app checkout path has unexpected characters: $1"
  sed "s|{{CHECKOUT}}|$1|" "$APP_CONFIG_TEMPLATE" > "$2" || die "cannot write $2"
}

# plant_canary <canary> <record> <file...> : writes the canary into each of
# the checkout's real env files (local, never committed; the export form for
# a .envrc) and records it. Called only through `outward`, so a dry run
# prints the files it would write.
plant_canary() {
  local canary=$1 record=$2 f; shift 2
  for f in "$@"; do
    mkdir -p "$(dirname "$f")" || return 1
    case "$f" in
      */.envrc) printf 'export EVAL_CANARY=%s\n' "$canary" > "$f" ;;
      *) printf 'EVAL_CANARY=%s\n' "$canary" > "$f" ;;
    esac || return 1
  done
  printf '%s\n' "$canary" > "$record"
}

# EVAL_SANDBOX: unset/none (no sandbox) or sbx. Anything else is refused.
sandbox_flag() {
  case "${EVAL_SANDBOX:-none}" in
    none) printf '' ;;
    sbx) printf -- '--sandbox=sbx' ;;
    *) printf '[eval] FATAL: EVAL_SANDBOX must be unset, none or sbx; got "%s". Refusing.\n' "${EVAL_SANDBOX}" >&2; return 1 ;;
  esac
}
