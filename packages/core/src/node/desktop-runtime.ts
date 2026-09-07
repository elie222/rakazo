import { createHash } from "node:crypto";
import path from "node:path";
// Each live Chrome needs a private debugger port. This is the TCP address-space
// boundary, not a product limit on bots or saved browser profiles.
export const MAX_DESKTOP_DISPLAY = 65535 - 9221;
export const BROWSER_APPLICATIONS = new Set([
  "browser",
  "chrome",
  "chromium",
  "chromium-browser",
  "firefox",
  "google-chrome",
  "google-chrome-stable",
  "rakazo-browser",
]);
export interface DesktopEnvironment {
  homeDir: string;
  workspaceDir: string;
  browserProfilesDir: string;
  displayStart: number;
  preservePrimaryDisplay?: boolean;
  portStart?: number;
}
export const DEFAULT_DESKTOP_ENV: DesktopEnvironment = {
  homeDir: "/home/rakazo",
  workspaceDir: "/home/rakazo",
  browserProfilesDir: "/home/rakazo/.browser-profiles",
  displayStart: 1,
  preservePrimaryDisplay: true,
};
export function screenPorts(index: number, env = DEFAULT_DESKTOP_ENV) {
  if (!Number.isSafeInteger(index) || index < 0 || index + env.displayStart > MAX_DESKTOP_DISPLAY)
    throw new Error("invalid desktop index");
  const displayNumber = env.displayStart + index;
  return {
    display: `:${displayNumber}`,
    displayNumber,
    viewPort: String(env.portStart ?? 6080),
    controlPort: String(env.portStart ?? 6080),
    debugPort: 9221 + displayNumber,
  };
}

function commandLayout(index: number | undefined, env: DesktopEnvironment) {
  if (index !== undefined) return screenPorts(index, env);
  return {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    display: ":${desktop_display}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    displayNumber: "${desktop_display}",
    viewPort: String(env.portStart ?? 6080),
    controlPort: String(env.portStart ?? 6080),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    debugPort: "${desktop_debug}",
  };
}

function layoutVariables(index: number | undefined, env: DesktopEnvironment) {
  if (index !== undefined) return [];
  return [
    'desktop_index="$1"',
    `case "$desktop_index" in ''|*[!0-9]*) exit 75 ;; esac`,
    `[[ "$desktop_index" =~ ^(0|[1-9][0-9]{0,4})$ ]] || exit 75`,
    `desktop_display=$((desktop_index + ${env.displayStart}))`,
    `[ "$desktop_display" -le ${MAX_DESKTOP_DISPLAY} ] || exit 75`,
    "desktop_debug=$((9221 + desktop_display))",
  ];
}

// Expand only generated layout variables and the validated view token.
function quoteLayout(value: string) {
  return value
    .split(/(\$\{desktop_[a-z_]+\})/)
    .map((part) => (/^\$\{desktop_[a-z_]+\}$/.test(part) ? `"${part}"` : shellQuote(part)))
    .join("");
}
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function browserKeyForScreen(screenId: string) {
  return createHash("sha256").update(screenId).digest("hex").slice(0, 32);
}

export function browserProfilePathForScreen(screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return `${env.browserProfilesDir}/chromium-bot-${browserKeyForScreen(screenId)}`;
}

function browserPidPathForScreen(screenId: string) {
  return `/tmp/rakazo/browser-pid-${browserKeyForScreen(screenId)}`;
}

function browserRunningFunction(profile: string, pidFile: string) {
  return [
    "browser_running() {",
    `  tracked=$(cat ${pidFile} 2>/dev/null || true)`,
    `  lock=$(readlink ${shellQuote(profile)}/SingletonLock 2>/dev/null || true)`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '  for pid in "$tracked" "${lock##*-}"; do',
    `    case "$pid" in ''|0|*[!0-9]*) continue ;; esac`,
    `    kill -0 "$pid" 2>/dev/null || continue`,
    `    tr '\\0' '\\n' <"/proc/$pid/cmdline" 2>/dev/null | grep -Fx -- ${shellQuote(`--user-data-dir=${profile}`)} >/dev/null || continue`,
    `    printf %s "$pid" >${pidFile}`,
    "    return 0",
    "  done",
    "  return 1",
    "}",
  ];
}

