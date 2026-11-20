#!/bin/sh
# Runs INSIDE the template-build sandbox (as the sandbox user, `agent`), via
# `npm run sbx:template:build`. Edit this file to add packages or settings,
# then rebuild under a new tag. See docs/sandbox-sbx.md.
#
# Args: <node major>
set -eu

NODE_MAJOR="$1"

# --- wait for the image's own apt run ---------------------------------------
# A fresh sandbox may still be running apt-get at boot; it holds the apt lock
# and nodesource's `apt update` fails on it. Wait up to 5 minutes.
apt_busy() {
  for c in /proc/[0-9]*/comm; do
    case "$(cat "$c" 2>/dev/null)" in apt|apt-get|dpkg|unattended-upgr) return 0 ;; esac
  done
  return 1
}
i=0
while apt_busy; do
  i=$((i + 1))
  if [ "$i" -gt 150 ]; then echo "template.sh: apt still busy after 5 minutes" >&2; exit 1; fi
  sleep 2
done

# --- packages -------------------------------------------------------------
# Debian's own nodejs is too old; nodesource provides each major.
# Needs: sbx policy allow network deb.nodesource.com (once, by you).
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
sudo apt-get install -y nodejs jq direnv
# Add more apt packages here, e.g.:
# sudo apt-get install -y ripgrep

# --- git ------------------------------------------------------------------
# No ~/.ssh in the sandbox: SSH remotes go over HTTPS, where the proxy adds the token.
git config --global url."https://github.com/".insteadOf git@github.com:
# The image has no pager; git would fail with "unable to execute pager".
git config --global core.pager cat

# --- direnv ---------------------------------------------------------------
# The skills run target-repo commands through `direnv exec`, so direnv is
# installed here. The template allows nothing: the loop allows its own fake
# .envrc (never a person's real one) in each run's sandbox.

# --- check ----------------------------------------------------------------
node --version
jq --version
git --version
gh --version | head -1
direnv version
echo "template-build: ok"
