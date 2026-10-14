#!/usr/bin/env bash
# Server-resident deploy script. The owner installs it ONCE (see docs/cicd.md) and the CI deploy key
# is restricted to run only this file. Releases never replace it: it is the trust anchor, so it
# changes only when a person reviews and reinstalls it.
#
#   ssh ... "deploy <40-hex commit> <40-hex tree>"   (release = `git archive` tarball on stdin)
#
# What it does, in order, and refuses to continue when a step fails:
#   1. validate the request, take a lock, unpack the release into a staging directory
#   2. verify the unpacked files hash to the expected Git tree (the release is what CI built)
#   3. refuse to build while the server is busy
#   4. back up the database to the other disk and check the backup (a failed backup stops here)
#   5. tag the running images as :previous, build the new ones at lowest priority
#   6. start ONLY the homelab-control-center project, wait for health, run smoke checks
#   7. on any failure after step 5: put the previous images back and report
# It never prunes, never deletes volumes, and never runs a command against another project.
set -euo pipefail
umask 077

HLCC_HOME="${HLCC_HOME:-$HOME/hlcc}"
HLCC_ROOT="${HLCC_ROOT:-/srv/projects/homelab-control-center}"
HLCC_BACKUP_DIR="${HLCC_BACKUP_DIR:-/srv/storage/hlcc-backups}"
HLCC_BACKUP_MOUNT="${HLCC_BACKUP_MOUNT-/srv/storage}" # must be a real mount point; set to empty to disable
HLCC_ENV_FILE="${HLCC_ENV_FILE:-$HLCC_HOME/hlcc.env}"
HLCC_MAX_LOAD="${HLCC_MAX_LOAD:-4}"
HLCC_LOADAVG_FILE="${HLCC_LOADAVG_FILE:-/proc/loadavg}"
HLCC_HEALTH_TIMEOUT="${HLCC_HEALTH_TIMEOUT:-180}"
HLCC_MIN_FREE_MB="${HLCC_MIN_FREE_MB:-2048}"
PROJECT=homelab-control-center
LOG="$HLCC_HOME/deploy.log"

die() { echo "deploy: $*" >&2; exit "${2:-1}"; }
say() { echo "deploy: $*"; }

# ---- 1. validate the request -------------------------------------------------------------------
read -r cmd sha tree extra <<< "${SSH_ORIGINAL_COMMAND:-$*}"
[ "${cmd:-}" = deploy ] && [[ "${sha:-}" =~ ^[0-9a-f]{40}$ ]] && [[ "${tree:-}" =~ ^[0-9a-f]{40}$ ]] \
  && [ -z "${extra:-}" ] || die "usage: deploy <40-hex commit> <40-hex tree>" 2
[ -f "$HLCC_ENV_FILE" ] || die "missing env file $HLCC_ENV_FILE" 2
command -v flock > /dev/null || die "flock is required"
mkdir -p "$HLCC_HOME" "$HLCC_ROOT/releases"
exec 9> "$HLCC_HOME/deploy.lock"
flock -n 9 || die "another deploy is running" 75
exec > >(tee -a "$LOG") 2>&1
say "start $(date -Is) commit $sha"

# Unpack first so the sender's pipe is always drained, whatever we decide next.
staging="$HLCC_ROOT/releases/.incoming-$sha-$$"
cleanup_staging() { if [ -n "${staging:-}" ]; then rm -rf -- "$staging"; fi; }
trap cleanup_staging EXIT
mkdir -p "$staging"
timeout 120 head -c $((200 * 1024 * 1024)) | tar -x --no-same-owner -f - -C "$staging"
[ -z "$(find "$staging" -type l -print -quit)" ] || die "release contains a symlink; refusing"
[ -f "$staging/deploy/compose.yaml" ] || die "release has no deploy/compose.yaml"

# ---- 2. the files must hash to the tree CI built -----------------------------------------------
actual=$(git -C "$staging" init -q . && git -C "$staging" add -A && git -C "$staging" write-tree)
rm -rf -- "$staging/.git"
[ "$actual" = "$tree" ] || die "tree mismatch (expected $tree, got $actual); refusing"
say "release verified"

current=""
[ -f "$HLCC_ROOT/.deployed-sha" ] && current=$(tr -d '[:space:]' < "$HLCC_ROOT/.deployed-sha")
if [ "$current" = "$sha" ]; then
  say "commit $sha is already deployed; nothing to do"
  exit 0
fi

# ---- 3. the server must have room to build -----------------------------------------------------
if [ -r "$HLCC_LOADAVG_FILE" ]; then
  load=$(cut -d' ' -f1 "$HLCC_LOADAVG_FILE")
  awk -v l="$load" -v m="$HLCC_MAX_LOAD" 'BEGIN{exit !(l<m)}' || die "server busy (load $load >= $HLCC_MAX_LOAD); not deploying" 75
fi
free_mb=$(df --output=avail -B1M "$HLCC_ROOT" | tail -1 | tr -d ' ')
[ "$free_mb" -ge "$HLCC_MIN_FREE_MB" ] || die "only ${free_mb} MB free; need $HLCC_MIN_FREE_MB"