export function browserLauncherPath(displayNumber: number | string) {
  return `/tmp/rakazo/browser-launch-${displayNumber}`;
}

function browserLauncherCommand(
  index: number | undefined,
  screenId: string,
  env: DesktopEnvironment,
) {
  const layout = commandLayout(index, env);
  return [
    "#!/bin/bash",
    "set -eu",
    ...(index === undefined
      ? // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
        ['desktop_display="${0##*-}"', "desktop_debug=$((9221 + desktop_display))"]
      : []),
    "browser=$(command -v rakazo-browser || command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)",
    `export DISPLAY=${layout.display} HOME=${shellQuote(env.homeDir)}`,
    `exec "$browser" --no-sandbox --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=${layout.debugPort} --user-data-dir=${shellQuote(browserProfilePathForScreen(screenId, env))} "$@"`,
  ].join("\n");
}

// Browser.close flushes cookies and profile databases; SIGTERM alone can discard recent cookies.
const CLOSE_BROWSER = `import base64, json, os, socket, sys, urllib.request
pid = sys.argv[1]
args = open('/proc/' + pid + '/cmdline', 'rb').read().split(b'\\0')
port = next(int(arg.split(b'=')[1]) for arg in reversed(args) if arg.startswith(b'--remote-debugging-port='))
with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/json/version', timeout=2) as response:
    endpoint = json.load(response)['webSocketDebuggerUrl']
path = '/' + endpoint.split('/', 3)[3]
with socket.create_connection(('127.0.0.1', port), timeout=2) as connection:
    key = base64.b64encode(os.urandom(16)).decode()
    connection.sendall(('GET ' + path + ' HTTP/1.1\\r\\nHost: 127.0.0.1:' + str(port) + '\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: ' + key + '\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n').encode())
    response = b''
    while b'\\r\\n\\r\\n' not in response:
        chunk = connection.recv(4096)
        if not chunk: raise RuntimeError('browser debugger disconnected')
        response += chunk
    if b' 101 ' not in response.split(b'\\r\\n')[0]: raise RuntimeError('browser debugger rejected connection')
    payload = b'{"id":1,"method":"Browser.close"}'
    mask = os.urandom(4)
    connection.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))
    connection.recv(4096)
`;

export function stopBrowserCommand(screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return stopBrowserProfileCommand(
    browserProfilePathForScreen(screenId, env),
    browserPidPathForScreen(screenId),
  );
}

function stopBrowserProfileCommand(profile: string, pidFile: string) {
  return [
    ...browserRunningFunction(profile, pidFile),
    `if browser_running; then`,
    `  python3 -c ${shellQuote(CLOSE_BROWSER)} "$pid" >/dev/null 2>&1 || true`,
    `  for i in $(seq 1 40); do browser_running || break; sleep 0.25; done`,
    `  if browser_running; then kill "$pid" 2>/dev/null || true; for i in $(seq 1 40); do browser_running || break; sleep 0.25; done; fi`,
    `  browser_running && kill -KILL "$pid" 2>/dev/null || true`,
    `fi`,
    `if browser_running; then echo 'browser still running' >&2; exit 1; fi`,
    `rm -f ${pidFile}`,
    `rm -f ${shellQuote(profile)}/SingletonLock ${shellQuote(profile)}/SingletonCookie ${shellQuote(profile)}/SingletonSocket`,
  ].join("\n");
}

