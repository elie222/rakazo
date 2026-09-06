#!/usr/bin/env bash
set -euo pipefail
: "${CADRE_SCREEN_VIEW_TOKEN:?Screen capability required}"
# Runtime grants and X sockets must not survive filesystem snapshot restore.
rm -rf /run/cadre
install -d -m 700 /run/cadre
rm -f /tmp/.X?-lock /tmp/.X11-unix/X?
python3 -c 'import sys; sys.path.insert(0,"/opt/cadre"); import screens; screens.resume_sessions()'
export CADRE_SHARED_BROWSER_SESSIONS=1
env -u CADRE_SCREEN_VIEW_TOKEN runuser -u rakazo -- /usr/local/bin/rakazo-computer &
COMPUTER_PID=$!
trap 'kill "$COMPUTER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then break; fi
  sleep 0.1
done
x11vnc -display :1 -forever -shared -nopw -listen 127.0.0.1 -rfbport 5901 -xkb -noshm -no6 >/tmp/cadre-control-vnc.log 2>&1 &
websockify --heartbeat=30 --web=/usr/share/novnc 127.0.0.1:6081 127.0.0.1:5901 >/tmp/cadre-control-web.log 2>&1 &
sessions_ready=0
for _ in $(seq 1 200); do
  if [ -f /tmp/cadre-browser-sessions-ready ]; then sessions_ready=1; break; fi
  sleep 0.1
done
if [ "$sessions_ready" -ne 1 ]; then
  echo "Shared browser sessions did not become ready" >&2
  exit 1
fi
python3 /opt/cadre/screen_gateway.py &
wait "$COMPUTER_PID"
