#!/bin/bash
# Swaps a server bundle into this Mac's Rakazo desktop install, restarts the app, and puts the
# previous bundle back if the new one does not come up. The deploy workflow
# (.github/workflows/desktop-server-deploy.yml) runs it over ssh:
#   deploy-desktop-server.sh <rakazo-server-darwin-arm64-<version>.tar.xz>
set -euo pipefail

archive="$1"
app=/Applications/Rakazo.app
stack="$HOME/Library/Application Support/Rakazo/stack"
installed="$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString)"
runtime="$stack/runtime/server-$installed"
live="$runtime/rakazo-server"
previous="$runtime/rakazo-server.previous"
incoming="$runtime/.rakazo-server.incoming"
trap 'rm -rf "$incoming" "$archive"' EXIT

if [[ ! -f "$runtime/.complete" ]]; then
  echo "Rakazo $installed has not installed its server yet; open the app once first." >&2
  exit 1
fi

rm -rf "$incoming"
mkdir "$incoming"
tar -xJf "$archive" -C "$incoming"
bundled="$(plutil -extract version raw "$incoming/rakazo-server/manifest.json")"
# An older server than the app's own would run against migrations it has never seen.
if [[ "$(printf '%s\n%s\n' "$bundled" "$installed" | sort -V | head -n1)" != "$installed" ]]; then
  echo "This bundle is $bundled but Rakazo is $installed; sync upstream first." >&2
  exit 1
fi

stop() {
  pkill -TERM -x -f "$app/Contents/MacOS/Rakazo" || true
  for _ in $(seq 60); do
    pgrep -f "$runtime/rakazo-server/apps/" > /dev/null || pgrep -x -f "$app/Contents/MacOS/Rakazo" > /dev/null || return 0
    sleep 1
  done
  pkill -TERM -f "$runtime/rakazo-server/apps/" || true
  sleep 5
}

# Waits for a fresh start: the app rotates its logs, so api.log is new once it is up.
ready() {
  local marker="$1" port
  for _ in $(seq 180); do
    if [[ "$stack/logs/api.log" -nt "$marker" && "$stack/logs/worker.log" -nt "$marker" ]] &&
      grep -q '"api listening"' "$stack/logs/api.log" &&
      grep -q '"worker ready"' "$stack/logs/worker.log"; then
      port="$(grep -o '"api listening".*"http.port":[0-9]*' "$stack/logs/api.log" | tail -n1 | grep -o '[0-9]*$')"
      curl -fsS "http://127.0.0.1:$port/health" > /dev/null && return 0
    fi
    sleep 1
  done
  return 1
}

start() {
  local marker
  marker="$(mktemp)"
  open -a "$app"
  ready "$marker"
  local ok=$?
  rm -f "$marker"
  return $ok
}

stop
rm -rf "$previous"
mv "$live" "$previous"
mv "$incoming/rakazo-server" "$live"
if start; then
  echo "Rakazo $installed now runs server $bundled."
  exit 0
fi

echo "The new server did not come up; putting the previous one back." >&2
tail -n 20 "$stack/logs/api.log" "$stack/logs/worker.log" >&2 || true
stop
rm -rf "$live"
mv "$previous" "$live"
start || echo "The previous server did not come up either." >&2
exit 1