/** Quiesce managed profiles before a full workspace export; orchestration excludes active peers. */
export function stopAllDesktopBrowsersCommand(env = DEFAULT_DESKTOP_ENV) {
  const placeholder = "RAKAZO_INTERNAL_PROFILE";
  const stop = stopBrowserProfileCommand(placeholder, '"$pid_file"')
    .replaceAll(shellQuote(`--user-data-dir=${placeholder}`), '"--user-data-dir=$profile"')
    .replaceAll(shellQuote(placeholder), '"$profile"');
  return [
    "set -eu",
    "failed=0",
    `for profile in ${shellQuote(env.browserProfilesDir)}/chromium-bot-*; do`,
    '  [ -d "$profile" ] || continue',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "  hash=${profile##*chromium-bot-}",
    '  pid_file="/tmp/rakazo/browser-pid-$hash"',
    `  bash -eu -c ${shellQuote(`profile=$1; pid_file=$2;\n${stop}`)} desktop "$profile" "$pid_file" || failed=1`,
    "done",
    '[ "$failed" -eq 0 ] || exit 1',
  ].join("\n");
}

/** Reset discovered runtime processes after a supervisor restart; profiles remain durable. */
export function resetDesktopRuntimeCommand(env = DEFAULT_DESKTOP_ENV) {
  const port = String(env.portStart ?? 6080);
  const gatewayPattern = `^([^ ]*/)?python[0-9.]* +(-m +websockify|[^ ]*websockify[^ ]*) +.*[ :]${port}( |$)`;
  const stop = [
    ...layoutVariables(undefined, env),
    renderStopScreenTransportsCommand(undefined, env),
    ...(env.preservePrimaryDisplay
      ? [`if [ "$desktop_display" != "${env.displayStart}" ]; then`]
      : []),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    'pkill -f "[X]vfb :${desktop_display} -screen" || true',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    'pkill -f "[f]luxbox -rc /tmp/fluxbox-home-${desktop_display}/.fluxbox/init" || true',
    ...(env.preservePrimaryDisplay ? ["fi"] : []),
  ].join("\n");
  return [
    "set -eu",
    `pkill -f ${shellQuote(gatewayPattern)} || true`,
    "sleep 0.1",
    `pkill -KILL -f ${shellQuote(gatewayPattern)} || true`,
    stopAllDesktopBrowsersCommand(env),
    "for marker in /tmp/rakazo/browser-profile-*; do",
    '  [ -f "$marker" ] || continue',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    "  display=${marker##*-}",
    '  [[ "$display" =~ ^(0|[1-9][0-9]{0,4})$ ]] || continue',
    `  [ "$display" -ge ${env.displayStart} ] && [ "$display" -le ${MAX_DESKTOP_DISPLAY} ] || continue`,
    `  index=$((display - ${env.displayStart}))`,
    `  bash -eu -c ${shellQuote(stop)} desktop "$index"`,
    "done",
    // Retire the default image's legacy primary VNC process too.
    "pkill -f '^([^ ]*/)?x11vnc .* -rfbport 5900( |$)' || true",
    `rm -f ${TARGETS}/view-* ${TARGETS}/control-* /tmp/rakazo/browser-pid-* /tmp/rakazo/browser-profile-* /tmp/rakazo/browser-launch-*`,
  ].join("\n");
}

const TARGETS = "/tmp/rakazo/desktop-targets";

// Keep fixed mapping files present: TokenFile may be reading the directory concurrently.
function revokeTargetCommand(kind: "view" | "control", display: number | string) {
  return `mkdir -p ${TARGETS}; : >/tmp/rakazo/${kind}-target-next-${display}; mv /tmp/rakazo/${kind}-target-next-${display} ${TARGETS}/${kind}-${display}`;
}

