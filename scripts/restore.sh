#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?usage: restore.sh backups/<stamp>}"
compose=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
# Compose resolves its default env file relative to the compose file, not the
# repo root; point it at the root .env when one exists (vars may also come
# from the environment, so its absence is not an error).
if [[ -f "$ROOT/.env" ]]; then compose=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/docker-compose.yml"); fi
"${compose[@]}" up -d postgres
until "${compose[@]}" exec -T postgres pg_isready -U rakazo >/dev/null 2>&1; do
  sleep 1
done
"${compose[@]}" exec -T postgres psql -U rakazo -d rakazo < "$SRC/rakazo.sql"
if [[ -f "$SRC/homes.tgz" ]]; then
  tar -xzf "$SRC/homes.tgz" -C "$ROOT"
fi
"${compose[@]}" up -d
echo "Restore complete from $SRC"
