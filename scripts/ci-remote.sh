#!/usr/bin/env bash
# The only way the GitHub workflows talk to the home server. Run from a checkout of the commit.
#
#   scripts/ci-remote.sh check    read-only diagnostics from the server-resident script; sends nothing
#   scripts/ci-remote.sh deploy   sends `git archive HEAD` and asks the server to deploy it
#
# Environment (Actions secrets): DEPLOY_SSH_KEY HOMESERVER_HOST HOMESERVER_HOST_KEY DEPLOY_USER
# The two commands are the exact forms the forced command on the server accepts, nothing else.
# Strict host-key checking stays on: the server must present the key in HOMESERVER_HOST_KEY.
set -euo pipefail

mode="${1:-}"
case "$mode" in check | deploy) ;; *) echo "usage: ci-remote.sh check|deploy" >&2; exit 2 ;; esac

# Names only, never values: this is what turns "OAuth identity empty" style failures into a clear message.
missing=""
for n in DEPLOY_SSH_KEY HOMESERVER_HOST HOMESERVER_HOST_KEY DEPLOY_USER; do
  [ -n "${!n:-}" ] || missing="$missing $n"
done
if [ -n "$missing" ]; then
  echo "::error::Missing or empty Actions secrets:$missing. Create them as secrets (not variables) on the repository or the production environment."
  exit 1
fi
[[ $DEPLOY_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "::error::DEPLOY_USER is not a plain user name"; exit 1; }
[ "$DEPLOY_USER" != root ] || { echo "::error::deployment never uses root"; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="${SSH_DIR:-$HOME/.ssh}"
(umask 077 && mkdir -p "$dir")
(umask 077 && printf '%s\n' "${DEPLOY_SSH_KEY//$'\r'/}" > "$dir/deploy_key")
"$here/ci-known-hosts.sh" "$dir/known_hosts"

ssh_cmd=(ssh -i "$dir/deploy_key" -o IdentitiesOnly=yes -o BatchMode=yes -o PreferredAuthentications=publickey
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$dir/known_hosts" -o ConnectTimeout=30
  "$DEPLOY_USER@$HOMESERVER_HOST")

if [ "$mode" = check ]; then
  out=$("${ssh_cmd[@]}" check < /dev/null)
  printf '%s\n' "$out"
  # The server reports its own problems; do not go on to a deploy when it says it is not ready.
  if grep -q -e 'UNFINISHED DEPLOY MARKER PRESENT' -e '^configuration problems:' <<< "$out"; then
    echo "::error::the server reports it is not ready to deploy (see the check output above)"
    exit 1
  fi
  exit 0
fi

sha=$(git rev-parse HEAD)
[ -z "${GITHUB_SHA:-}" ] || [ "$sha" = "$GITHUB_SHA" ] || { echo "::error::checkout is not the triggering commit"; exit 1; }
tree=$(git rev-parse 'HEAD^{tree}')
# The server verifies that what it unpacks hashes to this tree before building anything.
git archive --format=tar HEAD | "${ssh_cmd[@]}" "deploy $sha $tree"