function stopVncCommand(kind: "view" | "control", layout: ReturnType<typeof commandLayout>) {
  const socketPrefix = `/tmp/rakazo/sockets/${kind}-${layout.displayNumber}-`;
  const pattern = quoteLayout(`^([^ ]*/)?x11vnc .* -unixsock ${socketPrefix}[^ ]+( |$)`);
  return [
    `pkill -f ${pattern} || true`,
    "sleep 0.1",
    `pkill -KILL -f ${pattern} || true`,
    `for i in $(seq 1 10); do pgrep -f ${pattern} >/dev/null || break; sleep 0.1; done`,
    `if pgrep -f ${pattern} >/dev/null; then echo 'computer screen transport failed to stop' >&2; exit 1; fi`,
    `rm -f ${socketPrefix}*`,
  ].join("\n");
}

function gatewayCommand(port: string) {
  const processPattern = `^([^ ]*/)?python[0-9.]* +(-m +websockify|[^ ]*websockify[^ ]*) +.*`;
  const portPattern = shellQuote(`${processPattern}[ :]${port}( |$)`);
  const gatewayPattern = shellQuote(
    `${processPattern}--token-source=${TARGETS} +0.0.0.0:${port}( |$)`,
  );
  return [
    proxyEnvironmentCommand(),
    `mkdir -p ${TARGETS}`,
    // This lock only covers gateway startup; desktop startup remains independent.
    `exec 10>/tmp/rakazo/gateway-${port}.lock; flock -w 120 10`,
    `if ! pgrep -f ${gatewayPattern} >/dev/null || ! (echo >/dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1; then`,
    // Older images boot a single-screen gateway on this port. Retire it under the startup lock.
    `  pkill -f ${portPattern} || true`,
    `  for i in $(seq 1 20); do if ! (echo >/dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1; then break; fi; sleep 0.1; done`,
    `  if (echo >/dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1; then echo 'screen gateway port is busy' >&2; exit 1; fi`,
    `  nohup "$proxy" --heartbeat=30 --web="$web" --token-plugin=TokenFile --token-source=${TARGETS} 0.0.0.0:${port} 8>&- 9>&- 10>&- </dev/null >/tmp/rakazo/gateway-${port}.log 2>&1 &`,
    "fi",
    `for i in $(seq 1 50); do (echo >/dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1 && break; sleep 0.1; done`,
    `flock -u 10; exec 10>&-`,
    `(echo >/dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1`,
  ].join("\n");
}

export function stopScreenTransportsCommand(index: number, env = DEFAULT_DESKTOP_ENV) {
  return renderStopScreenTransportsCommand(index, env);
}

export function stopExtraScreenCommand(index: number, screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return renderStopExtraScreenCommand(index, screenId, env);
}

export function ensureScreenCommand(
  index: number,
  screenId: string,
  viewToken: string,
  env = DEFAULT_DESKTOP_ENV,
) {
  return renderEnsureScreenCommand(index, screenId, viewToken, env);
}

function renderStopScreenTransportsCommand(index: number | undefined, env = DEFAULT_DESKTOP_ENV) {
  const layout = commandLayout(index, env);
  return [
    ...layoutVariables(index, env),
    // Drop authorization first, then terminate VNC so already connected gateway clients disconnect.
    revokeTargetCommand("view", layout.displayNumber),
    revokeTargetCommand("control", layout.displayNumber),
    stopVncCommand("view", layout),
    stopVncCommand("control", layout),
    `rm -f /tmp/rakazo/control-token-${layout.displayNumber}`,
  ].join("\n");
}

