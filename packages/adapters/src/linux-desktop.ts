import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ComputerAction,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import {
  BROWSER_APPLICATIONS,
  browserLauncherPath,
  browserProfilePathForScreen,
  type DesktopEnvironment,
  desktopControlCommand,
  desktopUrl,
  managedDesktopCommand,
  releaseDesktopCommand,
  screenPorts,
  shellQuote,
  stopAllDesktopBrowsersCommand,
} from "@rakazo/core/node/desktop-runtime";
import { ComputerScreenUnavailableError, screenSessionKey } from "./computer-screens.js";
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
    // A stale release is a successful no-op. All other errors must retain the slot for retry.
    const result = await this.host.run(
      computer,
      releaseDesktopCommand(screenSessionKey(context), context.screenLeaseId, env),
      context,
    );
    if (result.code !== 0 && result.code !== 75)
      throw new Error(result.stderr || "computer desktop failed to stop");
  }
}

function browserActionCommand(
  action: ComputerAction,
  layout: Parameters<typeof extraDisplayActionCommand>[0],
  env: DesktopEnvironment,
) {
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

/** Install the same X11 tools in minimal Ubuntu sandboxes, only if their image lacks them. */
export const PREPARE_LINUX_DESKTOP = [
  "set -eu",
  'missing=""',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  'for pair in python3:python3 flock:util-linux Xvfb:xvfb xdpyinfo:x11-utils x11vnc:x11vnc fluxbox:fluxbox xdotool:xdotool scrot:scrot; do command -v "${pair%%:*}" >/dev/null 2>&1 || missing="$missing ${pair#*:}"; done',
  'if ! command -v websockify >/dev/null 2>&1 && [ ! -x /opt/noVNC/utils/websockify/run ]; then missing="$missing websockify"; fi',
  'if [ ! -d /usr/share/novnc ] && [ ! -d /opt/noVNC ]; then missing="$missing novnc"; fi',
  'if [ -n "$missing" ]; then',
  '  if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi',
  "  $root apt-get update -qq && $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing",
  "fi",
].join("\n");
