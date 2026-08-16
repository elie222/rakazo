import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Daytona,
  type DaytonaConfig,
  DaytonaNotFoundError,
  DaytonaProcessExecutionTimeoutError,
  type Sandbox,
  SandboxState,
} from "@daytona/sdk";
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

const DAYTONA_VNC_PORT = 6080;
const DAYTONA_SCREEN_TTL_SECONDS = 3_600;

export type DaytonaSandboxSdk = Pick<Daytona, "create" | "get">;

export class DaytonaSandboxProvider implements SandboxProvider {
  private readonly client: DaytonaSandboxSdk;
  private readonly boxes = new Map<string, Sandbox>();
  private readonly connections = new Map<string, Promise<Sandbox>>();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly prepared = new Set<string>();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly desktopReady = new Set<string>();
  private readonly desktopStarts = new Map<string, Promise<void>>();
  private readonly screenPreviews = new Map<
    string,
    { url: string; token: string; expiresAt: number }
  >();
  private readonly screenPreviewStarts = new Map<
    string,
    Promise<{ url: string; token: string; expiresAt: number }>
  >();
  private readonly pointerDown = new Map<
    string,
    { x: number; y: number; button: "left" | "right" }
  >();

  constructor(config: DaytonaConfig & { apiKey: string }, client?: DaytonaSandboxSdk) {
    this.client =
      client ??
      new Daytona({
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        target: config.target,
      });
  }

  describe() {
    return {
      id: "daytona",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: true,
        takeover: true,
        persistentHome: true,
      },
    };
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
    if (request.providerRef && request.providerKind === "daytona") {
      try {
        const sandbox = await this.connect(request.providerRef);
        await this.prepareWorkspace(sandbox);
        return this.ref(sandbox, request.botId, false);
      } catch (error) {
        this.forget(request.providerRef);
        if (!isUnrecoverableDaytonaError(error)) throw error;
      }
    }