function renderStopExtraScreenCommand(
  index: number | undefined,
  screenId: string,
  env = DEFAULT_DESKTOP_ENV,
) {
  const layout = commandLayout(index, env);
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  return [
    "set -eu",
    // Stop every client before touching browser state or recycling the display.
    renderStopScreenTransportsCommand(index, env),
    stopBrowserCommand(screenId, env),
    `rm -f /tmp/rakazo/browser-profile-${layout.displayNumber} ${browserLauncherPath(layout.displayNumber)}`,
    ...(index === 0 && env.preservePrimaryDisplay
      ? []
      : [
          ...(env.preservePrimaryDisplay
            ? [`if [ "${layout.displayNumber}" != "${env.displayStart}" ]; then`]
            : []),
          `pkill -f ${quoteLayout(`[X]vfb ${layout.display} -screen`)} || true`,
          `pkill -f ${quoteLayout(`[f]luxbox -rc ${fluxHome}/.fluxbox/init`)} || true`,
          `for i in $(seq 1 20); do if ! xdpyinfo -display ${layout.display} >/dev/null 2>&1; then break; fi; sleep 0.1; done`,
          `if xdpyinfo -display ${layout.display} >/dev/null 2>&1; then echo 'computer screen failed to stop' >&2; exit 1; fi`,
          `rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${layout.displayNumber}`,
          ...(env.preservePrimaryDisplay ? ["fi"] : []),
        ]),
  ].join("\n");
}

/** Create only this bot's profile; its contents survive every desktop release. */
export function prepareBrowserProfileCommand(screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return `mkdir -p ${shellQuote(browserProfilePathForScreen(screenId, env))}`;
}

function proxyEnvironmentCommand() {
  return [
    'if command -v websockify >/dev/null 2>&1; then proxy=$(command -v websockify); elif [ -x /opt/noVNC/utils/websockify/run ]; then proxy=/opt/noVNC/utils/websockify/run; else echo "websockify is required" >&2; exit 1; fi',
    'if [ -d /usr/share/novnc ]; then web=/usr/share/novnc; elif [ -d /opt/noVNC ]; then web=/opt/noVNC; else echo "noVNC is required" >&2; exit 1; fi',
  ].join("\n");
}

