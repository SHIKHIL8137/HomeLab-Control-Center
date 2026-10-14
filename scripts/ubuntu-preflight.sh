#!/usr/bin/env bash
# Read-only checks to run ON the Ubuntu server before the first deployment.
#
# It never reads a secret value, never changes ownership or permissions, never starts, stops or
# restarts anything, and never touches Cloudflare or Tailscale. Secret files are inspected with
# stat (owner, mode, size) only. It does not call `docker inspect` (that would print a container's
# environment and command, which can hold a tunnel token).
#
# Usage: scripts/ubuntu-preflight.sh [--secret FILE]... [--storage /srv/storage] [--port 8787]
set -u
export LC_ALL=C

storage=/srv/storage
port=8787
secrets=()
while [ $# -gt 0 ]; do
  case "$1" in
    --secret) secrets+=("${2:?--secret needs a path}"); shift 2 ;;
    --storage) storage="${2:?--storage needs a path}"; shift 2 ;;
    --port) port="${2:?--port needs a number}"; shift 2 ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$port" in '' | *[!0-9]*) echo "--port must be a number" >&2; exit 2 ;; esac

section() { printf '\n== %s ==\n' "$1"; }
# Runs a command, showing its output; a missing tool or a failure is reported, never fatal.
run() {
  printf '$ %s\n' "$*"
  "$@" 2>&1 || printf '(exit %s)\n' "$?"
}
have() { command -v "$1" > /dev/null 2>&1; }

section "Host"
run uname -sr
run id -u
echo "(run as the deploy user, not root: a root run cannot show what uid 1000 will be able to read)"

section "Docker version and docker group id"
if have docker; then
  run docker --version
  run docker compose version
  run docker info --format 'server={{.ServerVersion}} cgroup={{.CgroupVersion}} driver={{.Driver}} root={{.DockerRootDir}}'
else
  echo "docker not found"
fi
run getent group docker
printf 'DOCKER_GID would be: '
getent group docker | cut -d: -f3

section "Memory (the stack is limited to roughly 320 MiB in total)"
run free -h

section "Disk space and mounts"
run df -h / "$storage"
run findmnt "$storage"
if findmnt -rn "$storage" > /dev/null 2>&1; then
  echo "RESULT: $storage is a mount point"
else
  echo "RESULT: $storage is NOT a mount point (the dashboard would flag it as 'not a separate mount')"
fi
run lsblk -f

section "Existing Docker networks and containers (names, images, networks; no environment)"
if have docker; then
  run docker network ls --format '{{.Name}}  driver={{.Driver}}  scope={{.Scope}}'
  run docker ps --format '{{.Names}}  image={{.Image}}  status={{.Status}}  networks={{.Networks}}'
  echo "Name check: a network called hlcc-docker or a container called hlcc / hlcc-docker-proxy must not already exist"
  docker network ls --format '{{.Name}}' | grep -E '^(hlcc|deploy_hlcc)' || echo "none found (good)"
else
  echo "docker not found"
fi

section "Secret files (metadata only: the contents are never opened)"
if [ "${#secrets[@]}" -eq 0 ]; then
  echo "no --secret FILE given; pass the planned paths to check them once they exist"
fi
for f in "${secrets[@]+"${secrets[@]}"}"; do
  if [ -e "$f" ]; then
    stat -c '%n  owner=%U(%u) group=%G(%g) mode=%a size=%s bytes' -- "$f"
    mode=$(stat -c '%a' -- "$f")
    [ $((8#$mode & 8#077)) -eq 0 ] && echo "  mode ok (owner only)" || echo "  WARN: readable by group or others"
    [ "$(stat -c '%u' -- "$f")" = 1000 ] && echo "  owner is uid 1000 (the container user)" \
      || echo "  NOTE: owner is not uid 1000; the container user could not read it. Fix is a decision for you, nothing was changed"
  else
    echo "$f: does not exist yet"
  fi
  d=$(dirname -- "$f")
  stat -c 'directory %n  owner=%U mode=%a' -- "$d" 2> /dev/null
done

section "Listeners (Netdata should not face untrusted networks; the dashboard port must be free)"
if have ss; then
  run ss -ltn
  echo "-- port $port:"
  ss -ltn | awk -v p=":$port" '$4 ~ p"$"' | grep . || echo "nothing is listening on $port (good)"
  echo "-- Netdata (19999): a listener on 0.0.0.0, [::] or '*' means it is reachable from every interface"
  ss -ltn | awk '$4 ~ /:19999$/' | grep . || echo "nothing is listening on 19999 here"
else
  echo "ss not found"
fi

section "Cloudflare tunnel and Tailscale topology (what runs, not how it is configured)"
if have docker; then
  echo "-- containers whose image name mentions cloudflared (name, networks, published ports only):"
  docker ps --format '{{.Names}}  image={{.Image}}  networks={{.Networks}}  ports={{.Ports}}' | grep -i cloudflared || echo "none"
fi
run systemctl is-active cloudflared
run systemctl is-active tailscaled
if have tailscale; then
  run tailscale serve status
fi
printf '%s
' '' 'Not inspected on purpose: tunnel tokens, container environments and commands, config files.' 'Review the Cloudflare Access application and the tunnel public hostnames in the Cloudflare' 'dashboard. Do not add or edit routes until the deployment is approved.'

section "Done"
echo "Nothing was changed. Compare the output with docs/ubuntu-preflight.md."
