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

MIN_FREE_GB="${RAKAZO_BACKUP_MIN_FREE_GB:-5}"
MAX_GB="${RAKAZO_BACKUP_MAX_GB:-50}"
for value in "${MIN_FREE_GB}" "${MAX_GB}"; do
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || { echo "Backup space limits must be positive whole GiB" >&2; exit 1; }
done
reserve_kb=$((MIN_FREE_GB * 1024 * 1024))
budget_kb=$((MAX_GB * 1024 * 1024))
if [[ "${RAKAZO_BACKUP_REQUIRE_VOLUME:-0}" == 1 ]]; then
  mountpoint -q /var/backups || { echo "/var/backups must be a mounted backup volume" >&2; exit 1; }
  [[ "$(stat -c %d /var/backups)" != "$(stat -c %d /)" ]] || {
    echo "/var/backups must be on a separate filesystem" >&2; exit 1;
  }
fi

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

# Remove abandoned partial snapshots and excess history BEFORE checking free space.
# Always preserve the newest verified snapshot, even when the budget cannot be met.
verified_dirs=()
while read -r dir; do
  if [[ -f "${dir}/SHA256SUMS" ]]; then
    verified_dirs+=("${dir}")
  else
    rm -rf -- "${dir}"
  fi
done < <(snapshots)
while ((${#verified_dirs[@]} > KEEP)); do
  index=$((${#verified_dirs[@]} - 1))
  rm -rf -- "${verified_dirs[index]}"
  unset 'verified_dirs[index]'
done

# Scale only the previous appdata archive by appdata source growth. Older snapshots without
# size metadata use the uncompressed source as a conservative first-run estimate.
# The per-output limit below still bounds actual writes when compressibility changes.
last="${verified_dirs[0]:-}"
source_kb="$(du -sk "${appdata}" | awk '{ print $1 }')"
need_kb="${source_kb}"
if [[ -n "${last}" ]]; then
  last_kb="$(du -sk "${last}" | awk '{ print $1 }')"
  last_source=""
  [[ ! -f "${last}/SOURCE_SIZE_KB" ]] || last_source="$(cat "${last}/SOURCE_SIZE_KB")"
  if [[ "${last_source}" =~ ^[1-9][0-9]*$ && -f "${last}/appdata.tgz" && -f "${last}/rakazo.dump" ]]; then
    archive_kb="$(du -sk "${last}/appdata.tgz" | awk '{ print $1 }')"
    dump_kb="$(du -sk "${last}/rakazo.dump" | awk '{ print $1 }')"
    need_kb="$(awk -v archive="${archive_kb}" -v dump="${dump_kb}" -v current="${source_kb}" -v previous="${last_source}" \
      'BEGIN { printf "%.0f\n", dump + archive * current / previous }')"
  fi
  ((last_kb <= need_kb)) || need_kb="${last_kb}"
fi
need_kb=$((need_kb + need_kb / 4 + 1024 * 1024))
space() {
  free_kb="$(df -Pk "${BACKUP_ROOT}" | awk 'NR == 2 { print $4 }')"
  used_kb="$(du -sk "${BACKUP_ROOT}" | awk '{ print $1 }')"
}
space
while ((free_kb < need_kb + reserve_kb || used_kb + need_kb > budget_kb)) && ((${#verified_dirs[@]} > 1)); do
  index=$((${#verified_dirs[@]} - 1))
  rm -rf -- "${verified_dirs[index]}"
  unset 'verified_dirs[index]'
  space
done
if ((free_kb < need_kb + reserve_kb || used_kb + need_kb > budget_kb)); then
  echo "Only $((free_kb / 1024))MB free in ${BACKUP_ROOT}; this backup needs about $((need_kb / 1024))MB plus ${MIN_FREE_GB}GiB reserve, within a ${MAX_GB}GiB backup budget." >&2
  echo "Keeping the latest verified snapshot; increase backup capacity or reduce the source data." >&2
  exit 1
fi

mkdir -m 700 -- "${SNAPSHOT_DIR}"
# Never leave a partial snapshot behind: it uses space and looks like a backup.
verified=0
trap '[[ "${verified}" == 1 ]] || rm -rf -- "${SNAPSHOT_DIR}"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
printf '%s\n' "${source_kb}" >"${SNAPSHOT_DIR}/SOURCE_SIZE_KB"

# Cap each output at the smaller of the remaining budget and usable free space.
output_limit() {
  space
  limit_kb=$((free_kb - reserve_kb))
  remaining_kb=$((budget_kb - used_kb))
  ((limit_kb <= remaining_kb)) || limit_kb="${remaining_kb}"
  ((limit_kb > 0)) || { echo "Backup storage budget exhausted" >&2; return 1; }
}
output_limit
(ulimit -c 0; ulimit -f "${limit_kb}"; "${compose[@]}" exec -T postgres sh -c \
  'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "${SNAPSHOT_DIR}/rakazo.dump")

# Bots write while this runs. GNU tar exits 1 for "file changed as we read it",
# which is expected on a live system and still yields a usable archive; only a
# fatal error (2) fails the backup.
rc=0
output_limit
(ulimit -c 0; ulimit -f "${limit_kb}"; exec tar -czf "${SNAPSHOT_DIR}/appdata.tgz" --numeric-owner -C "${appdata}" .) || rc=$?
if [[ "${rc}" -gt 1 ]]; then
  echo "appdata archive failed with tar exit ${rc}" >&2
  exit "${rc}"
fi

"${compose[@]}" exec -T postgres pg_restore --list \
  < "${SNAPSHOT_DIR}/rakazo.dump" >/dev/null
tar -tzf "${SNAPSHOT_DIR}/appdata.tgz" >/dev/null

(cd "${SNAPSHOT_DIR}" && sha256sum rakazo.dump appdata.tgz SOURCE_SIZE_KB > SHA256SUMS.pending)
chmod 600 "${SNAPSHOT_DIR}"/*
sync -- "${SNAPSHOT_DIR}"/*
# Publish the completion marker only after every checksum is written.
mv "${SNAPSHOT_DIR}/SHA256SUMS.pending" "${SNAPSHOT_DIR}/SHA256SUMS"
sync -- "${SNAPSHOT_DIR}"

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
