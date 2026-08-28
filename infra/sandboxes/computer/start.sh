#!/usr/bin/env bash
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/rakazo}"
AGENT_HOME="$HOME"
mkdir -p "$AGENT_HOME" "$AGENT_HOME/.local/bin" "$AGENT_HOME/.config" /tmp/rakazo /tmp/.X11-unix /tmp/fluxbox-home
export PATH="$AGENT_HOME/.local/bin:/usr/local/bin:$PATH"
export NPM_CONFIG_PREFIX="$AGENT_HOME/.local"
export PIP_USER=1
cd "$AGENT_HOME"

if [[ -n "${RAKAZO_COMPUTER_CONTROL_TOKEN:-}" ]]; then
  /usr/local/bin/rakazo-computer-control >/tmp/rakazo/control.log 2>&1 &
fi

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1

Xvfb :1 -screen 0 1280x800x24 -ac +extension RANDR +render -noreset >/tmp/rakazo/xvfb.log 2>&1 &
XVFB_PID=$!

ready=0
for _ in $(seq 1 100); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  echo "Xvfb failed to start" >&2
  cat /tmp/rakazo/xvfb.log >&2 || true
  exit 1
fi

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
fi

xsetroot -solid "#111113" >/dev/null 2>&1 || true
mkdir -p /tmp/fluxbox-home/.fluxbox
cp /etc/rakazo/fluxbox/init /tmp/fluxbox-home/.fluxbox/init
cp /etc/rakazo/fluxbox/apps /tmp/fluxbox-home/.fluxbox/apps 2>/dev/null || true
cp /etc/rakazo/fluxbox/menu /tmp/fluxbox-home/.fluxbox/menu 2>/dev/null || true
cat > /tmp/fluxbox-home/.fluxbox/startup <<'EOF'
#!/bin/sh
xsetroot -solid "#111113"
exec fluxbox -rc /tmp/fluxbox-home/.fluxbox/init
EOF
chmod +x /tmp/fluxbox-home/.fluxbox/startup
HOME=/tmp/fluxbox-home /tmp/fluxbox-home/.fluxbox/startup >/tmp/rakazo/fluxbox.log 2>&1 &

HOME="$AGENT_HOME" rakazo-browser >/tmp/rakazo/browser.log 2>&1 &
browser_up=0
for _ in $(seq 1 40); do
  if xdotool search --onlyvisible --class chromium >/dev/null 2>&1; then
    browser_up=1
    break
  fi
  if xdotool search --onlyvisible --class Chromium >/dev/null 2>&1; then
    browser_up=1
    break
  fi
  sleep 0.25
done
if [[ "$browser_up" -ne 1 ]]; then
  echo "browser failed to start" >&2
  cat /tmp/rakazo/browser.log >&2 || true
  xterm -geometry 100x28+48+48 -bg "#111113" -fg "#E8E8EA" -cr "#E8E8EA" -title "Terminal" >/tmp/rakazo/xterm.log 2>&1 &
fi

x11vnc -display :1 -forever -shared -viewonly -nopw -listen 127.0.0.1 -rfbport 5900 -xkb -ncache 0 >/tmp/rakazo/x11vnc.log 2>&1 &

NOVNC_ROOT=/usr/share/novnc
if [[ ! -d "$NOVNC_ROOT" ]]; then
  echo "noVNC is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/embed.html" ]]; then
  echo "noVNC embed.html is missing from the computer image" >&2
  exit 1
fi
websockify --heartbeat=30 --web="$NOVNC_ROOT" 0.0.0.0:6080 127.0.0.1:5900 >/tmp/rakazo/novnc.log 2>&1 &

while kill -0 "$XVFB_PID" 2>/dev/null; do
  sleep 2
done
echo "Xvfb exited" >&2
exit 1