function renderEnsureScreenCommand(
  index: number | undefined,
  screenId: string,
  viewToken: string,
  env = DEFAULT_DESKTOP_ENV,
) {
  const layout = commandLayout(index, env);
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  const log = `/tmp/rakazo/screen-${layout.displayNumber}`;
  const profile = browserProfilePathForScreen(screenId, env);
  const pidFile = browserPidPathForScreen(screenId);
  const setupDisplay =
    index === 0 && env.preservePrimaryDisplay
      ? [
          `for i in $(seq 1 100); do xdpyinfo -display ${layout.display} >/dev/null 2>&1 && break; sleep 0.1; done`,
        ]
      : [
          `if ! xdpyinfo -display ${layout.display} >/dev/null 2>&1; then`,
          `  mkdir -p /tmp/rakazo ${fluxHome}/.fluxbox /tmp/.X11-unix`,
          `  rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${layout.displayNumber}`,
          `  nohup Xvfb ${layout.display} -screen 0 1280x800x24 -ac +extension RANDR +render -noreset -nolisten tcp 8>&- 9>&- </dev/null >${log}-xvfb.log 2>&1 &`,
          `  for i in $(seq 1 100); do xdpyinfo -display ${layout.display} >/dev/null 2>&1 && break; sleep 0.1; done`,
          `  xdpyinfo -display ${layout.display} >/dev/null 2>&1 || exit 1`,
          `  if [ -f /etc/rakazo/fluxbox/init ]; then cp /etc/rakazo/fluxbox/init ${fluxHome}/.fluxbox/init; else printf "session.screen0.toolbar.visible: false\\n" >${fluxHome}/.fluxbox/init; fi`,
          `  cp /etc/rakazo/fluxbox/apps ${fluxHome}/.fluxbox/apps 2>/dev/null || true`,
          `  printf '[begin] (Desktop)\\n[exec] (Browser) {%s}\\n[end]\\n' ${browserLauncherPath(layout.displayNumber)} >${fluxHome}/.fluxbox/menu`,
          `  printf '\\nsession.menuFile: %s\\n' ${fluxHome}/.fluxbox/menu >>${fluxHome}/.fluxbox/init`,
          `  HOME=${shellQuote(env.homeDir)} CHROME_USER_DATA_DIR=${shellQuote(profile)} BROWSER=${browserLauncherPath(layout.displayNumber)} DISPLAY=${layout.display} nohup fluxbox -rc ${fluxHome}/.fluxbox/init 8>&- 9>&- </dev/null >${log}-fluxbox.log 2>&1 &`,
          "fi",
        ];
  const targetFile = `${TARGETS}/view-${layout.displayNumber}`;
  const socket = `/tmp/rakazo/sockets/view-${layout.displayNumber}-\${desktop_view_token}`;
  const setupView = [
    `mkdir -p ${TARGETS} /tmp/rakazo/sockets`,
    `if [ ! -S ${socket} ] || ! pgrep -f ${quoteLayout(`^([^ ]*/)?x11vnc .* -unixsock ${socket}( |$)`)} >/dev/null; then`,
    stopVncCommand("view", layout),
    `  nohup x11vnc -display ${layout.display} -forever -shared -viewonly -nopw -rfbport 0 -unixsock ${socket} -xkb -ncache 0 8>&- 9>&- </dev/null >${log}-x11vnc.log 2>&1 &`,
    "fi",
    `for i in $(seq 1 50); do [ -S ${socket} ] && break; sleep 0.1; done`,
    `[ -S ${socket} ] || exit 1`,
    `printf '%s: unix_socket:%s\\n' "$desktop_view_token" ${socket} >/tmp/rakazo/view-target-next-${layout.displayNumber}`,
    `mv /tmp/rakazo/view-target-next-${layout.displayNumber} ${targetFile}`,
    gatewayCommand(layout.viewPort),
  ];
  return [
    "set -eu",
    ...layoutVariables(index, env),
    `desktop_view_token=${shellQuote(viewToken)}`,
    '[[ "$desktop_view_token" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || exit 75',
    proxyEnvironmentCommand(),
    `mkdir -p /tmp/rakazo`,
    `printf %s ${shellQuote(browserLauncherCommand(index, screenId, env))} >${browserLauncherPath(layout.displayNumber)}`,
    `chmod 700 ${browserLauncherPath(layout.displayNumber)}`,
    ...setupDisplay,
    `xdpyinfo -display ${layout.display} >/dev/null 2>&1 || exit 1`,
    `mkdir -p /tmp/rakazo ${shellQuote(path.posix.dirname(profile))}`,
    ...browserRunningFunction(profile, pidFile),
    `printf %s ${shellQuote(profile)} >/tmp/rakazo/browser-profile-${layout.displayNumber}`,
    "if ! browser_running; then",
    prepareBrowserProfileCommand(screenId, env),
    `  rm -f ${shellQuote(profile)}/SingletonLock ${shellQuote(profile)}/SingletonCookie ${shellQuote(profile)}/SingletonSocket`,
    `  nohup ${browserLauncherPath(layout.displayNumber)} 8>&- 9>&- </dev/null >${log}-browser.log 2>&1 & printf %s "$!" >${pidFile}`,
    "fi",
    `for i in $(seq 1 80); do browser_running && (echo >/dev/tcp/127.0.0.1/${layout.debugPort}) >/dev/null 2>&1 && break; sleep 0.25; done`,
    `browser_running && (echo >/dev/tcp/127.0.0.1/${layout.debugPort}) >/dev/null 2>&1 || exit 1`,
    ...setupView,
    `for i in $(seq 1 50); do (echo >/dev/tcp/127.0.0.1/${layout.viewPort}) >/dev/null 2>&1 && exit 0; sleep 0.1; done`,
    "exit 1",
  ].join("\n");
}