    const sandbox = await this.client.create(
      {
        labels: { botId: request.botId, rakazo: "computer" },
        envVars: { VNC_RESOLUTION: "1280x800" },
        autoStopInterval: 0,
        autoDeleteInterval: -1,
      },
      { timeout: 120 },
    );
    this.boxes.set(sandbox.id, sandbox);
    try {
      await this.prepareWorkspace(sandbox);
      return this.ref(sandbox, request.botId, true);
    } catch (error) {
      this.forget(sandbox.id);
      try {
        await sandbox.delete(120, true);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Daytona workspace preparation and sandbox cleanup failed",
        );
      }
      throw error;
    }
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (context.signal.aborted) {
      yield { type: "stderr", data: "command aborted\n" };
      yield { type: "exit", code: 130 };
      return;
    }
    const sandbox = await this.box(computer);
    const root = await this.workspaceRoot(sandbox);
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    try {
      const result = await sandbox.process.executeCommand(
        request.argv.map(shellQuote).join(" "),
        daytonaCwd(root, request.cwd),
        request.env,
        Math.max(1, Math.ceil(timeoutMs / 1_000)),
      );
      if (context.signal.aborted) {
        yield { type: "stderr", data: "command aborted\n" };
        yield { type: "exit", code: 130 };
        return;
      }
      if (result.result) yield { type: "stdout", data: result.result };
      yield { type: "exit", code: result.exitCode };
    } catch (error) {
      if (error instanceof DaytonaProcessExecutionTimeoutError) {
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
    const sandbox = await this.box(computer);
    await this.ensureDesktop(sandbox);
    const preview = await this.screenPreview(sandbox);
    const url = new URL(preview.url);
    url.pathname = "/vnc.html";
    url.searchParams.set("autoconnect", "true");
    url.searchParams.set("resize", "scale");
    url.searchParams.set("view_only", request.interactive ? "false" : "true");
    return {
      url: url.toString(),
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  async setScreenControl(
    computer: ComputerRef,
    _interactive: boolean,
    _context: AdapterContext,
  ): Promise<void> {
    await this.ensureDesktop(await this.box(computer));
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    const sandbox = await this.box(computer);
    await this.ensureDesktop(sandbox);
    await this.applyAction(sandbox, input);
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const sandbox = await this.box(computer);
    await this.ensureDesktop(sandbox);
    const [screenshot, display, windows, cursor] = await Promise.all([
      sandbox.computerUse.screenshot.takeFullScreen(true),
      sandbox.computerUse.display.getInfo().catch(() => undefined),
      sandbox.computerUse.display.getWindows().catch(() => undefined),
      sandbox.computerUse.mouse.getPosition().catch(() => undefined),
    ]);
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("computer observation aborted");
    }
    if (!screenshot.screenshot) throw new Error("Daytona screenshot did not contain image data");
    const primary = display?.displays?.find((entry) => entry.isActive) ?? display?.displays?.[0];
    const activeWindow = windows?.windows?.find((entry) => entry.isActive);
    return computerObservation(decodeBase64Image(screenshot.screenshot), {
      mimeType: screenshot.screenshot.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png",
      width: primary?.width ?? 1280,
      height: primary?.height ?? 800,
      ...(cursor?.x !== undefined && cursor.y !== undefined
        ? { cursor: { x: cursor.x, y: cursor.y } }
        : {}),
      ...(activeWindow?.id !== undefined
        ? { activeWindow: { id: String(activeWindow.id), title: activeWindow.title } }
        : {}),
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const sandbox = await this.box(computer);
    await this.ensureDesktop(sandbox);
    const actions = boundedComputerActions(request.actions);
    let completed = 0;
    for (const action of actions) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("computer action aborted");
      }
      await this.applyAction(sandbox, action);
      completed += 1;
    }
    if (request.settleMs) {
      await delay(clampRounded(request.settleMs ?? 0, 0, 5_000));
    }
    return {
      completed,
      ...(request.observe === false ? {} : { observation: await this.observe(computer, context) }),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    _context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const sandbox = await this.box(computer);
    const relative = normalizeWorkspacePath(directory);
    const entries = await sandbox.fs.listFiles(
      workspacePath(await this.workspaceRoot(sandbox), relative),
    );
    return entries
      .map((entry) => ({
        path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
        kind: entry.isDir ? ("dir" as const) : ("file" as const),
        size: entry.size,
        ...(!entry.isDir && isDaytonaExecutable(entry.mode, entry.permissions)
          ? { executable: true }
          : {}),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const sandbox = await this.box(computer);
    const target = workspacePath(await this.workspaceRoot(sandbox), filePath);
    if (options?.maxBytes !== undefined) {
      const info = await sandbox.fs.getFileDetails(target);
      if (info.size > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    const content = await sandbox.fs.downloadFile(target);
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, _context: AdapterContext) {
    const sandbox = await this.box(computer);
    await this.writeFiles(sandbox, [file]);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const sandbox = await this.box(computer);
    await stopDaytonaBrowsers(sandbox);
    try {
      yield* walkDaytonaWorkspace(sandbox, await this.workspaceRoot(sandbox), "", context);
    } finally {
      if (context.operationId !== "stop" && context.operationId !== "computer.sleep") {
        await this.openBrowser(sandbox).catch(() => undefined);
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const sandbox = await this.box(computer);
    await stopDaytonaBrowsers(sandbox);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.writeFiles(sandbox, batch);
      batch = [];
      batchBytes = 0;
    };
    for await (const file of files) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error("import aborted");
      if (
        batch.length >= 8 ||
        batchBytes + file.content.byteLength > PORTABLE_TRANSFER_BATCH_BYTES
      ) {
        await flush();
      }
      batch.push(file);
      batchBytes += file.content.byteLength;
    }
    await flush();
    await configurePortableBrowserProfiles(sandbox, await this.workspaceRoot(sandbox));
    this.prepared.add(sandbox.id);
    await this.openBrowser(sandbox).catch(() => undefined);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    await (await this.box(computer)).refreshActivity();
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const sandbox = await this.findForTeardown(id);
    if (!sandbox) {
      this.forget(id);
      return;
    }
    const preview = this.screenPreviews.get(id);
    this.forget(id);
    await this.revokeScreenPreview(sandbox, preview);
    await sandbox.computerUse.stop().catch(() => undefined);
    await sandbox.stop(120);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const sandbox = await this.findForTeardown(id);
    if (!sandbox) {
      this.forget(id);
      return;
    }
    const preview = this.screenPreviews.get(id);
    this.forget(id);
    await this.revokeScreenPreview(sandbox, preview);
    await sandbox.delete(120, true);
  }

  private ref(sandbox: Sandbox, botId: string, fresh: boolean): ComputerRef {
    return {
      id: sandbox.id,
      botId,
      kind: "daytona",
      providerRef: sandbox.id,
      fresh,
    };
  }

  private async connect(id: string): Promise<Sandbox> {
    const existing = this.boxes.get(id);
    if (existing) return existing;
    const pending = this.connections.get(id);
    if (pending) return pending;
    let connection!: Promise<Sandbox>;
    connection = (async () => {
      const sandbox = await this.client.get(id);
      if (sandbox.state !== SandboxState.STARTED) await sandbox.start(120);
      if (this.connections.get(id) !== connection) {
        throw new Error("Daytona connection was invalidated during teardown");
      }
      this.boxes.set(id, sandbox);
      return sandbox;
    })().finally(() => {
      if (this.connections.get(id) === connection) this.connections.delete(id);
    });
    this.connections.set(id, connection);
    return connection;
  }

  private async box(computer: ComputerRef): Promise<Sandbox> {
    return this.connect(computer.providerRef || computer.id);
  }

  private async findForTeardown(id: string): Promise<Sandbox | undefined> {
    const existing = this.boxes.get(id);
    if (existing) return existing;
    try {
      return await this.client.get(id);
    } catch (error) {
      if (isUnrecoverableDaytonaError(error)) return undefined;
      throw error;
    }
  }

  private async workspaceRoot(sandbox: Sandbox): Promise<string> {
    const cached = this.workspaceRoots.get(sandbox.id);
    if (cached) return cached;
    const home = (await sandbox.getUserHomeDir()) ?? (await sandbox.getWorkDir());
    if (!home) throw new Error("Daytona did not report a sandbox home directory");
    const root = path.posix.join(home, "rakazo-home");
    if (this.boxes.get(sandbox.id) === sandbox) this.workspaceRoots.set(sandbox.id, root);
    return root;
  }

  private async prepareWorkspace(sandbox: Sandbox): Promise<void> {
    if (this.prepared.has(sandbox.id)) return;
    const pending = this.preparations.get(sandbox.id);
    if (pending) return pending;
    let preparation!: Promise<void>;
    preparation = (async () => {
      const root = await this.workspaceRoot(sandbox);
      const result = await sandbox.process.executeCommand(`mkdir -p -- ${shellQuote(root)}`);
      if (result.exitCode !== 0) {
        throw new Error(result.result || "could not create Daytona workspace");
      }
      await configurePortableBrowserProfiles(sandbox, root);
      if (this.preparations.get(sandbox.id) !== preparation) {
        throw new Error("Daytona workspace preparation was invalidated during teardown");
      }
      this.prepared.add(sandbox.id);
    })().finally(() => {
      if (this.preparations.get(sandbox.id) === preparation) {
        this.preparations.delete(sandbox.id);
      }
    });
    this.preparations.set(sandbox.id, preparation);
    return preparation;
  }

  private async ensureDesktop(sandbox: Sandbox): Promise<void> {
    if (this.desktopReady.has(sandbox.id)) return;
    const pending = this.desktopStarts.get(sandbox.id);
    if (pending) return pending;
    let start!: Promise<void>;
    start = sandbox.computerUse
      .start()
      .then(() => {
        if (this.desktopStarts.get(sandbox.id) !== start) {
          throw new Error("Daytona desktop start was invalidated during teardown");
        }
        this.desktopReady.add(sandbox.id);
      })
      .finally(() => {
        if (this.desktopStarts.get(sandbox.id) === start) {
          this.desktopStarts.delete(sandbox.id);
        }
      });
    this.desktopStarts.set(sandbox.id, start);
    return start;
  }

  private async openBrowser(sandbox: Sandbox): Promise<void> {
    await this.ensureDesktop(sandbox);
    await launchDaytonaApplication(sandbox, "browser");
  }

  private async applyAction(sandbox: Sandbox, action: ComputerAction): Promise<void> {
    if (action.kind === "key") {
      await sandbox.computerUse.keyboard.press(action.key, action.modifiers);
      return;
    }
    if (action.kind === "clipboard") {
      await sandbox.computerUse.keyboard.type(action.text);
      return;
    }
    if (action.kind === "pointer") {
      const button = action.button ?? "left";
      if (action.type === "move") await sandbox.computerUse.mouse.move(action.x, action.y);
      else if (action.type === "click") {
        await sandbox.computerUse.mouse.click(action.x, action.y, button);
      } else if (action.type === "down") {
        await sandbox.computerUse.mouse.move(action.x, action.y);
        this.pointerDown.set(sandbox.id, { x: action.x, y: action.y, button });
      } else {
        const start = this.pointerDown.get(sandbox.id);
        this.pointerDown.delete(sandbox.id);
        if (start && (start.x !== action.x || start.y !== action.y)) {
          await sandbox.computerUse.mouse.drag(start.x, start.y, action.x, action.y, start.button);
        } else {
          await sandbox.computerUse.mouse.click(action.x, action.y, start?.button ?? button);
        }
      }
      return;
    }
    if (action.kind === "scroll") {
      const position = await sandbox.computerUse.mouse.getPosition();
      await sandbox.computerUse.mouse.scroll(
        position.x ?? 0,
        position.y ?? 0,
        action.direction,
        clampRounded(action.amount ?? 3, 1, 20),
      );
      return;
    }
    if (action.kind === "wait") {
      await delay(clampRounded(action.ms, 0, 5_000));
      return;
    }
    if (action.kind === "open") {
      const root = await this.workspaceRoot(sandbox);
      const value = /^https?:\/\//i.test(action.path)
        ? action.path
        : workspacePath(root, action.path);
      await launchDaytonaApplication(sandbox, "browser", value);
      return;
    }
    await launchDaytonaApplication(sandbox, action.application, action.uri);
  }

  private async writeFiles(sandbox: Sandbox, files: readonly PortableFile[]): Promise<void> {
    if (!files.length) return;
    const root = await this.workspaceRoot(sandbox);
    const directories = new Set(
      files.map((file) => path.posix.dirname(workspacePath(root, file.path))),
    );
    const mkdir = await sandbox.process.executeCommand(
      `mkdir -p -- ${[...directories].map(shellQuote).join(" ")}`,
    );
    if (mkdir.exitCode !== 0) throw new Error(mkdir.result || "could not create file directories");
    await Promise.all(
      files.map((file) =>
        sandbox.fs.uploadFile(
          Buffer.from(file.content.buffer, file.content.byteOffset, file.content.byteLength),
          workspacePath(root, file.path),
        ),
      ),
    );
    const executable = files
      .filter((file) => file.executable)
      .map((file) => shellQuote(workspacePath(root, file.path)));
    if (executable.length) {
      const chmod = await sandbox.process.executeCommand(`chmod 700 -- ${executable.join(" ")}`);
      if (chmod.exitCode !== 0) throw new Error(chmod.result || "could not mark files executable");
    }
  }

  private async screenPreview(sandbox: Sandbox) {
    const cached = this.screenPreviews.get(sandbox.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
    const pending = this.screenPreviewStarts.get(sandbox.id);
    if (pending) return pending;
    let start!: Promise<{ url: string; token: string; expiresAt: number }>;
    start = sandbox
      .getSignedPreviewUrl(DAYTONA_VNC_PORT, DAYTONA_SCREEN_TTL_SECONDS)
      .then(async (preview) => {
        const cachedPreview = {
          url: preview.url,
          token: preview.token,
          expiresAt: Date.now() + DAYTONA_SCREEN_TTL_SECONDS * 1_000,
        };
        if (this.screenPreviewStarts.get(sandbox.id) !== start) {
          await sandbox
            .expireSignedPreviewUrl(DAYTONA_VNC_PORT, preview.token)
            .catch(() => undefined);
          throw new Error("Daytona screen preview was invalidated during teardown");
        }
        this.screenPreviews.set(sandbox.id, cachedPreview);
        return cachedPreview;
      })
      .finally(() => {
        if (this.screenPreviewStarts.get(sandbox.id) === start) {
          this.screenPreviewStarts.delete(sandbox.id);
        }
      });
    this.screenPreviewStarts.set(sandbox.id, start);
    return start;
  }

  private async revokeScreenPreview(
    sandbox: Sandbox,
    preview = this.screenPreviews.get(sandbox.id),
  ): Promise<void> {
    if (!preview) return;
    await sandbox.expireSignedPreviewUrl(DAYTONA_VNC_PORT, preview.token).catch(() => undefined);
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.connections.delete(id);
    this.workspaceRoots.delete(id);
    this.prepared.delete(id);
    this.preparations.delete(id);
    this.desktopReady.delete(id);
    this.desktopStarts.delete(id);
    this.screenPreviews.delete(id);
    this.screenPreviewStarts.delete(id);
    this.pointerDown.delete(id);
  }
}

export function isUnrecoverableDaytonaError(error: unknown): boolean {
  if (error instanceof DaytonaNotFoundError) return true;
  if (!error || typeof error !== "object") return false;
  const details = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return (
    details.status === 404 ||
    details.statusCode === 404 ||
    details.code === 404 ||
    details.code === "NOT_FOUND"
  );
}

function daytonaCwd(root: string, cwd: string | undefined): string {
  if (
    !cwd ||
    cwd === "." ||
    cwd === "/" ||
    cwd === "/home/rakazo" ||
    cwd === "/home/user" ||
    cwd === "/home/daytona" ||
    cwd === root
  ) {
    return root;
  }
  return workspacePath(root, cwd);
}

function decodeBase64Image(value: string): Uint8Array {
  const content = Buffer.from(value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ""), "base64");
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

function isDaytonaExecutable(mode: string, permissions: string): boolean {
  return /x/.test(permissions) || (Number.parseInt(mode, 8) & 0o100) !== 0;
}

async function configurePortableBrowserProfiles(sandbox: Sandbox, root: string): Promise<boolean> {
  const profileRoot = path.posix.join(root, ".browser-profiles");
  const chrome = path.posix.join(profileRoot, "chromium");
  const firefox = path.posix.join(profileRoot, "firefox");
  const home = (await sandbox.getUserHomeDir()) ?? "/home/daytona";
  const googleChromeLink = path.posix.join(home, ".config/google-chrome");
  const chromiumLink = path.posix.join(home, ".config/chromium");
  const firefoxLink = path.posix.join(home, ".mozilla");
  const configured = await sandbox.process
    .executeCommand(
      [
        `test "$(readlink -f ${shellQuote(googleChromeLink)} 2>/dev/null)" = ${shellQuote(chrome)}`,
        `test "$(readlink -f ${shellQuote(chromiumLink)} 2>/dev/null)" = ${shellQuote(chrome)}`,
        `test "$(readlink -f ${shellQuote(firefoxLink)} 2>/dev/null)" = ${shellQuote(firefox)}`,
      ].join(" && "),
    )
    .then(
      (result) => result.exitCode === 0,
      () => false,
    );
  if (configured) return false;
  await stopDaytonaBrowsers(sandbox);
  const result = await sandbox.process.executeCommand(
    [
      `mkdir -p ${shellQuote(chrome)} ${shellQuote(firefox)} ${shellQuote(path.posix.join(home, ".config"))}`,
      `rm -rf ${shellQuote(googleChromeLink)} ${shellQuote(chromiumLink)} ${shellQuote(firefoxLink)}`,
      `ln -s ${shellQuote(chrome)} ${shellQuote(googleChromeLink)}`,
      `ln -s ${shellQuote(chrome)} ${shellQuote(chromiumLink)}`,
      `ln -s ${shellQuote(firefox)} ${shellQuote(firefoxLink)}`,
    ].join(" && "),
  );
  if (result.exitCode !== 0) {
    throw new Error(result.result || "could not configure portable Daytona browser profiles");
  }
  return true;
}

async function stopDaytonaBrowsers(sandbox: Sandbox): Promise<void> {
  await sandbox.process.executeCommand(PORTABLE_BROWSER_STOP_COMMAND).catch(() => undefined);
}

async function launchDaytonaApplication(
  sandbox: Sandbox,
  application: string,
  uri?: string,
): Promise<void> {
  const app = application === "browser" ? "google-chrome chromium firefox" : application;
  const candidates = app.split(/\s+/).filter(Boolean);
  const command = [
    String.raw`export DISPLAY=\${DISPLAY:-:99}`,
    `for app in ${candidates.map(shellQuote).join(" ")}; do`,
    '  if command -v "$app" >/dev/null 2>&1; then',
    `    nohup "$app"${uri ? ` ${shellQuote(uri)}` : ""} >/tmp/rakazo-app.log 2>&1 &`,
    "    exit 0",
    "  fi",
    "done",
    "exit 1",
  ].join("\n");
  const result = await sandbox.process.executeCommand(command);
  if (result.exitCode !== 0) {
    throw new Error(result.result || `Daytona application ${application} is not installed`);
  }
}

async function* walkDaytonaWorkspace(
  sandbox: Sandbox,
  root: string,
  directory: string,
  context: AdapterContext,
): AsyncIterable<PortableFile> {
  if (context.signal.aborted) throw context.signal.reason ?? new Error("export aborted");
  const entries = await sandbox.fs.listFiles(workspacePath(root, directory));
  const files = entries
    .filter((entry) => !entry.isDir)
    .map((entry) => ({
      entry,
      relative: normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name),
    }))
    .filter(({ relative }) => !shouldSkipPortableWorkspaceFile(relative));
  const directories = entries.filter((entry) => entry.isDir);
  for (const entries of daytonaExportBatches(files)) {
    const batch = await Promise.all(
      entries.map(async ({ entry, relative }) => {
        const content = await sandbox.fs.downloadFile(workspacePath(root, relative));
        return {
          path: relative,
          content: new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
          executable: isDaytonaExecutable(entry.mode, entry.permissions),
        };
      }),
    );
    for (const file of batch) yield file;
  }
  for (const entry of directories) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (!shouldSkipPortableWorkspaceFile(`${relative}/placeholder`)) {
      yield* walkDaytonaWorkspace(sandbox, root, relative, context);
    }
  }
}

function daytonaExportBatches<T extends { entry: { size: number } }>(files: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  for (const file of files) {
    if (
      batch.length > 0 &&
      (batch.length >= 8 || batchBytes + file.entry.size > PORTABLE_TRANSFER_BATCH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(file);
    batchBytes += file.entry.size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
