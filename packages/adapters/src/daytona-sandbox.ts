import { randomBytes } from "node:crypto";
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
import { ComputerScreenUnavailableError, screenSessionKey } from "./computer-screens.js";
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
import {
  allocateExtraDisplayCommand,
  ensureExtraDisplayCommand,
  extraDisplayActionCommand,
  extraDisplayControlStartCommand,
  extraDisplayControlStopCommand,
  extraDisplayInputCommand,
  extraDisplayLayout,
  observeExtraDisplayCommand,
  parseAllocatedExtraDisplay,
  parseExtraDisplayObservation,
  parseExtraDisplayViewPassword,
  parseReleasedExtraDisplay,
  releaseExtraDisplayCommand,
  screenControlKey,
} from "./extra-displays.js";

const DAYTONA_PRIMARY_DISPLAY = ":99";
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
    { url: string; token: string; expiresAt: number; viewPort: number }
  >();
  private readonly screenPreviewStarts = new Map<
    string,
    Promise<{ url: string; token: string; expiresAt: number; viewPort: number }>
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
        multiScreen: true,
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
    return this.ref(sandbox, request.botId, true);
  }

  async prepare(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.prepareWorkspace(await this.box(computer));
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
        yield {
          type: "stderr",
          data: `command timed out after ${timeoutMs} ms\n`,
        };
        yield { type: "exit", code: 124 };
        return;
      }
      throw error;
    }
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const sandbox = await this.box(computer);
    const screenKey = screenSessionKey(context);
    const layout = await this.resolveLayout(sandbox, screenKey, context.screenLeaseId);
    if (layout.isPrimary) {
      await this.ensureDesktop(sandbox);
      const preview = await this.screenPreview(sandbox, screenKey, layout.viewPort);
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
    const viewPassword = await this.ensureExtraDisplay(sandbox, layout);
    if (request.interactive) {
      if (!request.controlToken) throw new Error("interactive screen requires a control token");
      const password = randomBytes(6).toString("base64url");
      const result = await sandbox.process.executeCommand(
        extraDisplayControlStartCommand(layout, request.controlToken, password),
      );
      if (result.exitCode !== 0) throw new Error(result.result || "control stream failed to start");
      const preview = await this.screenPreview(sandbox, screenKey, layout.controlPort);
      const url = new URL(preview.url);
      url.pathname = "/vnc.html";
      url.searchParams.set("autoconnect", "true");
      url.searchParams.set("resize", "scale");
      url.searchParams.set("password", password);
      return {
        url: url.toString(),
        mimeType: "text/html",
        close: async () => undefined,
      };
    }
    const preview = await this.screenPreview(sandbox, screenKey, layout.viewPort);
    const url = new URL(preview.url);
    url.pathname = "/vnc.html";
    url.searchParams.set("autoconnect", "true");
    url.searchParams.set("resize", "scale");
    url.searchParams.set("view_only", "true");
    url.searchParams.set("password", viewPassword);
    return {
      url: url.toString(),
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    const sandbox = await this.box(computer);
    const screenKey = screenSessionKey(context);
    const layout = await this.resolveLayout(sandbox, screenKey, context.screenLeaseId);
    if (layout.isPrimary) {
      await this.ensureDesktop(sandbox);
      return;
    }
    await this.ensureExtraDisplay(sandbox, layout);
    if (interactive) {
      if (!controlToken) throw new Error("interactive screen requires a control token");
      const password = randomBytes(6).toString("base64url");
      const result = await sandbox.process.executeCommand(
        extraDisplayControlStartCommand(layout, controlToken, password),
      );
      if (result.exitCode !== 0) throw new Error(result.result || "control stream failed to start");
    } else if (controlToken) {
      await sandbox.process.executeCommand(extraDisplayControlStopCommand(layout, controlToken));
    }
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const sandbox = await this.box(computer);
    const layout = await this.resolveLayout(
      sandbox,
      screenSessionKey(context),
      context.screenLeaseId,
    );
    if (layout.isPrimary) {
      await this.ensureDesktop(sandbox);
      await this.applyAction(sandbox, input);
      return;
    }
    await this.ensureExtraDisplay(sandbox, layout);
    const result = await sandbox.process.executeCommand(extraDisplayInputCommand(layout, input));
    if (result.exitCode !== 0) throw new Error(result.result || "extra display input failed");
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const sandbox = await this.box(computer);
    const layout = await this.resolveLayout(
      sandbox,
      screenSessionKey(context),
      context.screenLeaseId,
    );
    if (layout.isPrimary) {
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
          ? {
              activeWindow: {
                id: String(activeWindow.id),
                title: activeWindow.title,
              },
            }
          : {}),
      });
    }
    await this.ensureExtraDisplay(sandbox, layout);
    const result = await sandbox.process.executeCommand(observeExtraDisplayCommand(layout));
    if (result.exitCode !== 0) throw new Error(result.result || "extra display observation failed");
    const parsed = parseExtraDisplayObservation(result.result ?? "");
    return computerObservation(parsed.image, {
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: parsed.cursor,
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const sandbox = await this.box(computer);
    const layout = await this.resolveLayout(
      sandbox,
      screenSessionKey(context),
      context.screenLeaseId,
    );
    const actions = boundedComputerActions(request.actions);
    let completed = 0;
    if (layout.isPrimary) await this.ensureDesktop(sandbox);
    else await this.ensureExtraDisplay(sandbox, layout);
    for (const action of actions) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("computer action aborted");
      }
      if (layout.isPrimary) await this.applyAction(sandbox, action);
      else {
        const result = await sandbox.process.executeCommand(
          extraDisplayActionCommand(layout, action),
        );
        if (result.exitCode !== 0) throw new Error(result.result || "extra display action failed");
      }
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
    await this.openBrowser(sandbox).catch(() => undefined);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    await (await this.box(computer)).refreshActivity();
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const screenKey = screenSessionKey(context);
    const sandbox = this.boxes.get(id) ?? (await this.box(computer).catch(() => undefined));
    if (!sandbox) return;
    const released = await sandbox.process
      .executeCommand(releaseExtraDisplayCommand(screenKey, context.screenLeaseId))
      .catch(() => undefined);
    const index = released ? parseReleasedExtraDisplay(released.result) : undefined;
    if (index === undefined) return;
    const previewPrefix = `${screenControlKey(id, screenKey)}:`;
    const previews = [];
    for (const key of [...this.screenPreviews.keys()]) {
      if (!key.startsWith(previewPrefix)) continue;
      const preview = this.screenPreviews.get(key);
      this.screenPreviews.delete(key);
      this.screenPreviewStarts.delete(key);
      previews.push(preview);
    }
    await Promise.all(previews.map((preview) => this.revokeScreenPreview(sandbox, preview)));
    if (index === 0) return;
    // Non-primary teardown runs inside the registry lock before the slot is reusable.
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const sandbox = await this.findForTeardown(id);
    if (!sandbox) {
      this.forget(id);
      return;
    }
    const previewKeys = [...this.screenPreviews.keys()].filter((key) => key.startsWith(`${id}:`));
    await Promise.all(
      previewKeys.map((previewKey) =>
        this.revokeScreenPreview(sandbox, this.screenPreviews.get(previewKey)),
      ),
    );
    this.forget(id);
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
    const previewKeys = [...this.screenPreviews.keys()].filter((key) => key.startsWith(`${id}:`));
    await Promise.all(
      previewKeys.map((previewKey) =>
        this.revokeScreenPreview(sandbox, this.screenPreviews.get(previewKey)),
      ),
    );
    this.forget(id);
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

  private async screenPreview(sandbox: Sandbox, screenKey: string, viewPort: number) {
    const previewKey = `${screenControlKey(sandbox.id, screenKey)}:${viewPort}`;
    const cached = this.screenPreviews.get(previewKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
    const pending = this.screenPreviewStarts.get(previewKey);
    if (pending) return pending;
    let start!: Promise<{
      url: string;
      token: string;
      expiresAt: number;
      viewPort: number;
    }>;
    start = sandbox
      .getSignedPreviewUrl(viewPort, DAYTONA_SCREEN_TTL_SECONDS)
      .then(async (preview) => {
        const cachedPreview = {
          url: preview.url,
          token: preview.token,
          expiresAt: Date.now() + DAYTONA_SCREEN_TTL_SECONDS * 1_000,
          viewPort,
        };
        if (this.screenPreviewStarts.get(previewKey) !== start) {
          await sandbox.expireSignedPreviewUrl(viewPort, preview.token).catch(() => undefined);
          throw new Error("Daytona screen preview was invalidated during teardown");
        }
        this.screenPreviews.set(previewKey, cachedPreview);
        return cachedPreview;
      })
      .finally(() => {
        if (this.screenPreviewStarts.get(previewKey) === start) {
          this.screenPreviewStarts.delete(previewKey);
        }
      });
    this.screenPreviewStarts.set(previewKey, start);
    return start;
  }

  private async revokeScreenPreview(
    sandbox: Sandbox,
    preview: { url: string; token: string; expiresAt: number; viewPort: number } | undefined,
  ): Promise<void> {
    if (!preview) return;
    await sandbox.expireSignedPreviewUrl(preview.viewPort, preview.token).catch(() => undefined);
  }

  private async resolveLayout(sandbox: Sandbox, screenKey: string, leaseId?: string) {
    const allocation = await sandbox.process.executeCommand(
      allocateExtraDisplayCommand(screenKey, leaseId),
    );
    if (allocation.exitCode !== 0) throw new ComputerScreenUnavailableError();
    const index = parseAllocatedExtraDisplay(allocation.result);
    return extraDisplayLayout(index, DAYTONA_PRIMARY_DISPLAY);
  }

  private async ensureExtraDisplay(
    sandbox: Sandbox,
    layout: ReturnType<typeof extraDisplayLayout>,
  ): Promise<string> {
    if (layout.isPrimary) throw new Error("primary display does not use an extra view password");
    const root = await this.workspaceRoot(sandbox);
    const result = await sandbox.process.executeCommand(
      ensureExtraDisplayCommand(
        layout,
        {
          homeDir: (await sandbox.getUserHomeDir()) ?? "/home/daytona",
          browserProfilesDir: path.posix.join(root, ".browser-profiles"),
        },
        randomBytes(9).toString("base64url"),
      ),
    );
    if (result.exitCode !== 0) throw new ComputerScreenUnavailableError();
    return parseExtraDisplayViewPassword(result.result ?? "");
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.connections.delete(id);
    this.workspaceRoots.delete(id);
    this.prepared.delete(id);
    this.preparations.delete(id);
    this.desktopReady.delete(id);
    this.desktopStarts.delete(id);
    for (const key of [...this.screenPreviews.keys()]) {
      if (key.startsWith(`${id}:`)) this.screenPreviews.delete(key);
    }
    for (const key of [...this.screenPreviewStarts.keys()]) {
      if (key.startsWith(`${id}:`)) this.screenPreviewStarts.delete(key);
    }
    this.pointerDown.delete(id);
  }
}

export function isUnrecoverableDaytonaError(error: unknown): boolean {
  if (error instanceof DaytonaNotFoundError) return true;
  if (!error || typeof error !== "object") return false;
  const details = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
  };
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
