#!/usr/bin/env bash
# Creates the two HomeLab Control Center secrets as independent random files, outside the repository.
#
#   scripts/provision-secrets.sh DIR
#
# - Each value is 32 random bytes from the kernel, base64url encoded (43 characters).
# - Files are created owner-only (mode 400) and are NEVER overwritten: an existing file is left
#   exactly as it is, and its contents are never read or printed.
# - DIR must not be inside a Git repository. It is created with mode 700 if it does not exist;
#   an existing directory's mode and owner are not changed.
# - Nothing is chown'ed. The container runs as uid 1000, so run this as the user with that uid
#   (or decide on ownership yourself afterwards).
# - Values are never printed. Only file names, owners and modes are.
set -eu
umask 077

dir="${1:?usage: provision-secrets.sh DIR}"
[ $# -eq 1 ] || { echo "usage: provision-secrets.sh DIR" >&2; exit 2; }
case "$dir" in /* | [A-Za-z]:/*) ;; *) echo "DIR must be an absolute path" >&2; exit 2 ;; esac

if [ "$(id -u)" = 0 ]; then
  echo "Refusing to run as root: the files would be owned by root and unreadable to the container (uid 1000)." >&2
  exit 1
fi

# A secret inside a working tree is one `git add` away from being published.
probe="$dir"
while [ ! -d "$probe" ] && [ "$probe" != / ]; do probe=$(dirname -- "$probe"); done
if git -C "$probe" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "Refusing: $dir is inside a Git repository. Choose a directory outside any repository." >&2
  exit 1
fi

[ -d "$dir" ] || mkdir -m 700 -p -- "$dir"

# 43 characters of [A-Za-z0-9_-]. Regenerate in the (astronomically unlikely) case of low variety.
random_value() {
  local v
  while :; do
    v=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
    [ "${#v}" -ge 32 ] && [ "$(printf '%s' "$v" | fold -w1 | sort -u | wc -l)" -ge 12 ] && break
  done
  printf '%s' "$v"
}

for name in docker_proxy_token setup_token; do
  f="$dir/$name"
  if [ -e "$f" ]; then
    echo "kept     $f (already exists; not read, not changed)"
    continue
  fi
  # noclobber makes creation fail rather than overwrite if the file appears in the meantime.
  ( set -C; random_value > "$f" )
  chmod 400 -- "$f"
  echo "created  $f"
done

echo
stat -c '%n  owner=%U(%u) mode=%a size=%s' -- "$dir" "$dir"/docker_proxy_token "$dir"/setup_token
echo
echo "Next: put these two paths in your env file as HLCC_SECRET_DOCKER_TOKEN_FILE and"
echo "HLCC_SECRET_SETUP_TOKEN_FILE, then run scripts/ubuntu-preflight.sh --secret <path> for each."
echo "The two values are independent, so one leaking does not reveal the other."
