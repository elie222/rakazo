import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ComputerAction,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ScreenRequest,
  ScreenSession,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import {
  BROWSER_APPLICATIONS,
  browserLauncherPath,
  browserProfilePathForScreen,
  type DesktopEnvironment,
  desktopControlCommand,
  desktopTerminalCommand,
  desktopUrl,
  managedDesktopCommand,
  releaseDesktopCommand,
  screenPorts,
  shellQuote,
  stopAllDesktopBrowsersCommand,
} from "@rakazo/core/node/desktop-runtime";
import {
  BrowserStoppedReleaseError,
  ComputerScreenUnavailableError,
  screenSessionKey,
} from "./computer-screens.js";
import {
  boundedComputerActions,
  clampRounded,
  computerObservation,
  workspacePath,
} from "./computer-support.js";
import {
  extraDisplayActionCommand,
  extraDisplayInputCommand,
  observeExtraDisplayCommand,
  parseExtraDisplayObservation,
} from "./extra-displays.js";

export interface LinuxDesktopHost {
  environment(computer: ComputerRef): Promise<DesktopEnvironment>;
  run(
    computer: ComputerRef,
    command: string,
    context: AdapterContext,
  ): Promise<{ code: number; stdout: string; stderr?: string }>;
  screenUrl(computer: ComputerRef, port: number, context: AdapterContext): Promise<string>;
}

/** Provider SDKs supply only command execution, workspace paths, and protected port URLs. */
export class LinuxDesktop {
  constructor(private readonly host: LinuxDesktopHost) {}

  private async run(computer: ComputerRef, command: string, context: AdapterContext) {
    context.signal.throwIfAborted();
    const result = await this.host.run(computer, command, context);
    if (result.code === 75) throw new ComputerScreenUnavailableError();
    if (result.code !== 0) throw new Error(result.stderr || "computer desktop operation failed");
    return result.stdout;
  }

  private async ensure(computer: ComputerRef, context: AdapterContext) {
    const env = await this.host.environment(computer);
    const key = screenSessionKey(context);
    const output = await this.run(
      computer,
      managedDesktopCommand(key, context.screenLeaseId, env, randomUUID()),
      context,
    );
    const match = output.match(/RAKAZO_DESKTOP=(\d+):([a-zA-Z0-9_-]+)/);
    if (!match) throw new ComputerScreenUnavailableError();
    const index = Number(match[1]);
    const ports = screenPorts(index, env);
    const layout = {
      ...ports,
      viewPort: Number(ports.viewPort),
      controlPort: Number(ports.controlPort),
    };
    return { env, key, layout, token: match[2]! };
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const screen = await this.ensure(computer, context);
    let token = screen.token;
    if (request.interactive) {
      if (!request.controlToken) throw new Error("interactive screen requires a control token");
      token = request.controlToken;
      await this.run(
        computer,
        desktopControlCommand(screen.key, context.screenLeaseId, screen.env, true, token),
        context,
      );
    }
    const url = await this.host.screenUrl(
      computer,
      request.interactive ? screen.layout.controlPort : screen.layout.viewPort,
      context,
    );
    return { url: desktopUrl(url, token), mimeType: "text/html", close: async () => undefined };
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const screen = await this.ensure(computer, context);
    const terminalToken = randomUUID();
    await this.run(
      computer,
      desktopTerminalCommand(
        screen.key,
        context.screenLeaseId,
        screen.env,
        request.controlToken,
        terminalToken,
        workspacePath(screen.env.workspaceDir, request.cwd ?? ""),
      ),
      context,
    );
    const url = await this.host.screenUrl(computer, screen.layout.controlPort, context);
    return { url: desktopUrl(url, terminalToken) };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    token?: string,
  ) {
    if (!token) {
      if (interactive) throw new Error("interactive screen requires a control token");
      return;
    }
    const env = interactive
      ? (await this.ensure(computer, context)).env
      : await this.host.environment(computer);
    await this.run(
      computer,
      desktopControlCommand(
        screenSessionKey(context),
        context.screenLeaseId,
        env,
        interactive,
        token,
      ),
      context,
    );
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    const { layout } = await this.ensure(computer, context);
    return this.observeLayout(computer, layout, context);
  }

  private async observeLayout(
    computer: ComputerRef,
    layout: { display: string; displayNumber: number },
    context: AdapterContext,
  ) {
    const output = await this.run(computer, observeExtraDisplayCommand(layout), context);
    const observed = parseExtraDisplayObservation(output);
    return computerObservation(observed.image, {
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: observed.cursor,
    });
  }

