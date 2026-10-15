#!/usr/bin/env bash
# Server-resident deploy script. The owner installs it ONCE (see docs/cicd.md) and the CI deploy key
# is restricted to run only this file. Releases never replace it: it is the trust anchor, so it
# changes only when a person reviews and reinstalls it.
#
#   ssh ... "check"                                   read-only diagnostics, changes nothing
#   ssh ... "deploy <40-hex commit> <40-hex tree>"    release = plain `git archive` tarball on stdin
#
# Anything else is refused. `deploy`, in order, stopping at the first failed step:
#   1. validate configuration paths; refuse if an earlier deploy never finished (.deploy-in-progress)
#   2. take a lock; receive a bounded archive, validate EVERY member, then extract regular files only
#   3. verify the extracted files hash to the expected Git tree (the release is what CI built)
#   4. refuse to build while the server is busy (load, memory, disk)
#   5. back up the database to the other disk and check the backup (a failed backup stops here)
#   6. write .deploy-in-progress, tag the running images :previous, build the new ones
#   7. start ONLY the homelab-control-center project, wait for health, run smoke checks
#   8. only then record the commit in .deployed-sha and remove .deploy-in-progress
#   On any failure after step 6 the previous images are put back; the marker is removed only when
#   the previous version is verified healthy again.
# It never prunes, never deletes volumes, and never runs a command against another project.
#
# Resource note: building happens inside dockerd, so `nice`/`ionice` on this script would not throttle
# it. What actually protects the server is the load, memory and disk gates, building one image at a
# time (COMPOSE_PARALLEL_LIMIT=1), and the memory limits in the Compose file.
set -euo pipefail
umask 077

# Test hooks: sshd does not pass these from a client (AcceptEnv is LANG/LC_* only, `restrict` blocks
# user environments), so they are not reachable through the forced command.
HLCC_HOME="${HLCC_HOME:-$HOME/hlcc}"
HLCC_ROOT="${HLCC_ROOT:-/srv/projects/homelab-control-center}"
HLCC_BACKUP_DIR="${HLCC_BACKUP_DIR:-/srv/storage/hlcc-backups}"
HLCC_BACKUP_MOUNT="${HLCC_BACKUP_MOUNT-/srv/storage}" # must be a real mount point; empty = tests only
HLCC_ENV_FILE="${HLCC_ENV_FILE:-$HLCC_HOME/hlcc.env}"
HLCC_MAX_LOAD="${HLCC_MAX_LOAD:-4}"
HLCC_MIN_MEM_MB="${HLCC_MIN_MEM_MB:-1500}"
HLCC_MIN_FREE_MB="${HLCC_MIN_FREE_MB:-2048}"
HLCC_LOADAVG_FILE="${HLCC_LOADAVG_FILE:-/proc/loadavg}"
HLCC_MEMINFO_FILE="${HLCC_MEMINFO_FILE:-/proc/meminfo}"
HLCC_HEALTH_TIMEOUT="${HLCC_HEALTH_TIMEOUT:-180}"
HLCC_MAX_ARCHIVE_BYTES="${HLCC_MAX_ARCHIVE_BYTES:-$((200 * 1024 * 1024))}"
HLCC_MAX_EXPANDED_BYTES="${HLCC_MAX_EXPANDED_BYTES:-$((500 * 1024 * 1024))}"
HLCC_MAX_ENTRIES="${HLCC_MAX_ENTRIES:-100000}"
PROJECT=homelab-control-center
LOG="$HLCC_HOME/deploy.log"
MARKER="$HLCC_ROOT/.deploy-in-progress"
export COMPOSE_PARALLEL_LIMIT=1

die() { echo "deploy: $*" >&2; exit "${2:-1}"; }
say() { echo "deploy: $*" || true; }

# ---- the request: exactly "check" or "deploy <commit> <tree>" -----------------------------------
read -r cmd sha tree extra <<< "${SSH_ORIGINAL_COMMAND:-$*}"
case "${cmd:-}" in
  check) [ -z "${sha:-}" ] || die "usage: check" 2 ;;
  deploy)
    [[ "${sha:-}" =~ ^[0-9a-f]{40}$ ]] && [[ "${tree:-}" =~ ^[0-9a-f]{40}$ ]] && [ -z "${extra:-}" ] \
      || die "usage: deploy <40-hex commit> <40-hex tree>" 2
    ;;
  *) die "usage: check | deploy <40-hex commit> <40-hex tree>" 2 ;;
