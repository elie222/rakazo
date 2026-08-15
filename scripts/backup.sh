#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="${1:-$(date +%Y%m%d-%H%M%S)}"
OUT="${ROOT}/backups/${STAMP}"
mkdir -p "$OUT"
docker compose -f "$ROOT/infra/compose/docker-compose.yml" exec -T postgres pg_dump -U rakazo rakazo > "$OUT/rakazo.sql"
if [[ "${RAKAZO_BACKUP_SKIP_HOMES:-0}" == "1" ]]; then
  tar -czf "$OUT/homes.tgz" --files-from /dev/null
else
  tar -czf "$OUT/homes.tgz" -C "$ROOT" data 2>/dev/null || tar -czf "$OUT/homes.tgz" --files-from /dev/null
fi
echo "Backup written to $OUT"
