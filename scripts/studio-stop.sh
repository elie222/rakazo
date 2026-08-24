#!/bin/zsh
set -euo pipefail
ROOT="${RAKAZO_ROOT:-$HOME/src/rakazo}"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/.rakazo-env.sh"

if [[ -f "$ROOT/run/dev.pid" ]]; then
  pid="$(cat "$ROOT/run/dev.pid")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$ROOT/run/dev.pid"
fi
pkill -f "turbo dev --filter=@rakazo" 2>/dev/null || true
pkill -f "tsx watch src/index.ts" 2>/dev/null || true
# Keep Postgres data: stop only, never `down -v`
docker compose --env-file .env -f infra/compose/docker-compose.yml stop postgres >/dev/null 2>&1 || true
echo "stopped (postgres stopped, volumes kept)"
