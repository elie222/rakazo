#!/usr/bin/env bash
set -euo pipefail
: "${CADRE_SCREEN_VIEW_TOKEN:?Screen capability required}"
# Runtime grants and X sockets must not survive filesystem snapshot restore.
rm -rf /run/cadre
install -d -m 700 /run/cadre
rm -f /tmp/.X?-lock /tmp/.X11-unix/X?
env -u CADRE_SCREEN_VIEW_TOKEN runuser -u rakazo -- /usr/local/bin/rakazo-computer &
COMPUTER_PID=$!
trap 'kill "$COMPUTER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then break; fi
  sleep 0.1
done
x11vnc -display :1 -forever -shared -nopw -listen 127.0.0.1 -rfbport 5901 -xkb -noshm -no6 >/tmp/cadre-control-vnc.log 2>&1 &
websockify --heartbeat=30 --web=/usr/share/novnc 127.0.0.1:6081 127.0.0.1:5901 >/tmp/cadre-control-web.log 2>&1 &
python3 /opt/cadre/screen_gateway.py &
wait "$COMPUTER_PID"
