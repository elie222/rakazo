import path from "node:path";
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
import { screenSessionKey } from "./computer-screens.js";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import {
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import { LinuxDesktop, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";

const DAYTONA_SCREEN_TTL_SECONDS = 3_600;

export type DaytonaSandboxSdk = Pick<Daytona, "create" | "get">;

export class DaytonaSandboxProvider implements SandboxProvider {
  private readonly client: DaytonaSandboxSdk;
  private readonly boxes = new Map<string, Sandbox>();
  private readonly connections = new Map<string, Promise<Sandbox>>();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly prepared = new Set<string>();
  private readonly desktops = new LinuxDesktop({
    environment: async (computer) => {
      const sandbox = await this.box(computer);
      return {
        homeDir: (await sandbox.getUserHomeDir()) ?? "/home/daytona",
        workspaceDir: await this.workspaceRoot(sandbox),
        browserProfilesDir: path.posix.join(await this.workspaceRoot(sandbox), ".browser-profiles"),
        displayStart: 20,
        portStart: 6100,
      };
    },
    run: async (computer, command, context) => {
      context.signal.throwIfAborted();
      const result = await (await this.box(computer)).process.executeCommand(
        `bash -c ${shellQuote(command)}`,
        undefined,
        undefined,
        boundedSandboxCommandTimeoutMs(undefined) / 1000,
      );
      return { code: result.exitCode, stdout: result.result, stderr: result.result };
    },
    screenUrl: async (computer, port, context) => {
      const preview = await this.screenPreview(
        await this.box(computer),
        screenSessionKey(context),
        port,
      );
      const url = new URL(preview.url);
      url.pathname = "/vnc.html";
      return url.toString();
    },
  });
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly screenPreviews = new Map<
    string,
    { url: string; token: string; expiresAt: number; viewPort: number }
  >();
  private readonly screenPreviewStarts = new Map<
    string,
    Promise<{ url: string; token: string; expiresAt: number; viewPort: number }>
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
    return this.desktops.connectScreen(computer, request, context);
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }
  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.desktops.sendInput(computer, input, context);
  }
  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    return this.desktops.observe(computer, context);
  }
  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
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
    await this.desktops.stopBrowsers(computer, context);
    yield* walkDaytonaWorkspace(sandbox, await this.workspaceRoot(sandbox), "", context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const sandbox = await this.box(computer);
    await this.desktops.stopBrowsers(computer, context);
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
    // Browser profiles are imported without opening a shared browser.
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    await (await this.box(computer)).refreshActivity();
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
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
    try {
      await sandbox.delete(120, true);
    } catch (error) {
      // Deletion is idempotent even when the sandbox disappears after lookup.
      if (!isUnrecoverableDaytonaError(error)) throw error;
    }
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
      const runtime = await sandbox.process.executeCommand(
        `bash -c ${shellQuote(PREPARE_LINUX_DESKTOP)}`,
        undefined,
        undefined,
        300,
      );
      if (runtime.exitCode !== 0) throw new Error("could not prepare computer desktop tools");
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
    const previewKey = `${sandbox.id}:${screenKey}:${viewPort}`;
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

  private forget(id: string): void {
    this.boxes.delete(id);
    this.connections.delete(id);
    this.workspaceRoots.delete(id);
    this.prepared.delete(id);
    this.preparations.delete(id);
    for (const key of [...this.screenPreviews.keys()]) {
      if (key.startsWith(`${id}:`)) this.screenPreviews.delete(key);
    }
    for (const key of [...this.screenPreviewStarts.keys()]) {
      if (key.startsWith(`${id}:`)) this.screenPreviewStarts.delete(key);
    }
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

function isDaytonaExecutable(mode: string, permissions: string): boolean {
  return /x/.test(permissions) || (Number.parseInt(mode, 8) & 0o100) !== 0;
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
