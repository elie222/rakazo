import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Sandbox, TimeoutError } from "@e2b/desktop";
import type {
  AdapterContext,
  CommandRequest,
  ComputerAction,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { sandboxIdleMs } from "./computer-idle.js";
import {
  boundedComputerActions,
  clampRounded,
  computerObservation,
  normalizeWorkspacePath,
  shellQuote,
  workspacePath,
} from "./computer-support.js";
import {
  PORTABLE_BROWSER_STOP_COMMAND,
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";

const E2B_WORKSPACE = "/home/user/rakazo-home";
const E2B_BROWSER_PROFILES = `${E2B_WORKSPACE}/.browser-profiles`;

export interface E2BSandboxSdk {
  create(options: ReturnType<typeof e2bCreateOptions>): Promise<Sandbox>;
  connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<Sandbox>;
  pause(id: string, options: { apiKey: string }): Promise<void>;
}

export function e2bCreateOptions(botId: string, apiKey: string) {
  return {
    apiKey,
    timeoutMs: sandboxIdleMs(),
    metadata: { botId, rakazo: "computer" },
    resolution: [1280, 800] as [number, number],
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
  };
}

export function isUnrecoverableSandboxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|does not exist|404|not_found|killed|doesn't exist|sandbox not found/i.test(
    message,
  );
}

export const E2B_BROWSER_APPS = ["google-chrome", "firefox", "chromium"] as const;

export async function openDesktopBrowser(desktop: {
  launch: (application: string, uri?: string) => Promise<void>;
  open: (fileOrUrl: string) => Promise<void>;
}): Promise<void> {
  for (const app of E2B_BROWSER_APPS) {
    try {
      await desktop.launch(app);
      return;
    } catch {
      // try the next installed browser
    }
  }
  await desktop.open("https://www.google.com").catch(() => undefined);
}

export class E2BSandboxProvider implements SandboxProvider {
  private readonly boxes = new Map<string, Sandbox>();
  private readonly lastTouchedAt = new Map<string, number>();
  private readonly streamReady = new Set<string>();
  private readonly streamStarts = new Map<string, Promise<void>>();
  private readonly controlStreams = new Map<string, { password: string; controlToken: string }>();

  constructor(
    private readonly apiKey: string,
    private readonly sdk: E2BSandboxSdk = Sandbox as unknown as E2BSandboxSdk,
  ) {}