# ---- compose invocations (this project only) ---------------------------------------------------
tunnel=false
grep -q '^HLCC_TUNNEL_NETWORK=true$' "$HLCC_ENV_FILE" && tunnel=true
dc() { # dc <release-dir> <compose args...>
  local dir="$1"; shift
  local files=(-f "$dir/deploy/compose.yaml")
  $tunnel && [ -f "$dir/deploy/compose.tunnel.yaml" ] && files+=(-f "$dir/deploy/compose.tunnel.yaml")
  docker compose --project-name "$PROJECT" --env-file "$HLCC_ENV_FILE" "${files[@]}" "$@"
}
prev_dir="$HLCC_ROOT"
[ -n "$current" ] && [ -d "$HLCC_ROOT/releases/$current" ] && prev_dir="$HLCC_ROOT/releases/$current"
rel="$HLCC_ROOT/releases/$sha"
if [ -e "$rel" ]; then rm -rf -- "$staging"; else mv -- "$staging" "$rel"; fi
staging=""

healthy() { # both services report healthy
  local out
  out=$(dc "$1" ps --format '{{.Service}} {{.Health}}' 2> /dev/null) || return 1
  [ "$(grep -c ' healthy$' <<< "$out")" -ge 2 ]
}
wait_healthy() {
  local end=$((SECONDS + HLCC_HEALTH_TIMEOUT))
  until healthy "$1"; do
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep "${HLCC_HEALTH_POLL:-3}"
  done
}

# ---- 4. back up the database first -------------------------------------------------------------
backup=""
if cid=$(dc "$prev_dir" ps -q hlcc 2> /dev/null) && [ -n "$cid" ]; then
  [ -z "$HLCC_BACKUP_MOUNT" ] || mountpoint -q "$HLCC_BACKUP_MOUNT" || die "$HLCC_BACKUP_MOUNT is not a mount point; no safe place for a backup"
  backup="$HLCC_BACKUP_DIR/pre-${sha:0:7}-$(date +%Y%m%d-%H%M%S)"
  mkdir -p -m 700 "$backup"
  tmp="backup-pre-${sha:0:7}.db"
  data_path=$(grep '^HLCC_DATA_PATH=' "$HLCC_ENV_FILE" | cut -d= -f2-)
  rm -f -- "$data_path/$tmp" # left over from an interrupted run: VACUUM INTO refuses an existing file
  docker exec "$cid" node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/hlcc.db').exec(\"VACUUM INTO '/data/$tmp'\")"
  cp -- "$data_path/$tmp" "$backup/hlcc.db"
  chmod 600 "$backup/hlcc.db"
  [ "$(sha256sum < "$data_path/$tmp")" = "$(sha256sum < "$backup/hlcc.db")" ] || die "backup copy does not match"
  rm -f -- "$data_path/$tmp"
  check=$(docker run --rm -v "$backup":/b:ro --entrypoint node "$PROJECT:local" -e \
    "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/b/hlcc.db',{readOnly:true}).prepare('pragma integrity_check').get().integrity_check)")
  [ "$check" = ok ] || die "backup failed its integrity check"
  say "database backed up to $backup (integrity ok)"
else
  say "no running dashboard found; skipping the backup"
fi

# ---- 5. build ----------------------------------------------------------------------------------
for img in "$PROJECT" "$PROJECT-docker-proxy"; do
  docker image inspect "$img:local" > /dev/null 2>&1 && docker tag "$img:local" "$img:previous"
done
low_priority=(nice -n 19)
command -v ionice > /dev/null && low_priority+=(ionice -c3)

rollback() {
  say "FAILED: restoring the previous images"
  local ok=true
  for img in "$PROJECT" "$PROJECT-docker-proxy"; do
    docker image inspect "$img:previous" > /dev/null 2>&1 && docker tag "$img:previous" "$img:local" || ok=false
  done
  if $ok && dc "$prev_dir" up -d --no-build && wait_healthy "$prev_dir"; then
    say "ROLLED BACK to ${current:-the previous images}; the failed release stays in $rel for inspection"
  else
    say "ROLLBACK DID NOT COMPLETE: inspect with 'docker compose --project-name $PROJECT ps'"
  fi
  [ -z "$backup" ] || say "database backup from before this deploy: $backup (restore is manual; see docs/backup-and-recovery.md)"
}
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "${deploying:-0}" = 1 ]; then rollback; fi
  cleanup_staging
  exit "$rc"
}
trap on_exit EXIT

deploying=1
say "building (lowest priority)"
"${low_priority[@]}" docker compose --project-name "$PROJECT" --env-file "$HLCC_ENV_FILE" \
  -f "$rel/deploy/compose.yaml" build > /dev/null

# ---- 6. start, wait, smoke-test ----------------------------------------------------------------
say "starting"
dc "$rel" up -d --no-build
wait_healthy "$rel" || die "services did not become healthy within ${HLCC_HEALTH_TIMEOUT}s"
port=$(grep '^HLCC_PORT=' "$HLCC_ENV_FILE" | cut -d= -f2-)
port="${port:-8787}"
curl -fsS -m 10 "http://127.0.0.1:$port/api/v1/health" > /dev/null || die "health endpoint failed"
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$port/api/v1/overview")
[ "$code" = 401 ] || die "unauthenticated request returned $code, expected 401"
cid=$(dc "$rel" ps -q hlcc)
docker exec "$cid" sh -c 'test ! -e /var/run/docker.sock' || die "the API container can see the Docker socket"

deploying=0
echo "$sha" > "$HLCC_ROOT/.deployed-sha"
say "DONE $(date -Is): $sha is live (previous: ${current:-none}, backup: ${backup:-none})"
