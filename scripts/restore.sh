#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?usage: restore.sh backups/<stamp>}"
compose=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
# Compose resolves its default env file relative to the compose file, not the
# repo [redacted]; point it at the [redacted] .env when one exists (vars may also come
# from the environment, so its absence is not an error).
if [[ -f "$ROOT/.env" ]]; then compose=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/docker-compose.yml"); fi
# An explicit data source: a host directory or a docker volume name.
DATA_SOURCE="${RAKAZO_RESTORE_DATA_SOURCE:-${RAKAZO_BACKUP_DATA_SOURCE:-}}"
COMPOSE_PROJECT="${RAKAZO_COMPOSE_PROJECT:-}"
HELPER_IMAGE="${RAKAZO_BACKUP_HELPER_IMAGE:-alpine:latest}"
# shellcheck source=scripts/lib/data-source.sh
source "$ROOT/scripts/lib/data-source.sh"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { printf 'restore failed: %s\n' "$*" >&2; exit 1; }

[[ -f "$SRC/rakazo.sql" ]] || { echo "missing rakazo.sql" >&2; exit 1; }

# ------------------------------------------------------- data source lookup
# The restore has to write where the application reads from. A compose
# deployment keeps that data in a named volume mounted at /data, NOT in
# $ROOT/data: writing the restored tree into a host directory that the
# containers do not mount would report a successful restore while the live
# application kept its old data. So resolve the same way backup.sh does and
# fail loudly when nothing can be found.
resolved="$(resolve_data_source || true)"
DATA_KIND=""
DATA_PATH=""
if [[ -n "$resolved" ]]; then
  DATA_KIND="${resolved%% *}"
  DATA_PATH="${resolved#* }"
fi
if [[ -z "$DATA_KIND" ]]; then
  die "no data source found: \$ROOT/data does not exist and no running container exposes a /data volume. Set RAKAZO_RESTORE_DATA_SOURCE to the directory or docker volume holding the data."
fi
if [[ "$DATA_KIND" == "dir" ]]; then
  [[ ! -L "$DATA_PATH" && -d "$DATA_PATH" ]] || {
    echo "data must be a directory, not a symlink" >&2
    exit 1
  }
fi
log "restoring into $DATA_KIND $DATA_PATH"

STAGE=""
STOP_ON_FAILURE=0
cleanup() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if (( STOP_ON_FAILURE )); then
    "${compose[@]}" stop api worker supervisor || true
  fi
  if [[ -n "$STAGE" ]]; then rm -rf -- "$STAGE" || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -e "$SRC/homes.tgz" || -L "$SRC/homes.tgz" ]]; then
  STAGE="$(mktemp -d "$ROOT/.restore.XXXXXX")"
  tar -tzf "$SRC/homes.tgz" > "$STAGE/members"
  if [[ -s "$STAGE/members" ]]; then
    while IFS= read -r member; do
      case "$member" in
        data|data/*) ;;
        *) echo "homes archive contains a path outside data" >&2; exit 1 ;;
      esac
      case "/$member/" in
        */../*) echo "homes archive contains a parent path" >&2; exit 1 ;;
      esac
    done < "$STAGE/members"
    tar -xzf "$SRC/homes.tgz" -C "$STAGE"
    [[ ! -L "$STAGE/data" && -d "$STAGE/data" ]] || {
      echo "homes archive must contain a data directory, not a symlink" >&2
      exit 1
    }
  fi
fi
STOP_ON_FAILURE=1
"${compose[@]}" stop api worker supervisor
if [[ "$DATA_KIND" == "volume" && -n "$STAGE" && -d "$STAGE/data" ]]; then
  # Stopping the supervisor leaves already-running bot computers alive.
  writers="$(docker ps -q --filter "volume=$DATA_PATH")"
  while IFS= read -r container; do
    [[ -z "$container" ]] || docker stop "$container"
  done <<< "$writers"
fi
"${compose[@]}" up -d postgres
until "${compose[@]}" exec -T postgres pg_isready -U rakazo >/dev/null 2>&1; do
  sleep 1
done
# Roles live outside the dump, and its grants name the runtime role. The API's
# start (its migration step) gives that role its login and grants afterwards.
"${compose[@]}" exec -T postgres psql -X -U rakazo -d rakazo --set=ON_ERROR_STOP=on -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN CREATE ROLE rakazo_app NOLOGIN; END IF; END \$\$"
# Stop on SQL errors and roll back the dump before restoring files or starting
# the application. -f is required for psql's single-transaction mode.
"${compose[@]}" exec -T postgres psql -X -U rakazo -d rakazo \
  --set=ON_ERROR_STOP=on --single-transaction --file=- < "$SRC/rakazo.sql"

if [[ -n "$STAGE" && -d "$STAGE/data" ]]; then
  if [[ "$DATA_KIND" == "dir" ]]; then
    # A host directory: keep the previous tree aside so it can be recovered,
    # then move the restored tree into place.
    if [[ -e "$DATA_PATH" ]]; then
      ROLLBACK="$(mktemp -d "$ROOT/data.rollback.XXXXXX")"
      mv "$DATA_PATH" "$ROLLBACK/data"
      echo "Previous data preserved at $ROLLBACK/data"
    fi
    mv "$STAGE/data" "$DATA_PATH"
  else
    # A named volume: the previous contents are archived to the host first,
    # because a volume cannot be moved aside the way a directory can.
    ROLLBACK="$(mktemp -d "$ROOT/data.rollback.XXXXXX")"
    docker run --rm -v "${DATA_PATH}:/data:ro" -v "${ROLLBACK}:/out" "$HELPER_IMAGE" \
      sh -c 'tar -czf /out/data-previous.tgz -C /data .'
    echo "Previous volume contents preserved at $ROLLBACK/data-previous.tgz"
    # Copy into a private clean tree before unlinking old entries. Neither cp
    # nor mv ever writes through an existing tenant-controlled destination.
    docker run --rm -v "${DATA_PATH}:/data" -v "${STAGE}/data:/src:ro" "$HELPER_IMAGE" \
      sh -eu -c 'umask 077
        stage=$(mktemp -d /data/.restore.XXXXXX)
        trap "rm -rf -- \"$stage\"" EXIT
        cp -a /src/. "$stage/"
        for entry in /data/* /data/.[!.]* /data/..?*; do
          [ "$entry" != "$stage" ] || continue
          [ -e "$entry" ] || [ -L "$entry" ] || continue
          rm -rf -- "$entry"
        done
        for entry in "$stage"/* "$stage"/.[!.]* "$stage"/..?*; do
          [ -e "$entry" ] || [ -L "$entry" ] || continue
          mv -- "$entry" /data/
        done'
  fi
fi
"${compose[@]}" up -d
STOP_ON_FAILURE=0
echo "Restore complete from $SRC"