  async sendInput(computer: ComputerRef, input: ComputerInput, context: AdapterContext) {
    const { layout } = await this.ensure(computer, context);
    await this.run(computer, extraDisplayInputCommand(layout, input), context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const { layout, env, key } = await this.ensure(computer, context);
    let completed = 0;
    for (const action of boundedComputerActions(request.actions)) {
      await this.run(
        computer,
        `export CHROME_USER_DATA_DIR=${shellQuote(browserProfilePathForScreen(key, env))} BROWSER=${browserLauncherPath(layout.displayNumber)}\n${browserActionCommand(action, layout, env)}`,
        context,
      );
      completed += 1;
    }
    if (request.settleMs)
      await this.run(computer, `sleep ${clampRounded(request.settleMs, 0, 5000) / 1000}`, context);
    return {
      completed,
      ...(request.observe === false
        ? {}
        : { observation: await this.observeLayout(computer, layout, context) }),
    };
  }

  async stopBrowsers(computer: ComputerRef, context: AdapterContext) {
    const env = await this.host.environment(computer);
    await this.run(computer, stopAllDesktopBrowsersCommand(env), context);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    const env = await this.host.environment(computer);
    // A stale release is a successful no-op. A failed stop must retain the slot
    // for retry. Once the browser has stopped, a later slot-cleanup error must
    // not look like Chromium is still running.
    const result = await this.host.run(
      computer,
      releaseDesktopCommand(screenSessionKey(context), context.screenLeaseId, env),
      context,
    );
    if (result.stdout.includes("RAKAZO_DESKTOP_RELEASED=")) {
      if (result.code !== 0 && result.code !== 75) throw new BrowserStoppedReleaseError();
      return;
    }
    if (result.code !== 0 && result.code !== 75)
      throw new Error(result.stderr || "computer desktop failed to stop");
  }
}

function browserActionCommand(
  action: ComputerAction,
  layout: Parameters<typeof extraDisplayActionCommand>[0],
  env: DesktopEnvironment,
) {
  if (action.kind === "focus") {
    const command = focusOrLaunchActionCommand(action, layout);
    // The browser launcher is absolute. Other apps and URIs are workspace-relative,
    // same as the launch path below.
    if (isChromiumBrowser(action.application)) return command;
    return `cd ${shellQuote(env.workspaceDir)}\n${command}`;
  }
  const browser =
    action.kind === "open" && /^https?:\/\//i.test(action.path)
      ? action.path
      : action.kind === "launch" && BROWSER_APPLICATIONS.has(action.application.toLowerCase())
        ? (action.uri ?? "about:blank")
        : undefined;
  if (browser !== undefined) {
    return `nohup ${browserLauncherPath(layout.displayNumber)} ${shellQuote(browser)} </dev/null >/tmp/rakazo/browser-open-${layout.displayNumber}.log 2>&1 &`;
  }
  const workspace = env.workspaceDir;
  return `cd ${shellQuote(workspace)}\n${extraDisplayActionCommand(layout, action.kind === "open" ? { ...action, path: workspacePath(workspace, action.path) } : action)}`;
}

// Chrome-family WM_CLASS components. Matched whole, so "xterm" does not raise "uxterm".
const CHROME_WM_CLASSES = "chromium|chromium-browser|google-chrome|google-chrome-stable|chrome";

// Launch maps every BROWSER_APPLICATIONS name, including firefox, onto the
// Chromium launcher. Focus must use that same set or it cannot raise the window launch opened.
function isChromiumBrowser(application: string) {
  return BROWSER_APPLICATIONS.has(application.toLowerCase());
}

// Same 0.2s quick-failure window as rakazo-focus-or-launch. A GUI that stays
// up is success; an immediate non-zero exit fails the focus before the old
// window is raised.
const FOCUS_URI_PROBE = [
  "import subprocess,sys",
  "try:",
  " code=subprocess.Popen(sys.argv[1:],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).wait(timeout=0.2)",
  "except subprocess.TimeoutExpired:",
  " raise SystemExit(0)",
  "raise SystemExit(code)",
].join("\n");

/**
 * Raise an app's existing window by WM_CLASS, else spawn it — the focus primitive
 * rakazo-focus-or-launch provides inside the computer image, inline for provider desktops.
 * A URI still starts the launcher (Chrome forwards URLs into its live window) without
 * waiting for that process to exit before the match is raised.
 */
function focusOrLaunchActionCommand(
  action: Extract<ComputerAction, { kind: "focus" }>,
  layout: Parameters<typeof extraDisplayActionCommand>[0],
) {
  const browser = isChromiumBrowser(action.application);
  const binary = (action.application.split("/").pop() ?? "").replaceAll(/[^A-Za-z0-9_-]/g, "");
  const quotedApp = shellQuote(action.application);
  const quotedArg = action.uri === undefined ? "" : ` ${shellQuote(action.uri)}`;
  const foreground = browser
    ? `nohup ${browserLauncherPath(layout.displayNumber)} ${shellQuote(action.uri ?? "about:blank")} </dev/null >/tmp/rakazo/browser-open-${layout.displayNumber}.log 2>&1 &`
    : `DISPLAY=${layout.display} ${quotedApp}${quotedArg}`;
  // A GUI that stays in the foreground must not delay wmctrl -ia. A non-browser
  // URI still has to surface a launcher that exits immediately.
  const background = browser
    ? foreground
    : `DISPLAY=${layout.display} python3 -c ${shellQuote(FOCUS_URI_PROBE)} ${quotedApp}${quotedArg} || exit $?`;
  if (!browser && !binary) return foreground;
  const classCase = browser ? CHROME_WM_CLASSES : binary.toLowerCase();
  return [
    "wid=",
    "fallback=",
    "saw_profile=0",
    "while read -r id desktop pid class _; do",
    '  [ -n "$id" ] || continue',
    "  class_lc=$(printf '%s' \"$class\" | tr '[:upper:]' '[:lower:]')",
    "  old_ifs=$IFS",
    "  IFS=.",
    "  set -f",
    "  matched=0",
    "  for part in $class_lc; do",
    `    case "$part" in ${classCase}) matched=1 ;; esac`,
    "  done",
    "  set +f",
    "  IFS=$old_ifs",
    '  [ "$matched" -eq 1 ] || continue',
    '  [ -z "$fallback" ] && fallback=$id',
    // Several Chrome profiles can share a display. Prefer the screen profile when
    // a window advertises --user-data-dir; otherwise keep the first class match.
    ...(browser
      ? [
          '  if [ -n "$CHROME_USER_DATA_DIR" ]; then',
          '    case "$pid" in',
          "      ''|*[!0-9]*) owner=\"\" ;;",
          "      *) owner=$(tr '\\0' '\\n' <\"/proc/$pid/cmdline\" 2>/dev/null | awk 'prev == \"--user-data-dir\" { print; exit } index($0, \"--user-data-dir=\") == 1 { print substr($0, 17); exit } { prev = $0 }') ;;",
          "    esac",
          '    if [ -n "$owner" ]; then',
          "      saw_profile=1",
          '      if [ "$owner" = "$CHROME_USER_DATA_DIR" ]; then wid=$id; break; fi',
          "      continue",
          "    fi",
          "  fi",
        ]
      : ["  wid=$id", "  break"]),
    "done <<RAKAZO_WINDOWS",
    `$(DISPLAY=${layout.display} wmctrl -lxp 2>/dev/null || true)`,
    "RAKAZO_WINDOWS",
    'if [ -z "$wid" ] && [ "$saw_profile" -eq 0 ]; then wid=$fallback; fi',
    'if [ -n "$wid" ]; then',
    ...(action.uri !== undefined ? [`  ${background}`] : []),
    `  DISPLAY=${layout.display} wmctrl -ia "$wid"`,
    "else",
    `  ${foreground}`,
    "fi",
  ].join("\n");
}

/** Install the same X11 tools in minimal Ubuntu sandboxes, only if their image lacks them. */
export const PREPARE_LINUX_DESKTOP = [
  "set -eu",
  'missing=""',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  'for pair in python3:python3 flock:util-linux Xvfb:xvfb xdpyinfo:x11-utils x11vnc:x11vnc fluxbox:fluxbox xdotool:xdotool wmctrl:wmctrl scrot:scrot xterm:xterm; do command -v "${pair%%:*}" >/dev/null 2>&1 || missing="$missing ${pair#*:}"; done',
  'if ! command -v websockify >/dev/null 2>&1 && [ ! -x /opt/noVNC/utils/websockify/run ]; then missing="$missing websockify"; fi',
  'if [ ! -d /usr/share/novnc ] && [ ! -d /opt/noVNC ]; then missing="$missing novnc"; fi',
  'if [ -n "$missing" ]; then',
  '  if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi',
  "  $root apt-get update -qq && $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing",
  "fi",
].join("\n");