export function interactiveScreenCommand(
  interactive: boolean,
  controlToken?: string,
  layout: ReturnType<typeof commandLayout> = screenPorts(0),
) {
  const tokenFile = `/tmp/rakazo/control-token-${layout.displayNumber}`;
  const targetFile = `${TARGETS}/control-${layout.displayNumber}`;
  const stopProcesses = [
    revokeTargetCommand("control", layout.displayNumber),
    stopVncCommand("control", layout),
    `rm -f ${tokenFile}`,
  ].join("\n");
  if (!interactive) {
    if (!controlToken) return stopProcesses;
    return [
      `if [ -f ${tokenFile} ] && [ "$(cat ${tokenFile})" = ${shellQuote(controlToken)} ]; then`,
      stopProcesses,
      "printf 'RAKAZO_CONTROL_RELEASED\\n'",
      "fi",
    ].join("\n");
  }
  if (!controlToken) throw new Error("interactive screen requires a control token");
  const socket = `/tmp/rakazo/sockets/control-${layout.displayNumber}-${browserKeyForScreen(controlToken)}`;
  return [
    `[ -f ${tokenFile} ] && [ "$(cat ${tokenFile})" = ${shellQuote(controlToken)} ] && [ -S ${socket} ] && pgrep -f ${quoteLayout(`^([^ ]*/)?x11vnc .* -unixsock ${socket}( |$)`)} >/dev/null && (echo >/dev/tcp/127.0.0.1/${layout.controlPort}) >/dev/null 2>&1 && exit 0 || true`,
    stopProcesses,
    `mkdir -p ${TARGETS} /tmp/rakazo/sockets`,
    `printf %s ${shellQuote(controlToken)} >${tokenFile}`,
    `nohup x11vnc -display ${layout.display} -forever -shared -nopw -rfbport 0 -unixsock ${socket} -xkb -ncache 0 8>&- 9>&- </dev/null >/tmp/rakazo/x11vnc-control-${layout.displayNumber}.log 2>&1 &`,
    `for i in $(seq 1 50); do [ -S ${socket} ] && break; sleep 0.1; done`,
    `[ -S ${socket} ] || exit 1`,
    `printf '%s: unix_socket:%s\\n' ${shellQuote(controlToken)} ${socket} >/tmp/rakazo/control-target-next-${layout.displayNumber}`,
    `mv /tmp/rakazo/control-target-next-${layout.displayNumber} ${targetFile}`,
    gatewayCommand(layout.controlPort),
  ].join("\n");
}

const REGISTRY = "/tmp/rakazo/desktop-assignments";
const TOKEN_PLACEHOLDER = "RAKAZO_INTERNAL_VIEW_TOKEN";

function registryLockCommand(screenId: string) {
  return [
    "set -eu",
    `dir=${shellQuote(REGISTRY)}`,
    'mkdir -p "$dir"',
    `exec 8>"$dir/${browserKeyForScreen(screenId)}.lifecycle-lock"`,
    "flock -w 120 8",
    'exec 9>"$dir/.lock"',
    "flock -w 120 9",
    `slot="$dir/${browserKeyForScreen(screenId)}.slot"`,
  ];
}

function acceptLeaseCommand(leaseId?: string, release = false) {
  return [
    `incoming=${shellQuote(leaseId ?? "")}`,
    'current=$(sed -n "2p" "$slot" 2>/dev/null || true)',
    'if [ -n "$incoming" ] && [ -n "$current" ] && [ "$incoming" != "$current" ]; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "  incoming_fence=${incoming##*:}; current_fence=${current##*:}",
    '  case "$incoming_fence:$current_fence" in *[!0-9:]*|:*|*:) exit 75 ;; esac',
    release
      ? // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        '  [ "${incoming%:*}" = "${current%:*}" ] && [ "$incoming_fence" -ge "$current_fence" ] || exit 75'
      : '  [ "$incoming_fence" -gt "$current_fence" ] || exit 75',
    "fi",
  ];
}