  describe() {
    return {
      id: "e2b",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
      },
    };
  }

  private async box(computer: ComputerRef): Promise<Sandbox> {
    const id = computer.providerRef || computer.id;
    const existing = this.boxes.get(id);
    if (existing) {
      const lastTouched = this.lastTouchedAt.get(id) ?? 0;
      if (Date.now() - lastTouched >= 60_000) {
        await existing.setTimeout(sandboxIdleMs()).catch(() => undefined);
        this.lastTouchedAt.set(id, Date.now());
      }
      return existing;
    }
    const connected = await this.sdk.connect(id, {
      apiKey: this.apiKey,
      timeoutMs: sandboxIdleMs(),
    });
    this.boxes.set(connected.sandboxId, connected);
    this.lastTouchedAt.set(connected.sandboxId, Date.now());
    return connected;
  }

  private async startStream(desktop: Sandbox) {
    if (this.boxes.get(desktop.sandboxId) !== desktop) {
      throw new Error("screen stream stopped during computer teardown");
    }
    if (this.streamReady.has(desktop.sandboxId)) return;
    const pending = this.streamStarts.get(desktop.sandboxId);
    if (pending) return pending;
    let start!: Promise<void>;
    start = this.initializeStream(desktop).finally(() => {
      if (this.streamStarts.get(desktop.sandboxId) === start) {
        this.streamStarts.delete(desktop.sandboxId);
      }
    });
    this.streamStarts.set(desktop.sandboxId, start);
    return start;
  }

  private async initializeStream(desktop: Sandbox) {
    await desktop.commands
      .run("pkill -x x11vnc || true; pkill -f '[n]ovnc_proxy|[w]ebsockify.*6080' || true")
      .catch(() => undefined);
    await desktop.stream.start({ requireAuth: true });
    try {
      await desktop.commands.run("x11vnc -R viewonly");
    } catch (error) {
      await desktop.stream.stop().catch(() => undefined);
      throw error;
    }
    const current = this.boxes.get(desktop.sandboxId);
    if (current !== desktop) {
      if (!current) await desktop.stream.stop().catch(() => undefined);
      throw new Error("screen stream stopped during computer teardown");
    }
    this.streamReady.add(desktop.sandboxId);
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef && request.providerKind === "e2b") {
      try {
        const desktop = await this.sdk.connect(request.providerRef, {
          apiKey: this.apiKey,
          timeoutMs: sandboxIdleMs(),
        });
        if (await configurePortableBrowserProfiles(desktop)) await openDesktopBrowser(desktop);
        this.boxes.set(desktop.sandboxId, desktop);
        this.lastTouchedAt.set(desktop.sandboxId, Date.now());
        return {
          id: desktop.sandboxId,
          botId: request.botId,
          kind: "e2b",
          providerRef: desktop.sandboxId,
          fresh: false,
        };
      } catch (error) {
        this.boxes.delete(request.providerRef);
        if (!isUnrecoverableSandboxError(error)) throw error;
      }
    }
    const desktop = await this.sdk.create(e2bCreateOptions(request.botId, this.apiKey));
    await desktop.files.makeDir(E2B_WORKSPACE).catch(() => undefined);
    this.boxes.set(desktop.sandboxId, desktop);
    this.lastTouchedAt.set(desktop.sandboxId, Date.now());
    return {
      id: desktop.sandboxId,
      botId: request.botId,
      kind: "e2b",
      providerRef: desktop.sandboxId,
      fresh: true,
    };
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const desktop = await this.box(computer);
    const cmd = request.argv.map(shellQuote).join(" ");
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    try {
      const result = await desktop.commands.run(cmd, {
        cwd: e2bCwd(request.cwd),
        envs: request.env,
        signal: context.signal,
        timeoutMs,
      });
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.exitCode ?? 0 };
    } catch (error) {
      if (error instanceof TimeoutError) {
        yield { type: "stderr", data: `command timed out after ${timeoutMs} ms\n` };
        yield { type: "exit", code: 124 };
        return;
      }
      throw error;
    }
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    const desktop = await this.box(computer);
    await this.startStream(desktop);
    if (request.interactive) {
      if (!request.controlToken) throw new Error("interactive screen requires a control token");
      const password = await this.startControlStream(desktop, request.controlToken);
      const url = new URL(`https://${desktop.getHost(6081)}/vnc.html`);
      url.searchParams.set("autoconnect", "true");
      url.searchParams.set("resize", "scale");
      url.searchParams.set("password", password);
      return {
        url: url.toString(),
        mimeType: "text/html",
        close: async () => undefined,
      };
    }
    let authKey: string | undefined;
    try {
      authKey = desktop.stream.getAuthKey();
    } catch {
      authKey = undefined;
    }
    const url =
      typeof desktop.stream.getUrl === "function"
        ? desktop.stream.getUrl({
            autoConnect: true,
            viewOnly: true,
            resize: "scale",
            ...(authKey ? { authKey } : {}),
          })
        : null;
    return {
      url,
      mimeType: "text/html",
      close: async () => {
        await desktop.stream.stop().catch(() => undefined);
        this.streamReady.delete(desktop.sandboxId);
      },
    };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    _context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    const desktop = await this.box(computer);
    if (interactive) {
      if (!controlToken) throw new Error("interactive screen requires a control token");
      await this.startControlStream(desktop, controlToken);
    } else {
      await this.stopControlStream(desktop, controlToken);
    }
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    const desktop = await this.box(computer);
    await applyE2BAction(desktop, input);
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const desktop = await this.box(computer);
    return observeE2BDesktop(desktop, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const desktop = await this.box(computer);
    const actions = boundedComputerActions(request.actions);
    let completed = 0;
    for (const action of actions) {
      if (context.signal.aborted)
        throw context.signal.reason ?? new Error("computer action aborted");
      await applyE2BAction(desktop, action);
      completed += 1;
    }
    if (request.settleMs) await desktop.wait(clampRounded(request.settleMs, 0, 5_000));
    return {
      completed,
      ...(request.observe === false
        ? {}
        : { observation: await observeE2BDesktop(desktop, context) }),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const desktop = await this.box(computer);
    const relative = normalizeWorkspacePath(directory);
    const entries = await desktop.files.list(workspacePath(E2B_WORKSPACE, relative), {
      signal: context.signal,
    });
    return entries.flatMap((entry) => {
      if (entry.type !== "file" && entry.type !== "dir") return [];
      return [
        {
          path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
          kind: entry.type,
          size: entry.size,
          ...(entry.type === "file" && entry.mode & 0o100 ? { executable: true } : {}),
        },
      ];
    });
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const desktop = await this.box(computer);
    const target = workspacePath(E2B_WORKSPACE, filePath);
    if (options?.maxBytes !== undefined) {
      const info = await desktop.files.getInfo(target, { signal: context.signal });
      if (info.size > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    return desktop.files.read(target, {
      format: "bytes",
      signal: context.signal,
    });
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const desktop = await this.box(computer);
    await writeE2BFiles(desktop, [file], context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const desktop = await this.box(computer);
    await stopDesktopBrowsers(desktop);
    try {
      yield* walkE2BWorkspace(desktop, "", context);
    } finally {
      if (context.operationId !== "stop" && context.operationId !== "computer.sleep") {
        await openDesktopBrowser(desktop);
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const desktop = await this.box(computer);
    await desktop.files.makeDir(E2B_WORKSPACE, { signal: context.signal });
    await stopDesktopBrowsers(desktop);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await writeE2BFiles(desktop, batch, context);
      batch = [];
      batchBytes = 0;
    };
    for await (const file of files) {
      if (
        batch.length >= 32 ||
        batchBytes + file.content.byteLength > PORTABLE_TRANSFER_BATCH_BYTES
      ) {
        await flush();
      }
      batch.push(file);
      batchBytes += file.content.byteLength;
    }
    await flush();
    await configurePortableBrowserProfiles(desktop);
    await openDesktopBrowser(desktop);
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    const observation = await this.observe(computer, _context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    const desktop = await this.box(computer);
    await desktop.setTimeout(sandboxIdleMs()).catch(() => undefined);
    this.lastTouchedAt.set(desktop.sandboxId, Date.now());
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const pending = this.streamStarts.get(id);
    const desktop = this.boxes.get(id);
    this.forget(id);
    await settleForTeardown(pending);
    if (desktop) {
      await desktop.pause().catch(() => undefined);
      return;
    }
    await this.sdk.pause(id, { apiKey: this.apiKey }).catch(() => undefined);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const desktop = this.boxes.get(id) ?? (await this.box(computer).catch(() => undefined));
    const pending = this.streamStarts.get(id);
    this.forget(id);
    await settleForTeardown(pending);
    await desktop?.kill();
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.lastTouchedAt.delete(id);
    this.streamReady.delete(id);
    this.streamStarts.delete(id);
    this.controlStreams.delete(id);
  }

  private async startControlStream(desktop: Sandbox, controlToken: string): Promise<string> {
    const existing = this.controlStreams.get(desktop.sandboxId);
    if (existing?.controlToken === controlToken) return existing.password;
    const password = randomBytes(6).toString("base64url");
    const passwordFile = "/tmp/rakazo-control.vncpass";
    const tokenFile = "/tmp/rakazo-control.token";
    const command = [
      controlStreamStopCommand(),
      `printf %s ${shellQuote(controlToken)} > ${tokenFile}`,
      `x11vnc -storepasswd ${shellQuote(password)} ${passwordFile} >/dev/null`,
      `x11vnc -bg -display ${shellQuote(desktop.display)} -forever -wait 50 -shared -rfbport 5901 -rfbauth ${passwordFile} 2>/tmp/rakazo-control-x11vnc.log`,
      "cd /opt/noVNC/utils",
      "(nohup ./novnc_proxy --vnc localhost:5901 --listen 6081 --web /opt/noVNC >/tmp/rakazo-control-novnc.log 2>&1 &)",
      "for i in $(seq 1 50); do netstat -tuln | grep -q ':6081 ' && exit 0; sleep 0.1; done",
      "exit 1",
    ].join(" && ");
    const result = await desktop.commands.run(command);
    if (result.exitCode !== 0) throw new Error(result.stderr || "control stream failed to start");
    this.controlStreams.set(desktop.sandboxId, { password, controlToken });
    return password;
  }

  private async stopControlStream(desktop: Sandbox, controlToken?: string): Promise<void> {
    await desktop.commands.run(controlStreamStopCommand(controlToken));
    const existing = this.controlStreams.get(desktop.sandboxId);
    if (!controlToken || existing?.controlToken === controlToken) {
      this.controlStreams.delete(desktop.sandboxId);
    }
  }
}

async function settleForTeardown(pending: Promise<void> | undefined): Promise<void> {
  if (!pending) return;
  await Promise.race([pending.catch(() => undefined), delay(5_000, undefined, { ref: false })]);
}

function controlStreamStopCommand(controlToken?: string) {
  const stop = [
    "pkill -f '^x11vnc .* -rfbport 5901' || true",
    "pkill -f '^/usr/bin/python3 .*websockify.*6081' || true",
    "rm -f /tmp/rakazo-control.vncpass",
    "rm -f /tmp/rakazo-control.token",
  ].join("; ");
  if (!controlToken) return stop;
  return `[ -f /tmp/rakazo-control.token ] && [ "$(cat /tmp/rakazo-control.token)" != ${shellQuote(controlToken)} ] || { ${stop}; }`;
}

async function observeE2BDesktop(
  desktop: Sandbox,
  context: AdapterContext,
): Promise<ComputerObservation> {
  const [image, size, cursor, windowId] = await Promise.all([
    desktop.screenshot("bytes"),
    desktop.getScreenSize().catch(() => ({ width: 1280, height: 800 })),
    desktop.getCursorPosition().catch(() => undefined),
    desktop.getCurrentWindowId().catch(() => undefined),
  ]);
  if (context.signal.aborted)
    throw context.signal.reason ?? new Error("computer observation aborted");
  const title = windowId
    ? await desktop.getWindowTitle(windowId).catch(() => undefined)
    : undefined;
  return computerObservation(image, {
    mimeType: "image/png",
    width: size.width,
    height: size.height,
    cursor,
    activeWindow: windowId ? { id: windowId, title } : undefined,
  });
}

async function writeE2BFiles(
  desktop: Sandbox,
  files: readonly PortableFile[],
  context: AdapterContext,
) {
  if (!files.length) return;
  await desktop.files.write(
    files.map((file) => ({
      path: workspacePath(E2B_WORKSPACE, file.path),
      data: toArrayBuffer(file.content),
    })),
    { signal: context.signal },
  );
  const executable = files
    .filter((file) => file.executable)
    .map((file) => shellQuote(workspacePath(E2B_WORKSPACE, file.path)));
  if (executable.length) {
    await desktop.commands.run(`chmod 700 -- ${executable.join(" ")}`, {
      signal: context.signal,
    });
  }
}

async function configurePortableBrowserProfiles(desktop: Sandbox): Promise<boolean> {
  const chromium = `${E2B_BROWSER_PROFILES}/chromium`;
  const chrome = chromium;
  const firefox = `${E2B_BROWSER_PROFILES}/firefox`;
  const configured = await desktop.commands
    .run(
      [
        `test "$(readlink -f /home/user/.config/google-chrome 2>/dev/null)" = ${shellQuote(chrome)}`,
        `test "$(readlink -f /home/user/.config/chromium 2>/dev/null)" = ${shellQuote(chromium)}`,
        `test "$(readlink -f /home/user/.mozilla 2>/dev/null)" = ${shellQuote(firefox)}`,
      ].join(" && "),
    )
    .then(
      () => true,
      () => false,
    );
  if (configured) return false;
  await stopDesktopBrowsers(desktop);
  await desktop.commands.run(
    [
      `mkdir -p ${shellQuote(chrome)} ${shellQuote(chromium)} ${shellQuote(firefox)} /home/user/.config`,
      "rm -rf /home/user/.config/google-chrome /home/user/.config/chromium /home/user/.mozilla",
      `ln -s ${shellQuote(chrome)} /home/user/.config/google-chrome`,
      `ln -s ${shellQuote(chromium)} /home/user/.config/chromium`,
      `ln -s ${shellQuote(firefox)} /home/user/.mozilla`,
    ].join(" && "),
  );
  return true;
}

async function stopDesktopBrowsers(desktop: Sandbox): Promise<void> {
  await desktop.commands.run(PORTABLE_BROWSER_STOP_COMMAND).catch(() => undefined);
}

async function applyE2BAction(desktop: Sandbox, action: ComputerAction): Promise<void> {
  if (action.kind === "key") {
    await desktop.press([...(action.modifiers ?? []), action.key]);
    return;
  }
  if (action.kind === "pointer") {
    if (action.type === "move") await desktop.moveMouse(action.x, action.y);
    else if (action.type === "down") {
      await desktop.moveMouse(action.x, action.y);
      await desktop.mousePress(action.button ?? "left");
    } else if (action.type === "up") {
      await desktop.moveMouse(action.x, action.y);
      await desktop.mouseRelease(action.button ?? "left");
    } else {
      await desktop.moveMouse(action.x, action.y);
      if (action.button === "right") await desktop.rightClick();
      else await desktop.leftClick();
    }
    return;
  }
  if (action.kind === "clipboard") {
    await desktop.write(action.text);
    return;
  }
  if (action.kind === "scroll") {
    await desktop.scroll(action.direction, clampRounded(action.amount ?? 3, 1, 20));
    return;
  }
  if (action.kind === "wait") {
    await desktop.wait(clampRounded(action.ms, 0, 5_000));
    return;
  }
  if (action.kind === "open") {
    const value = /^https?:\/\//i.test(action.path)
      ? action.path
      : workspacePath(E2B_WORKSPACE, action.path);
    await desktop.open(value);
    return;
  }
  await desktop.launch(action.application, action.uri);
}

async function* walkE2BWorkspace(
  desktop: Sandbox,
  directory: string,
  context: AdapterContext,
): AsyncIterable<PortableFile> {
  const entries = await desktop.files.list(workspacePath(E2B_WORKSPACE, directory), {
    signal: context.signal,
  });
  const files: Array<{ relative: string; mode: number }> = [];
  const directories: string[] = [];
  for (const entry of entries) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (shouldSkipPortableWorkspaceFile(relative)) continue;
    if (entry.type === "dir") directories.push(relative);
    else if (entry.type === "file") files.push({ relative, mode: entry.mode });
  }
  for (let index = 0; index < files.length; index += 8) {
    const batch = await Promise.all(
      files.slice(index, index + 8).map(async ({ relative, mode }) => {
        const content = await desktop.files
          .read(workspacePath(E2B_WORKSPACE, relative), {
            format: "bytes",
            signal: context.signal,
          })
          .catch((error) => {
            if (relative.startsWith(".browser-profiles/")) return undefined;
            throw error;
          });
        if (!content) return undefined;
        return { path: relative, content, executable: Boolean(mode & 0o100) };
      }),
    );
    for (const file of batch) {
      if (file) yield file;
    }
  }
  for (const relative of directories) yield* walkE2BWorkspace(desktop, relative, context);
}

function e2bCwd(cwd: string | undefined): string {
  if (
    !cwd ||
    cwd === "." ||
    cwd === "/" ||
    cwd === "/home/rakazo" ||
    cwd === "/home/user" ||
    cwd === E2B_WORKSPACE
  ) {
    return E2B_WORKSPACE;
  }
  const relative = cwd.startsWith(`${E2B_WORKSPACE}/`)
    ? cwd.slice(E2B_WORKSPACE.length + 1)
    : cwd.startsWith("/home/rakazo/")
      ? cwd.slice("/home/rakazo/".length)
      : cwd;
  return workspacePath(E2B_WORKSPACE, relative);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
