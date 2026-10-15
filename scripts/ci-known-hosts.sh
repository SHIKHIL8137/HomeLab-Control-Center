#!/usr/bin/env bash
# Builds the SSH known_hosts file for the deploy jobs from the HOMESERVER_HOST_KEY secret.
#
#   HOMESERVER_HOST=100.88.33.71 HOMESERVER_HOST_KEY='100.88.33.71 ssh-ed25519 AAAA...' \
#     scripts/ci-known-hosts.sh ~/.ssh/known_hosts
#
# The secret must hold ONE complete known_hosts entry: "<host> ssh-ed25519 <key>", where <host> is
# exactly HOMESERVER_HOST (the name or IP the workflow connects to). Anything else is refused, so a
# wrong or doubled entry fails here instead of producing a confusing SSH error. Strict host-key
# checking stays on in the workflow; this only builds the file it checks against.
# The entry is public data, but it is never echoed on failure: messages are generic.
set -euo pipefail

host="${HOMESERVER_HOST:-}"
entry="${HOMESERVER_HOST_KEY:-}"
out="${1:-}"

fail() { echo "ci-known-hosts: $1" >&2; exit 1; }

[ -n "$out" ] || fail "usage: ci-known-hosts.sh OUTFILE"
[[ $host =~ ^[A-Za-z0-9._:-]+$ ]] || fail "HOMESERVER_HOST is empty or has unexpected characters"
entry=${entry//$'\r'/}
while [[ $entry == *$'\n' ]]; do entry=${entry%$'\n'}; done # secret stores often add a final newline
[ -n "$entry" ] || fail "HOMESERVER_HOST_KEY is empty"
[ "$(printf '%s\n' "$entry" | wc -l)" = 1 ] || fail "HOMESERVER_HOST_KEY must be exactly one line"

read -r h type key rest <<< "$entry"
[ "$h" = "$host" ] \
  || fail "HOMESERVER_HOST_KEY must start with HOMESERVER_HOST (a complete known_hosts entry: '<host> ssh-ed25519 <key>')"
[ "$type" = ssh-ed25519 ] || fail "HOMESERVER_HOST_KEY must be an ssh-ed25519 key"
[ -z "${rest:-}" ] || fail "HOMESERVER_HOST_KEY has extra fields after the key"
[[ $key =~ ^AAAAC3NzaC1lZDI1NTE5AAAA[A-Za-z0-9+/]{44}$ ]] || fail "HOMESERVER_HOST_KEY does not look like an ed25519 public key"

line="$host ssh-ed25519 $key"
printf '%s\n' "$line" | ssh-keygen -lf - > /dev/null 2>&1 || fail "ssh-keygen cannot parse the host key"

mkdir -p "$(dirname "$out")"
(umask 077 && printf '%s\n' "$line" > "$out")
# Public fingerprint, so the job log shows exactly which server key the deploy trusts.
echo "ci-known-hosts: trusting $(printf '%s\n' "$line" | ssh-keygen -lf - | cut -d' ' -f2) for $host"
