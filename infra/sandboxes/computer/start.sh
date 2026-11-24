#!/usr/bin/env bash
set -uo pipefail
source /usr/local/lib/rakazo-user-env.sh
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/rakazo}"
AGENT_HOME="$HOME"
mkdir -p "$AGENT_HOME" "$AGENT_HOME/.local/bin" "$AGENT_HOME/.config" /tmp/rakazo /tmp/.X11-unix /tmp/fluxbox-home
# Login shells re-apply ~/.local/bin from /etc/profile.d/rakazo-local-bin.sh.
export PATH="$AGENT_HOME/.local/bin:/usr/local/bin:$PATH"
export NPM_CONFIG_PREFIX="$AGENT_HOME/.local"
export PIP_USER=1
cd "$AGENT_HOME"

# This script is PID 1, which ignores SIGTERM without a handler, so `docker stop` would wait out
# its grace period. Install the handler before any child starts so a stop during startup is
# honoured too.
XVFB_PID=""
shutdown() {
  trap - TERM INT
  if [[ -n "$XVFB_PID" ]]; then
    kill -TERM "$XVFB_PID" 2>/dev/null || true
  fi
  kill -TERM -- -1 2>/dev/null || true
  if [[ -n "$XVFB_PID" ]]; then
    wait "$XVFB_PID" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

if [[ -n "${RAKAZO_COMPUTER_CONTROL_TOKEN:-}" ]]; then
  while true; do
    /usr/local/bin/rakazo-computer-control
    sleep 1
  done >/tmp/rakazo/control.log 2>&1 &
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

rm -f /tmp/rakazo/session-bus /tmp/rakazo/dbus-session
# The image sets this; keep a default for runtimes that drop image ENV.
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/tmp/rakazo/session-bus}"
if dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS"; then
  # Keep the address file for browser launchers with a minimal environment.
  printf 'export DBUS_SESSION_BUS_ADDRESS=%q\n' "$DBUS_SESSION_BUS_ADDRESS" \
    > /tmp/rakazo/dbus-session
fi

# Chromium's file chooser talks to xdg-desktop-portal over the session bus.
# Without a running portal backend, the select-file dialog opens but the
# chosen file never reaches the page — uploads silently do nothing. The
# daemons install as flat files in /usr/libexec on Debian bookworm.
if [ -x /usr/libexec/xdg-desktop-portal ] && [ -x /usr/libexec/xdg-desktop-portal-gtk ]; then
  /usr/libexec/xdg-desktop-portal >/tmp/rakazo/portal.log 2>&1 &
  /usr/libexec/xdg-desktop-portal-gtk >/tmp/rakazo/portal-gtk.log 2>&1 &
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

register_browser_handler() {
  local mime="$1"
  if ! xdg-mime default rakazo-browser.desktop "$mime" >/dev/null 2>&1 \
    || [[ "$(xdg-mime query default "$mime" 2>/dev/null || true)" != "rakazo-browser.desktop" ]]; then
    echo "failed to register rakazo-browser for $mime" >&2
    exit 1
  fi
}
# xdg-mime and xdg-settings are long shell scripts. Under gVisor the calls below took about
# 20 s of every boot, before the screen gateway opened. The image's /etc/xdg/mimeapps.list
# already names rakazo-browser for every type they set, and xdg-mime reads the user's file
# first, then that one. When the user's file leaves those types alone or names
# rakazo-browser too, there is nothing to change and the calls are skipped.
browser_handlers_set() {
  local user="$AGENT_HOME/.config/mimeapps.list" system=/etc/xdg/mimeapps.list
  [[ -z "${BROWSER:-}" && -z "${XDG_CONFIG_HOME:-}" && -z "${XDG_CONFIG_DIRS:-}" && -z "${XDG_CURRENT_DESKTOP:-}" ]] || return 1
  [[ -f "$system" && ! -L "$user" ]] || return 1
  local files=("$system")
  [[ -e "$user" ]] && files=("$user" "$system")
  awk '
    FNR == 1 { section = "" }
    /^\[/ { section = $0; next }
    # Spaced keys or a removed association: leave those to the registration.
    section == "[Removed Associations]" && /rakazo-browser/ { odd = 1 }
    index($0, "=") > 1 && substr($0, index($0, "=") - 1, 1) ~ /[ 	]/ { odd = 1 }
    section == "[Default Applications]" && index($0, "=") > 1 {
      type = substr($0, 1, index($0, "=") - 1)
      if (!(type in first)) first[type] = substr($0, index($0, "=") + 1)
    }
    END {
      if (odd) exit 1
      n = split("x-scheme-handler/http x-scheme-handler/https text/html x-scheme-handler/about x-scheme-handler/unknown", types, " ")
      for (i = 1; i <= n; i++) {
        value = first[types[i]]
        if (value != "rakazo-browser.desktop" && value != "rakazo-browser.desktop;") exit 1
      }
    }
  ' "${files[@]}"
}
if ! browser_handlers_set; then
  register_browser_handler x-scheme-handler/http
  register_browser_handler x-scheme-handler/https
  register_browser_handler text/html
  if ! xdg-settings set default-web-browser rakazo-browser.desktop >/dev/null 2>&1 \
    || [[ "$(xdg-settings get default-web-browser 2>/dev/null || true)" != "rakazo-browser.desktop" ]]; then
    echo "failed to set default web browser to rakazo-browser" >&2
    exit 1
  fi
fi

x11vnc -display :1 -forever -shared -viewonly -repeat -nopw -listen 127.0.0.1 -rfbport 5900 -xkb -ncache 0 >/tmp/rakazo/x11vnc.log 2>&1 &

NOVNC_ROOT=/usr/share/novnc
if [[ ! -d "$NOVNC_ROOT" ]]; then
  echo "noVNC is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/embed.html" ]]; then
  echo "noVNC embed.html is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/clipboard-bridge.js" ]]; then
  echo "noVNC clipboard-bridge.js is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/mobile-keyboard.js" ]]; then
  echo "noVNC mobile-keyboard.js is missing from the computer image" >&2
  exit 1
fi
# The screen proxy reaches this isolated container through its bridge interface. Started by its
# full path and without the user's site-packages, so nothing in the home runs inside it.
PYTHONNOUSERSITE=1 /usr/bin/websockify --heartbeat=30 --web="$NOVNC_ROOT" --token-plugin=TokenFile --token-source=/tmp/rakazo/view-target-1 0.0.0.0:6080 >/tmp/rakazo/novnc.log 2>&1 &

wait "$XVFB_PID"
echo "Xvfb exited" >&2
exit 1
