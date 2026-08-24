#!/bin/zsh
set -euo pipefail
ROOT="${RAKAZO_ROOT:-$HOME/src/rakazo}"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/.rakazo-env.sh"
mkdir -p "$ROOT/logs" "$ROOT/run"

export WEB_PORT="${WEB_PORT:-5175}"
export RAKAZO_BIND="${RAKAZO_BIND:-127.0.0.1}"
export RAKAZO_PUBLIC_HOST="${RAKAZO_PUBLIC_HOST:-macstudio.lenok-truck.ts.net}"
export RAKAZO_PUBLIC_PORT="${RAKAZO_PUBLIC_PORT:-5173}"

if ! colima status >/dev/null 2>&1; then
  echo "starting colima..."
  colima start --cpu 8 --memory 16 --disk 80 --vm-type vz --vz-rosetta --mount-type virtiofs
fi

docker compose --env-file .env -f infra/compose/docker-compose.yml up postgres -d
for i in {1..40}; do
  if docker exec compose-postgres-1 pg_isready -U rakazo >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ -f "$ROOT/run/dev.pid" ]] && kill -0 "$(cat "$ROOT/run/dev.pid")" 2>/dev/null; then
  echo "rakazo already running pid=$(cat "$ROOT/run/dev.pid")"
  exit 0
fi

if ! docker image inspect rakazo/computer:local >/dev/null 2>&1; then
  echo "building computer image..."
  pnpm sandbox:build
fi

nohup pnpm dev >> "$ROOT/logs/dev.log" 2>&1 &
echo $! > "$ROOT/run/dev.pid"
echo "started pnpm dev pid=$(cat "$ROOT/run/dev.pid") log=$ROOT/logs/dev.log"

for i in {1..90}; do
  if curl -sf http://127.0.0.1:3100/health >/dev/null 2>&1 && curl -sf -o /dev/null "http://127.0.0.1:${WEB_PORT}"; then
    tailscale serve --bg --https=5173 "http://127.0.0.1:${WEB_PORT}" >/dev/null
    curl -s http://127.0.0.1:3100/health
    echo
    echo "ready: https://macstudio.lenok-truck.ts.net:5173"
    exit 0
  fi
  sleep 2
done
echo "timed out waiting for health; see $ROOT/logs/dev.log" >&2
tail -n 80 "$ROOT/logs/dev.log" >&2 || true
exit 1
