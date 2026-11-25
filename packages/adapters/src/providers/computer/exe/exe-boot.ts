/** Runs its arguments in the computer as the image user, with the image's environment. */
export const EXEC_WRAPPER = "/run/rakazo-exe/exec";

/**
 * Run as root through the API once a VM is up, and again whenever a start finds it running.
 * exe.dev boots the computer image as a VM and starts the image's command as root, and commands
 * through the API run as root. This keeps the image's environment, stops that command and
 * everything it started, and starts it again as the image user (uid 1000) without new
 * privileges, as the Docker, Incus and Kubernetes computers run it. Commands then reach the image
 * user through EXEC_WRAPPER. RAKAZO_EXTRA_ENV holds variables to add, one KEY=value per line.
 */
export const BOOT_SCRIPT = String.raw`set -eu
dir=/run/rakazo-exe
command=/usr/local/bin/rakazo-computer
if [ -f "$dir/ready" ] && pgrep -u 1000 -f "^bash $command\$" >/dev/null; then exit 0; fi
pid=""
for _ in $(seq 1 240); do
  pid=$(pgrep -o -f "^bash $command\$" || true)
  [ -n "$pid" ] && break
  sleep 0.5
done
if [ -z "$pid" ]; then echo "the computer image's command is not running" >&2; exit 1; fi
mkdir -p -m 755 "$dir"
{
  tr '\0' '\n' </proc/"$pid"/environ | grep -E '^(PATH|HOME|LANG|DISPLAY|DBUS_SESSION_BUS_ADDRESS|NSS_WRAPPER_[A-Z]+|UV_[A-Z_]+)='
  printf '%s\n' "$RAKAZO_EXTRA_ENV"
} >"$dir/env"
cat >"$dir/exec" <<'EOF'
#!/bin/bash
mapfile -t vars </run/rakazo-exe/env
cd /home/rakazo || exit 1
exec env -i "${"$"}{vars[@]}" setpriv --reuid=1000 --regid=1000 --init-groups --no-new-privs -- "$@"
EOF
chmod 755 "$dir/exec"
if [ "$(stat -c %u /proc/"$pid")" != 1000 ]; then
  # SIGKILL: the command's TERM handler signals every process, which as root includes exe.dev's.
  kill -KILL "$pid"
  pkill -KILL -u 0 -x 'Xvfb|x11vnc|websockify|fluxbox|dbus-daemon|fusermount3' || true
  pkill -KILL -u 0 -f '^/usr/libexec/xdg-' || true
  pkill -KILL -u 0 -f '^/usr/bin/python3 /usr/bin/websockify' || true
  umount -l /home/rakazo/.cache/doc 2>/dev/null || true
  rm -rf /tmp/rakazo /tmp/rakazo-nss /tmp/fluxbox-home /tmp/.X1-lock /tmp/.X11-unix/X1
  chown -R 1000:1000 /home/rakazo
  setsid -f nohup "$dir/exec" env -u LD_PRELOAD "$command" </dev/null >"$dir/computer.log" 2>&1
fi
touch "$dir/ready"
`;