esac

# ---- configuration checks (print labels only, never values from the env file) -------------------
safe_path_re='^/[A-Za-z0-9._/@+:-]*$'
dir_problem() { # dir_problem <label> <path>: prints one problem, or nothing when the directory is fine
  local label=$1 p=${2:-}
  [ -n "$p" ] || { echo "$label is empty"; return; }
  [[ $p =~ $safe_path_re ]] || { echo "$label is not an absolute path of plain characters"; return; }
  case "$p" in *//* | */./* | */../* | */. | */..) echo "$label contains an empty, . or .. component"; return ;; esac
  [ -d "$p" ] || { echo "$label is not an existing directory"; return; }
  [ ! -L "$p" ] || { echo "$label is a symlink"; return; }
  [ "$(realpath -e -- "$p")" = "$p" ] || { echo "$label resolves elsewhere (a component is a symlink)"; return; }
  [ "$(stat -c %u -- "$p")" = "$(id -u)" ] || { echo "$label is not owned by the deploy user"; return; }
  (((8#$(stat -c %a -- "$p") & 8#022) == 0)) || echo "$label is writable by group or others"
}
env_value() { # env_value KEY: the single value for KEY, or empty; fails on duplicates
  local n
  n=$(grep -c "^$1=" "$HLCC_ENV_FILE" || true)
  [ "$n" -le 1 ] || { echo "duplicate $1"; return 1; }
  grep -m1 "^$1=" "$HLCC_ENV_FILE" | cut -d= -f2- || true
}
config_problems() {
  dir_problem HLCC_HOME "$HLCC_HOME"
  dir_problem HLCC_ROOT "$HLCC_ROOT"
  if [ -L "$HLCC_ENV_FILE" ] || [ ! -f "$HLCC_ENV_FILE" ]; then
    echo "env file is missing or is a symlink"
  else
    [ "$(stat -c %u -- "$HLCC_ENV_FILE")" = "$(id -u)" ] || echo "env file is not owned by the deploy user"
    (((8#$(stat -c %a -- "$HLCC_ENV_FILE") & 8#077) == 0)) || echo "env file is readable by group or others (needs 600)"
    local data port
    data=$(env_value HLCC_DATA_PATH) || { echo "HLCC_DATA_PATH is set more than once"; data=""; }
    dir_problem HLCC_DATA_PATH "$data"
    case "$data" in "$HLCC_ROOT" | "$HLCC_ROOT"/*) echo "HLCC_DATA_PATH is inside the release directory" ;; esac
    port=$(env_value HLCC_PORT) || port=""
    [ -z "$port" ] || { [[ $port =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)); } || echo "HLCC_PORT is not a valid port"
  fi
  dir_problem HLCC_BACKUP_DIR "$HLCC_BACKUP_DIR"
  if [ -n "$HLCC_BACKUP_MOUNT" ]; then
    mountpoint -q "$HLCC_BACKUP_MOUNT" 2> /dev/null || echo "backup mount $HLCC_BACKUP_MOUNT is not a mount point"
    case "$(realpath -m -- "$HLCC_BACKUP_DIR")/" in
      "$HLCC_BACKUP_MOUNT"/*) ;;
      *) echo "HLCC_BACKUP_DIR is not inside the backup mount" ;;
    esac
  fi
}

# ---- check: read-only diagnostics ---------------------------------------------------------------
if [ "$cmd" = check ]; then
  src=$(cut -d' ' -f1 <<< "${SSH_CONNECTION:-}")
  [[ $src =~ ^[0-9A-Fa-f:.]{1,45}$ ]] || src="(invalid or absent)"
  tailnet=no
  if [[ $src =~ ^100\.([0-9]+)\.[0-9]+\.[0-9]+$ ]] && ((BASH_REMATCH[1] >= 64 && BASH_REMATCH[1] <= 127)); then tailnet=yes; fi
  echo "hlcc-deploy check"
  echo "script sha256: $(sha256sum "${BASH_SOURCE[0]}" | cut -d' ' -f1)"
  echo "source address: $src (inside 100.64.0.0/10: $tailnet)"
  echo "load: $(cut -d' ' -f1-3 "$HLCC_LOADAVG_FILE" 2> /dev/null || echo unknown)  (deploy refuses at >= $HLCC_MAX_LOAD)"
  echo "memory available MB: $(awk '/^MemAvailable:/ {print int($2/1024)}' "$HLCC_MEMINFO_FILE" 2> /dev/null || echo unknown)  (needs $HLCC_MIN_MEM_MB)"
  echo "free MB on release disk: $(df --output=avail -B1M "$HLCC_ROOT" 2> /dev/null | tail -1 | tr -d ' ' || echo unknown)  (needs $HLCC_MIN_FREE_MB)"
  for t in docker flock mountpoint python3 git tar sha256sum curl awk df timeout tee; do
    printf '%s=%s ' "$t" "$(command -v "$t" > /dev/null && echo yes || echo NO)"
  done
  echo
  problems=$(config_problems || true)
  if [ -n "$problems" ]; then echo "configuration problems:"; sed 's/^/  - /' <<< "$problems"; else echo "configuration: ok"; fi
  echo "deployed commit: $(tr -d '[:space:]' < "$HLCC_ROOT/.deployed-sha" 2> /dev/null || echo none)"
  if [ -f "$MARKER" ]; then echo "UNFINISHED DEPLOY MARKER PRESENT:"; sed 's/^/  /' "$MARKER"; else echo "no unfinished deploy marker"; fi
  if [ -e "$HLCC_HOME/deploy.lock" ] && ! flock -n "$HLCC_HOME/deploy.lock" true 2> /dev/null; then echo "a deploy is running now"; else echo "no deploy is running"; fi
  docker ps --filter "label=com.docker.compose.project=$PROJECT" --format 'container: {{.Names}} | {{.Status}}' 2> /dev/null || echo "docker not reachable"
  exit 0
fi

# ---- deploy -------------------------------------------------------------------------------------
problems=$(config_problems || true)
if [ -n "$problems" ]; then
  echo "deploy: configuration problems, nothing was changed:" >&2
  sed 's/^/  - /' <<< "$problems" >&2
  exit 2
fi
command -v flock > /dev/null || die "flock is required"
mkdir -p "$HLCC_ROOT/releases"
exec 9> "$HLCC_HOME/deploy.lock"
flock -n 9 || die "another deploy is running" 75

# A dropped SSH connection must not stop a deploy or its rollback half way: ignore HUP and PIPE, and
# let tee keep writing the log when the terminal side is gone.
trap '' HUP PIPE
if echo | tee --output-error=warn /dev/null > /dev/null 2>&1; then
  exec > >(tee --output-error=warn -a "$LOG" 9>&-) 2>&1
else
  exec > >(tee -a "$LOG" 9>&-) 2>&1
fi
say "start $(date -Is) commit $sha"

if [ -f "$MARKER" ]; then
  say "REFUSING: an earlier deploy did not finish. Marker contents:"
  sed 's/^/  /' "$MARKER" || true
  die "inspect the live state ('docker compose --project-name $PROJECT ps', the deploy log), reconcile it, then delete $MARKER to continue (docs/cicd.md)" 78
fi

# Receive a bounded archive, validate every member, then extract regular files and directories only.
staging="$HLCC_ROOT/releases/.incoming-$sha-$$"
archive="$HLCC_ROOT/releases/.incoming-$sha-$$.tar"
cleanup_staging() {
  [ -z "${staging:-}" ] || rm -rf -- "$staging"
  [ -z "${archive:-}" ] || rm -f -- "$archive"
}
trap cleanup_staging EXIT
mkdir -m 700 "$staging"
: > "$archive"
# Read one byte beyond the limit so oversized input is rejected rather than silently truncated.
timeout 120 head -c $((HLCC_MAX_ARCHIVE_BYTES + 1)) > "$archive"
archive_size=$(wc -c < "$archive")
[ "$archive_size" -le "$HLCC_MAX_ARCHIVE_BYTES" ] || die "release archive exceeds the size limit"

timeout 120 python3 - "$archive" "$staging" "$HLCC_MAX_ENTRIES" "$HLCC_MAX_EXPANDED_BYTES" << 'PYARCHIVE'
import os
import sys
import tarfile
from pathlib import Path, PurePosixPath

archive, destination, max_files, max_expanded = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
root = Path(destination).resolve()
total = 0

try:
    # "r:" accepts an uncompressed tar only; compressed input is refused, so there is no
    # decompression bomb. The workflow sends a plain `git archive` stream.
    with tarfile.open(archive, mode="r:") as tf:
        members = tf.getmembers()
        if len(members) > max_files:
            raise ValueError("too many archive entries")

        # tarfile stops quietly at a truncated header, so insist on a proper end of archive: at
        # least two zero blocks right after the last member, and nothing but zeros after that.
        with open(archive, "rb") as fh:
            fh.seek(tf.offset)
            zeros = 0
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                if chunk.count(0) != len(chunk):
                    raise ValueError("archive is truncated or has data after its end")
                zeros += len(chunk)
            if zeros < 1024:
                raise ValueError("archive is truncated or has data after its end")

        checked = []
        seen = set()
        for m in members:
            name = m.name
            path = PurePosixPath(name)
            if not name or "\0" in name or "\\" in name:
                raise ValueError("unsafe archive path")
            if path.is_absolute() or any(part in ("", ".", "..") for part in name.split("/")):
                raise ValueError("unsafe archive path")
            if name in seen:
                raise ValueError("duplicate archive path")
            seen.add(name)

            # Git release archives need only directories and regular files.
            if not (m.isdir() or m.isfile()):
                raise ValueError("release contains a symlink, hard link, or special file")
            if m.size < 0:
                raise ValueError("invalid file size")
            total += m.size
            if total > max_expanded:
                raise ValueError("expanded release exceeds the size limit")
            target = (root / name).resolve()
            if target != root and root not in target.parents:
                raise ValueError("archive path escapes staging directory")
            checked.append((m, target))

        # Nothing is written until every archive entry passes validation.
        for m, target in checked:
            if m.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tf.extractfile(m)
            if source is None:
                raise ValueError("cannot read archive file")
            with source, open(target, "xb") as out:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            os.chmod(target, 0o755 if m.mode & 0o111 else 0o644)
except (tarfile.TarError, OSError, ValueError) as exc:
    print(f"deploy: invalid release archive: {exc}", file=sys.stderr)
    sys.exit(1)
PYARCHIVE
[ -f "$staging/deploy/compose.yaml" ] || die "release has no deploy/compose.yaml"

# ---- the files must hash to the tree CI built ---------------------------------------------------
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

# ---- the server must have room to build ---------------------------------------------------------
# The release directory shares the root filesystem with Docker's data directory on this server, so
# the free-space figure below also covers the images that will be built.
if [ -r "$HLCC_LOADAVG_FILE" ]; then
  load=$(cut -d' ' -f1 "$HLCC_LOADAVG_FILE")
  awk -v l="$load" -v m="$HLCC_MAX_LOAD" 'BEGIN{exit !(l<m)}' || die "server busy (load $load >= $HLCC_MAX_LOAD); not deploying" 75
fi
if [ -r "$HLCC_MEMINFO_FILE" ]; then
  mem_mb=$(awk '/^MemAvailable:/ {print int($2/1024)}' "$HLCC_MEMINFO_FILE")
  [ "${mem_mb:-0}" -ge "$HLCC_MIN_MEM_MB" ] || die "only ${mem_mb:-0} MB of memory available (need $HLCC_MIN_MEM_MB); not deploying" 75
fi
free_mb=$(df --output=avail -B1M "$HLCC_ROOT" | tail -1 | tr -d ' ')
[ "$free_mb" -ge "$HLCC_MIN_FREE_MB" ] || die "only ${free_mb} MB free; need $HLCC_MIN_FREE_MB"

# ---- compose invocations (this project only) ----------------------------------------------------
tunnel=false
grep -q '^HLCC_TUNNEL_NETWORK=true$' "$HLCC_ENV_FILE" && tunnel=true
prev_dir="$HLCC_ROOT"
[ -n "$current" ] && [ -d "$HLCC_ROOT/releases/$current" ] && prev_dir="$HLCC_ROOT/releases/$current"
rel="$HLCC_ROOT/releases/$sha"
dc() { # dc <release-dir> <compose args...>
  local dir="$1"; shift
  local files=(-f "$dir/deploy/compose.yaml")
  if $tunnel; then
    # An older release may predate the override file. The override only attaches the existing
    # network to the `hlcc` service, which every release has, so the newest copy is compatible.
    local ov="$dir/deploy/compose.tunnel.yaml"
    [ -f "$ov" ] || ov="$rel/deploy/compose.tunnel.yaml"
    [ -f "$ov" ] && files+=(-f "$ov")
  fi
  docker compose --project-name "$PROJECT" --env-file "$HLCC_ENV_FILE" "${files[@]}" "$@"
}
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

# ---- back up the database first -----------------------------------------------------------------
backup=""
if cid=$(dc "$prev_dir" ps -q hlcc 2> /dev/null) && [ -n "$cid" ]; then
  backup="$HLCC_BACKUP_DIR/pre-${sha:0:7}-$(date +%Y%m%d-%H%M%S)"
  mkdir -m 700 "$backup"
  tmp="backup-pre-${sha:0:7}.db"
  data_path=$(env_value HLCC_DATA_PATH)
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

# ---- from here on services change: leave a durable marker --------------------------------------
write_marker() { # atomic: temp file in the same directory, then rename
  local t
  t=$(mktemp "$HLCC_ROOT/.deploy-in-progress.XXXXXX")
  printf 'commit=%s\ntree=%s\nstarted=%s\nprevious=%s\nbackup=%s\npid=%s\n' \
    "$sha" "$tree" "$(date -Is)" "${current:-none}" "${backup:-none}" "$$" > "$t"
  chmod 600 "$t"
  sync "$t" 2> /dev/null || true
  mv -f -- "$t" "$MARKER"
}
write_marker

rollback() {
  say "FAILED: restoring the previous images"
  for img in "$PROJECT" "$PROJECT-docker-proxy"; do
    if docker image inspect "$img:previous" > /dev/null 2>&1; then docker tag "$img:previous" "$img:local"; fi
  done
  if dc "$prev_dir" up -d --no-build && wait_healthy "$prev_dir"; then
    rm -f -- "$MARKER" # the previous version is verified healthy again
    say "ROLLED BACK to ${current:-the previous images}; the failed release stays in $rel for inspection"
  else
    say "ROLLBACK DID NOT COMPLETE: $MARKER stays in place; inspect with 'docker compose --project-name $PROJECT ps'"
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
trap 'exit 143' TERM
trap 'exit 130' INT

# ---- build, start, smoke-test -------------------------------------------------------------------
deploying=1
for img in "$PROJECT" "$PROJECT-docker-proxy"; do
  if docker image inspect "$img:local" > /dev/null 2>&1; then docker tag "$img:local" "$img:previous"; fi
done
say "building (one image at a time)"
docker compose --project-name "$PROJECT" --env-file "$HLCC_ENV_FILE" -f "$rel/deploy/compose.yaml" build > /dev/null

say "starting"
dc "$rel" up -d --no-build
wait_healthy "$rel" || die "services did not become healthy within ${HLCC_HEALTH_TIMEOUT}s"
port=$(env_value HLCC_PORT)
port="${port:-8787}"
curl -fsS -m 10 "http://127.0.0.1:$port/api/v1/health" > /dev/null || die "health endpoint failed"
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$port/api/v1/overview")
[ "$code" = 401 ] || die "unauthenticated request returned $code, expected 401"
cid=$(dc "$rel" ps -q hlcc)
docker exec "$cid" sh -c 'test ! -e /var/run/docker.sock' || die "the API container can see the Docker socket"

# Verified: record it (atomically), then clear the marker.
printf '%s\n' "$sha" > "$HLCC_ROOT/.deployed-sha.tmp"
mv -f -- "$HLCC_ROOT/.deployed-sha.tmp" "$HLCC_ROOT/.deployed-sha"
deploying=0
rm -f -- "$MARKER"
say "DONE $(date -Is): $sha is live (previous: ${current:-none}, backup: ${backup:-none})"
