#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="${1:-$(date +%Y%m%d-%H%M%S)}"
OUT="${ROOT}/backups/${STAMP}"
compose=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
# Compose resolves its default env file relative to the compose file, not the
# repo root; point it at the root .env when one exists (vars may also come
# from the environment, so its absence is not an error).
if [[ -f "$ROOT/.env" ]]; then compose=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/docker-compose.yml"); fi
mkdir -p "$OUT"
"${compose[@]}" exec -T postgres pg_dump -U rakazo rakazo > "$OUT/rakazo.sql"
if [[ "${RAKAZO_BACKUP_SKIP_HOMES:-0}" == "1" ]]; then
  tar -czf "$OUT/homes.tgz" --files-from /dev/null
else
  tar -czf "$OUT/homes.tgz" -C "$ROOT" data 2>/dev/null || tar -czf "$OUT/homes.tgz" --files-from /dev/null
fi
echo "Backup written to $OUT"
