#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/opt/rakazo"
COMPOSE_FILE="${PROJECT_DIR}/infra/compose/docker-compose.prod.yml"
ENV_FILE="${PROJECT_DIR}/.env"
BACKUP_ROOT="/var/backups/rakazo"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_DIR="${BACKUP_ROOT}/${STAMP}"

install -d -m 700 "${BACKUP_ROOT}" "${SNAPSHOT_DIR}"

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

"${compose[@]}" exec -T postgres sh -c \
  'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "${SNAPSHOT_DIR}/rakazo.dump"

"${compose[@]}" exec -T api tar -czf - -C /data . \
  > "${SNAPSHOT_DIR}/appdata.tgz"

"${compose[@]}" exec -T postgres pg_restore --list \
  < "${SNAPSHOT_DIR}/rakazo.dump" >/dev/null
tar -tzf "${SNAPSHOT_DIR}/appdata.tgz" >/dev/null

sha256sum "${SNAPSHOT_DIR}/rakazo.dump" "${SNAPSHOT_DIR}/appdata.tgz" \
  > "${SNAPSHOT_DIR}/SHA256SUMS"
chmod 600 "${SNAPSHOT_DIR}"/*

# Keep seven daily snapshots. BACKUP_ROOT is intentionally fixed above so this
# cleanup can never expand to an environment-controlled or broad path.
find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -mtime +6 -exec rm -rf -- {} +

echo "Verified Rakazo backup written to ${SNAPSHOT_DIR}"
