import { createHash } from "node:crypto";
import path from "node:path";
export const TEAM_SCREEN_LIMIT = 8;
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
  vncPortStart?: number;
}
export const DEFAULT_DESKTOP_ENV: DesktopEnvironment = {
  homeDir: "/home/rakazo",
  workspaceDir: "/home/rakazo",
  browserProfilesDir: "/home/rakazo/.browser-profiles",
  displayStart: 1,
  preservePrimaryDisplay: true,
};
export function screenPorts(index: number, env = DEFAULT_DESKTOP_ENV) {
  if (!Number.isInteger(index) || index < 0 || index >= TEAM_SCREEN_LIMIT)
    throw new Error("invalid desktop index");
  const displayNumber = env.displayStart + index;
  return {
    display: `:${displayNumber}`,
    displayNumber,
    viewPort: String((env.portStart ?? 6080) + index * 2),
    controlPort: String((env.portStart ?? 6080) + 1 + index * 2),
    viewVncPort: (env.vncPortStart ?? 5900) + index * 2,
    controlVncPort: (env.vncPortStart ?? 5900) + 1 + index * 2,
  };
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

export function browserLauncherPath(displayNumber: number) {
  return `/tmp/rakazo/browser-launch-${displayNumber}`;
}

function browserLauncherCommand(index: number, screenId: string, env: DesktopEnvironment) {
  const layout = screenPorts(index, env);
  return [
    "#!/bin/bash",
    "set -eu",
    "browser=$(command -v rakazo-browser || command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)",
    `export DISPLAY=${layout.display} HOME=${shellQuote(env.homeDir)}`,
    `exec "$browser" --no-sandbox --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=${9221 + layout.displayNumber} --user-data-dir=${shellQuote(browserProfilePathForScreen(screenId, env))} "$@"`,
  ].join("\n");
}

// Browser.close flushes cookies and profile databases; SIGTERM alone can discard recent cookies.
const CLOSE_BROWSER = `import base64, json, os, socket, sys, urllib.request
pid = sys.argv[1]
args = open('/proc/' + pid + '/cmdline', 'rb').read().split(b'\\0')
port = next(int(arg.split(b'=')[1]) for arg in args if arg.startswith(b'--remote-debugging-port='))
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

function controlTokenPath(index: number) {
  return index === 0 ? "/tmp/rakazo/control-token" : `/tmp/rakazo/control-token-${index + 1}`;
}

function stopScreenTransportCommand(vncPort: number, webPort: string) {
  const patterns = [
    `^([^ ]*/)?x11vnc .* -rfbport ${vncPort}( |$)`,
    `^([^ ]*/)?python[0-9.]* +(-m +websockify|[^ ]*websockify[^ ]*) +.*[ :]${webPort}( |$)`,
  ];
  const listening = [webPort, vncPort]
    .map((port) => `timeout 1 bash -c 'echo >/dev/tcp/127.0.0.1/${port}' >/dev/null 2>&1`)
    .join(" || ");
  return [
    "set -eu",
    ...patterns.map((pattern) => `pkill -f ${shellQuote(pattern)} || true`),
    "sleep 0.1",
    // Transport children may be blocked on a client that stopped reading.
    ...patterns.map((pattern) => `pkill -KILL -f ${shellQuote(pattern)} || true`),
    `for i in $(seq 1 10); do if ! { ${listening}; }; then break; fi; sleep 0.1; done`,
    `if ${listening}; then echo 'computer screen transport failed to stop' >&2; exit 1; fi`,
  ].join("\n");
}

export function stopScreenTransportsCommand(index: number, env = DEFAULT_DESKTOP_ENV) {
  const layout = screenPorts(index, env);
  return [
    stopScreenTransportCommand(layout.viewVncPort, layout.viewPort),
    stopScreenTransportCommand(layout.controlVncPort, layout.controlPort),
    `rm -f ${controlTokenPath(layout.displayNumber - 1)} /tmp/rakazo/control-target-${layout.displayNumber} /tmp/rakazo/view-target-${layout.displayNumber}`,
  ].join("\n");
}

export function stopExtraScreenCommand(index: number, screenId: string, env = DEFAULT_DESKTOP_ENV) {
  const layout = screenPorts(index, env);
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  return [
    "set -eu",
    // Stop every client before touching browser state or recycling the display.
    stopScreenTransportsCommand(index, env),
    stopBrowserCommand(screenId, env),
    `rm -f /tmp/rakazo/browser-profile-${layout.displayNumber} ${browserLauncherPath(layout.displayNumber)}`,
    ...(index === 0 && env.preservePrimaryDisplay
      ? []
      : [
          `pkill -f '[X]vfb ${layout.display} -screen' || true`,
          `pkill -f '[f]luxbox -rc ${fluxHome}/.fluxbox/init' || true`,
          `for i in $(seq 1 20); do if ! xdpyinfo -display ${layout.display} >/dev/null 2>&1; then break; fi; sleep 0.1; done`,
          `if xdpyinfo -display ${layout.display} >/dev/null 2>&1; then echo 'computer screen failed to stop' >&2; exit 1; fi`,
          `rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${layout.displayNumber}`,
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

export function ensureScreenCommand(
  index: number,
  screenId: string,
  viewToken: string,
  env = DEFAULT_DESKTOP_ENV,
) {
  const layout = screenPorts(index, env);
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
          `  nohup Xvfb ${layout.display} -screen 0 1280x800x24 -ac +extension RANDR +render -noreset 8>&- 9>&- </dev/null >${log}-xvfb.log 2>&1 &`,
          `  for i in $(seq 1 100); do xdpyinfo -display ${layout.display} >/dev/null 2>&1 && break; sleep 0.1; done`,
          `  xdpyinfo -display ${layout.display} >/dev/null 2>&1 || exit 1`,
          `  if [ -f /etc/rakazo/fluxbox/init ]; then cp /etc/rakazo/fluxbox/init ${fluxHome}/.fluxbox/init; else printf "session.screen0.toolbar.visible: false\\n" >${fluxHome}/.fluxbox/init; fi`,
          `  cp /etc/rakazo/fluxbox/apps ${fluxHome}/.fluxbox/apps 2>/dev/null || true`,
          `  printf %s ${shellQuote(`[begin] (Desktop)\n[exec] (Browser) {${browserLauncherPath(layout.displayNumber)}}\n[end]\n`)} >${fluxHome}/.fluxbox/menu`,
          `  printf '\nsession.menuFile: ${fluxHome}/.fluxbox/menu\n' >>${fluxHome}/.fluxbox/init`,
          `  HOME=${shellQuote(env.homeDir)} CHROME_USER_DATA_DIR=${shellQuote(profile)} BROWSER=${browserLauncherPath(layout.displayNumber)} DISPLAY=${layout.display} nohup fluxbox -rc ${fluxHome}/.fluxbox/init 8>&- 9>&- </dev/null >${log}-fluxbox.log 2>&1 &`,
          "fi",
        ];
  const targetFile = `/tmp/rakazo/view-target-${layout.displayNumber}`;
  const setupView = [
    `printf '%s: 127.0.0.1:${layout.viewVncPort}\\n' ${shellQuote(viewToken)} >${targetFile}`,
    `if ! (echo >/dev/tcp/127.0.0.1/${layout.viewPort}) >/dev/null 2>&1; then`,
    `  nohup x11vnc -display ${layout.display} -forever -shared -viewonly -nopw -listen 127.0.0.1 -rfbport ${layout.viewVncPort} -xkb -ncache 0 8>&- 9>&- </dev/null >${log}-x11vnc.log 2>&1 &`,
    `  nohup "$proxy" --heartbeat=30 --web="$web" --token-plugin=TokenFile --token-source=${targetFile} 0.0.0.0:${layout.viewPort} 8>&- 9>&- </dev/null >${log}-novnc.log 2>&1 &`,
    "fi",
  ];
  return [
    "set -eu",
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
    `for i in $(seq 1 80); do browser_running && (echo >/dev/tcp/127.0.0.1/${9221 + layout.displayNumber}) >/dev/null 2>&1 && break; sleep 0.25; done`,
    `browser_running && (echo >/dev/tcp/127.0.0.1/${9221 + layout.displayNumber}) >/dev/null 2>&1 || exit 1`,
    ...setupView,
    `for i in $(seq 1 50); do (echo >/dev/tcp/127.0.0.1/${layout.viewPort}) >/dev/null 2>&1 && exit 0; sleep 0.1; done`,
    "exit 1",
  ].join("\n");
}

export function interactiveScreenCommand(
  interactive: boolean,
  controlToken?: string,
  layout = screenPorts(0),
) {
  const tokenFile = controlTokenPath(layout.displayNumber - 1);
  const targetFile = `/tmp/rakazo/control-target-${layout.displayNumber}`;
  const stopTransport = stopScreenTransportCommand(layout.controlVncPort, layout.controlPort);
  const stopProcesses = [stopTransport, `rm -f ${tokenFile} ${targetFile}`].join("\n");
  if (!interactive) {
    if (!controlToken) return stopProcesses;
    return [
      `if [ -f ${tokenFile} ] && [ "$(cat ${tokenFile})" = ${shellQuote(controlToken)} ]; then`,
      stopTransport,
      `rm -f ${targetFile} ${tokenFile}`,
      "printf 'RAKAZO_CONTROL_RELEASED\\n'",
      "fi",
    ].join("\n");
  }
  if (!controlToken) throw new Error("interactive screen requires a control token");
  return [
    `[ -f ${tokenFile} ] && [ "$(cat ${tokenFile})" = ${shellQuote(controlToken)} ] && (echo >/dev/tcp/127.0.0.1/${layout.controlVncPort}) >/dev/null 2>&1 && (echo >/dev/tcp/127.0.0.1/${layout.controlPort}) >/dev/null 2>&1 && exit 0 || true`,
    proxyEnvironmentCommand(),
    stopProcesses,
    `printf %s ${shellQuote(controlToken)} > ${tokenFile}`,
    `printf '%s: 127.0.0.1:${layout.controlVncPort}\\n' ${shellQuote(controlToken)} > ${targetFile}`,
    `export DISPLAY=${layout.display}`,
    `(nohup x11vnc -display ${layout.display} -forever -shared -nopw -listen 127.0.0.1 -rfbport ${layout.controlVncPort} -xkb -ncache 0 8>&- 9>&- </dev/null >/tmp/rakazo/x11vnc-control-${layout.displayNumber}.log 2>&1 &)`,
    `(nohup "$proxy" --heartbeat=30 --web="$web" --token-plugin=TokenFile --token-source=${targetFile} 0.0.0.0:${layout.controlPort} 8>&- 9>&- </dev/null >/tmp/rakazo/novnc-control-${layout.displayNumber}.log 2>&1 &)`,
    `for i in $(seq 1 50); do (echo >/dev/tcp/127.0.0.1/${layout.controlPort}) >/dev/null 2>&1 && exit 0; sleep 0.1; done`,
    "exit 1",
  ].join("; ");
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

/** Allocate a bounded live slot while keeping the durable profile keyed by bot identity. */
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
    `  for candidate in $(seq 0 ${TEAM_SCREEN_LIMIT - 1}); do`,
    '    used=0; for other in "$dir"/*.slot; do [ -f "$other" ] || continue; [ "$(sed -n "1p" "$other")" != "$candidate" ] || used=1; done',
    '    if [ "$used" -eq 0 ]; then index=$candidate; break; fi',
    "  done",
    '  [ -n "$index" ] || exit 75',
    `  view_token=${shellQuote(viewToken)}`,
    "fi",
    "case \"$view_token\" in ''|*[!a-zA-Z0-9_-]*) exit 75 ;; esac",
    '[ -n "$incoming" ] || incoming="$current"',
    'printf "%s\\n%s\\n%s\\n" "$index" "$incoming" "$view_token" >"$slot.next"',
    'mv "$slot.next" "$slot"',
    "flock -u 9; exec 9>&-",
    "case $index in",
    ...Array.from(
      { length: TEAM_SCREEN_LIMIT },
      (_, index) =>
        `${index}) bash -eu -c ${shellQuote(ensureScreenCommand(index, screenId, TOKEN_PLACEHOLDER, env).replace(shellQuote(TOKEN_PLACEHOLDER), '"$1"'))} desktop "$view_token" ;;`,
    ),
    "*) exit 75 ;;",
    "esac",
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
    "case $index in",
    ...Array.from(
      { length: TEAM_SCREEN_LIMIT },
      (_, index) =>
        `${index}) bash -eu -c ${shellQuote(stopExtraScreenCommand(index, screenId, env))} ;;`,
    ),
    "*) exit 75 ;;",
    "esac",
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
    "case $index in",
    ...Array.from(
      { length: TEAM_SCREEN_LIMIT },
      (_, index) =>
        `${index}) bash -eu -c ${shellQuote(interactiveScreenCommand(interactive, token, screenPorts(index, env)))} ;;`,
    ),
    "*) exit 75 ;;",
    "esac",
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
