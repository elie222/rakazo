#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${PROJECT_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
COMPOSE_FILE="${PROJECT_DIR}/infra/compose/docker-compose.prod.yml"
ENV_FILE="${PROJECT_DIR}/.env"
BACKUP_ROOT="/var/backups/rakazo"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_DIR="${BACKUP_ROOT}/${STAMP}"
# Verified snapshots kept on this host.
KEEP="${RAKAZO_BACKUP_KEEP:-3}"
[[ "${KEEP}" =~ ^[1-9][0-9]*$ ]] || { echo "RAKAZO_BACKUP_KEEP must be a positive whole number" >&2; exit 1; }

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

# Archive the appdata volume from the host, not through `compose exec api`.
#
# The api image runs as `USER node` (uid 1000) with `cap_drop: ALL`, while the
# supervisor creates each bot computer's home under /data as root with mode 600
# (receipts, taught skills, connector tokens). Inside a cap-dropped container
# uid 1000 cannot read those files, so `tar` exits 2 and the archive it leaves
# behind is missing exactly the bot state a restore needs. Root on the host has
# CAP_DAC_OVERRIDE and reads all of it.
#
# Ask the running container where /data actually is, rather than rebuilding the
# volume name from a project name. `compose config` reports this file's `name:`
# key and ignores an operator's `-p` or COMPOSE_PROJECT_NAME, so reconstructing
# "<project>_appdata" would inspect the default project's volume on any stack
# started under another name, and silently archive the wrong one. This uses the
# same compose invocation as the pg_dump below, so both target one stack.
api="$("${compose[@]}" ps -q api)"
[[ -n "${api}" ]] || { echo "the api service is not running; cannot locate /data" >&2; exit 1; }
appdata="$(docker inspect "${api}" \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
[[ -n "${appdata}" ]] || { echo "the api container has no /data mount" >&2; exit 1; }

install -d -m 700 "${BACKUP_ROOT}"
# One backup at a time, so cleanup never removes a snapshot another run is still writing.
exec 8>"${BACKUP_ROOT}/.lock"
flock -n 8 || { echo "Another Rakazo backup is running" >&2; exit 1; }
# Newest first; stamps sort by time. Only stamp-named directories are ever listed or removed.
snapshots() {
  find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9]{8}T[0-9]{6}Z' -print | sort -r
}

# A full disk leaves a partial snapshot, so check first. Expect the size of the last verified
# snapshot, or of the data itself when there is none yet.
last=""
while read -r dir; do
  if [[ -f "${dir}/SHA256SUMS" ]]; then last="${dir}"; break; fi
done < <(snapshots)
need_kb="$(du -sk "${last:-${appdata}}" | awk '{ print $1 }')"
free_kb="$(df -Pk "${BACKUP_ROOT}" | awk 'NR == 2 { print $4 }')"
if ((free_kb < need_kb)); then
  echo "Only $((free_kb / 1024))MB free in ${BACKUP_ROOT}; this backup needs about $((need_kb / 1024))MB." >&2
  echo "Remove old snapshots there or free space elsewhere, then run the backup again." >&2
  exit 1
fi

install -d -m 700 "${SNAPSHOT_DIR}"
# Never leave a partial snapshot behind: it uses space and looks like a backup.
verified=0
trap '[[ "${verified}" == 1 ]] || rm -rf -- "${SNAPSHOT_DIR}"' EXIT

"${compose[@]}" exec -T postgres sh -c \
  'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "${SNAPSHOT_DIR}/rakazo.dump"

# Bots write while this runs. GNU tar exits 1 for "file changed as we read it",
# which is expected on a live system and still yields a usable archive; only a
# fatal error (2) fails the backup.
rc=0
tar -czf "${SNAPSHOT_DIR}/appdata.tgz" --numeric-owner -C "${appdata}" . || rc=$?
if [[ "${rc}" -gt 1 ]]; then
  echo "appdata archive failed with tar exit ${rc}" >&2
  exit "${rc}"
fi

"${compose[@]}" exec -T postgres pg_restore --list \
  < "${SNAPSHOT_DIR}/rakazo.dump" >/dev/null
tar -tzf "${SNAPSHOT_DIR}/appdata.tgz" >/dev/null

sha256sum "${SNAPSHOT_DIR}/rakazo.dump" "${SNAPSHOT_DIR}/appdata.tgz" \
  > "${SNAPSHOT_DIR}/SHA256SUMS"
chmod 600 "${SNAPSHOT_DIR}"/*

verified=1

# Keep the newest KEEP verified snapshots and drop the rest, including partial ones from failed
# runs. BACKUP_ROOT is intentionally fixed above so this can never reach a broad path.
kept=0
while read -r dir; do
  if [[ -f "${dir}/SHA256SUMS" ]] && ((kept < KEEP)); then
    kept=$((kept + 1))
  else
    rm -rf -- "${dir}"
  fi
done < <(snapshots)

echo "Verified Rakazo backup written to ${SNAPSHOT_DIR}"