/** Allocate a live slot while keeping the durable profile keyed by bot identity. */
export function managedDesktopCommand(
  screenId: string,
  leaseId: string | undefined,
  env: DesktopEnvironment,
  viewToken: string,
) {
  return [
    ...registryLockCommand(screenId),
    ...acceptLeaseCommand(leaseId),
    'index=$(sed -n "1p" "$slot" 2>/dev/null || true)',
    'view_token=$(sed -n "3p" "$slot" 2>/dev/null || true)',
    'if [ -z "$index" ]; then',
    `  index=$(python3 -c ${shellQuote(`import pathlib, sys
used = set()
for slot in pathlib.Path(sys.argv[1]).glob("*.slot"):
    try:
        with slot.open() as source: used.add(int(source.readline()))
    except ValueError: pass
# A damaged assignment must not make a live display available to another bot.
for marker in pathlib.Path("/tmp/rakazo").glob("browser-profile-*"):
    display = marker.name.rsplit("-", 1)[-1]
    if display.isascii() and display.isdigit(): used.add(int(display) - ${env.displayStart})
index = 0
while index in used: index += 1
if index > ${MAX_DESKTOP_DISPLAY - env.displayStart}: sys.exit(75)
print(index)
`)} "$dir")`,
    '  [ -n "$index" ] || exit 75',
    `  view_token=${shellQuote(viewToken)}`,
    "fi",
    "case \"$view_token\" in ''|*[!a-zA-Z0-9_-]*) exit 75 ;; esac",
    '[ -n "$incoming" ] || incoming="$current"',
    'printf "%s\\n%s\\n%s\\n" "$index" "$incoming" "$view_token" >"$slot.next"',
    'mv "$slot.next" "$slot"',
    "flock -u 9; exec 9>&-",
    `bash -eu -c ${shellQuote(renderEnsureScreenCommand(undefined, screenId, TOKEN_PLACEHOLDER, env).replace(shellQuote(TOKEN_PLACEHOLDER), '"$2"'))} desktop "$index" "$view_token"`,
    'printf "RAKAZO_DESKTOP=%s:%s\\n" "$index" "$view_token"',
  ].join("\n");
}

/** Tear down before freeing a slot; failed teardown leaves it reserved for retry. */
export function releaseDesktopCommand(
  screenId: string,
  leaseId: string | undefined,
  env: DesktopEnvironment,
) {
  return [
    ...registryLockCommand(screenId),
    '[ -f "$slot" ] || exit 0',
    ...acceptLeaseCommand(leaseId, true),
    'index=$(sed -n "1p" "$slot")',
    "flock -u 9; exec 9>&-",
    `bash -eu -c ${shellQuote(renderStopExtraScreenCommand(undefined, screenId, env))} desktop "$index"`,
    'exec 9>"$dir/.lock"; flock -w 120 9',
    'rm -f "$slot"',
    'printf "RAKAZO_DESKTOP_RELEASED=%s\\n" "$index"',
  ].join("\n");
}

/** Guard a control transition with the persisted allocation and execution fence. */
export function desktopControlCommand(
  screenId: string,
  leaseId: string | undefined,
  env: DesktopEnvironment,
  interactive: boolean,
  token: string,
) {
  return [
    ...registryLockCommand(screenId),
    `[ -f "$slot" ] || exit ${interactive ? 75 : 0}`,
    ...acceptLeaseCommand(leaseId, !interactive),
    'index=$(sed -n "1p" "$slot")',
    "flock -u 9; exec 9>&-",
    `bash -eu -c ${shellQuote([...layoutVariables(undefined, env), interactiveScreenCommand(interactive, token, commandLayout(undefined, env))].join("\n"))} desktop "$index"`,
  ].join("\n");
}

export function desktopUrl(screenUrl: string, token: string) {
  const url = new URL(screenUrl);
  url.searchParams.set("autoconnect", "true");
  url.searchParams.set("resize", "scale");
  const socketQuery = new URLSearchParams(new URL(screenUrl).search);
  socketQuery.set("token", token);
  url.searchParams.set("path", `websockify?${socketQuery}`);
  return url.toString();
}
