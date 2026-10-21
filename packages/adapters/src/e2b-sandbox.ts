import type { CommandResult, CommandStartOpts, EntryInfo } from "@e2b/desktop";
import { Sandbox, TimeoutError } from "@e2b/desktop";
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
  TerminalRequest,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { sandboxIdleMs } from "./computer-idle.js";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import {
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import { E2B_COMPUTER_TEMPLATE, E2B_DESKTOP_TEMPLATE } from "./e2b-template.js";
import { LinuxDesktop, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

const E2B_WORKSPACE = "/home/user/rakazo-home";
const E2B_BROWSER_PROFILES = `${E2B_WORKSPACE}/.browser-profiles`;

/** The part of an E2B desktop sandbox handle this adapter uses. */
export interface E2BDesktop {
  readonly sandboxId: string;
  setTimeout(timeoutMs: number): Promise<void>;
  getHost(port: number): string;
  commands: {
    run(
      command: string,
      options: CommandStartOpts & { background?: false },
    ): Promise<CommandResult>;
  };
  files: {
    makeDir(path: string): Promise<boolean>;
    list(path: string, options: { signal?: AbortSignal }): Promise<EntryInfo[]>;
    getInfo(path: string, options: { signal?: AbortSignal }): Promise<EntryInfo>;
    read(path: string, options: { format: "bytes"; signal?: AbortSignal }): Promise<Uint8Array>;
    write(
      files: Array<{ path: string; data: ArrayBuffer }>,
      options: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
}

export interface E2BSandboxSdk {
  create(template: string, options: ReturnType<typeof e2bCreateOptions>): Promise<E2BDesktop>;
  connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<E2BDesktop>;
  pause(id: string, options: { apiKey: string }): Promise<unknown>;
  kill(id: string, options: { apiKey: string }): Promise<boolean>;
}

const e2bSdk: E2BSandboxSdk = {
  create: (template, options) => Sandbox.create(template, options),
  connect: (id, options) => Sandbox.connect(id, options),
  pause: (id, options) => Sandbox.pause(id, options),
  kill: (id, options) => Sandbox.kill(id, options),
};

export function e2bCreateOptions(botId: string, apiKey: string) {
  return {
    apiKey,
    timeoutMs: sandboxIdleMs(),
    metadata: { botId, rakazo: "computer" },
    resolution: [1280, 800] as [number, number],
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
  };
}

// How E2B reports a sandbox that is not running. Sandboxes pause on timeout, so this usually
// means paused rather than deleted; only a failed resume proves the sandbox is gone.
const SANDBOX_NOT_RUNNING =
  /likely due to sandbox timeout|killed or reached its end of life|probably not running anymore/i;

// The SDK's wording for a command that outlived its own timeoutMs (gRPC DeadlineExceeded).
const COMMAND_DEADLINE = /^deadline_exceeded|exceeding 'timeoutMs'/;

function isSandboxNotRunning(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "SandboxNotFoundError" || SANDBOX_NOT_RUNNING.test(error.message))
  );
}

function statusCode(error: unknown): unknown {
  return error instanceof Error ? (error as { statusCode?: unknown }).statusCode : undefined;
}

function isTemplateMissingError(error: unknown): boolean {
  return error instanceof Error && (statusCode(error) === 404 || /^404:/.test(error.message));
}

export class E2BSandboxProvider implements SandboxProvider {
  billsWhileRunning(): boolean {
    return true;
  }

  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: "/home/user",
      workspaceDir: E2B_WORKSPACE,
      browserProfilesDir: E2B_BROWSER_PROFILES,
      displayStart: 20,
      portStart: 6100,
      // The provider port proxy reaches the isolated sandbox through its network interface.
      bindHost: "0.0.0.0",
    }),
    run: async (computer, command, context) => {
      const result = await this.runSetupCommand(computer, command, context.signal);
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    screenUrl: async (computer, port) =>
      `https://${(await this.box(computer)).getHost(port)}/vnc.html`,
  });
  private readonly boxes = new Map<string, E2BDesktop>();
  private readonly connections = new Map<string, Promise<E2BDesktop>>();
  private readonly lastTouchedAt = new Map<string, number>();

  constructor(
    private readonly apiKey: string,
    private readonly sdk: E2BSandboxSdk = e2bSdk,
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
        multiScreen: true,
      },
    };
  }

  private async box(computer: ComputerRef): Promise<E2BDesktop> {
    const id = sandboxId(computer);
    const existing = this.boxes.get(id);
    if (existing) {
      const lastTouched = this.lastTouchedAt.get(id) ?? 0;
      // Fresh enough that the command keepalive's first extension lands before the timeout.
      if (Date.now() - lastTouched < extendEveryMs()) return existing;
      try {
        await existing.setTimeout(sandboxIdleMs());
        this.lastTouchedAt.set(id, Date.now());
        return existing;
      } catch {
        // Paused, killed, mid-pause (409) or past the plan's lifetime: the handle is unusable
        // either way. Reconnecting resumes it, or proves it gone.
        this.drop(id, existing);
      }
    }
    return this.connect(id);
  }

  private connect(id: string): Promise<E2BDesktop> {
    const cached = this.boxes.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = this.connections.get(id);
    if (pending) return pending;
    let connection!: Promise<E2BDesktop>;
    connection = this.sdk
      .connect(id, { apiKey: this.apiKey, timeoutMs: sandboxIdleMs() })
      .catch((error: unknown) => {
        throw isBeingKilled(error) ? sandboxGoneError(id, error) : error;
      })
      .then((connected) => {
        if (this.connections.get(id) !== connection) {
          throw new Error("computer connection stopped during teardown");
        }
        this.boxes.set(connected.sandboxId, connected);
        this.lastTouchedAt.set(connected.sandboxId, Date.now());
        return connected;
      })
      .finally(() => {
        if (this.connections.get(id) === connection) this.connections.delete(id);
      });
    this.connections.set(id, connection);
    return connection;
  }

  /**
   * E2B answers for a paused sandbox the way it does for a deleted one. Resume it so callers
   * keep the sandbox; the resume itself throws if the sandbox is really gone.
   */
  private async recover(
    computer: ComputerRef,
    desktop: E2BDesktop,
    error: unknown,
  ): Promise<unknown> {
    if (!isSandboxNotRunning(error)) return error;
    const id = sandboxId(computer);
    // stop() or destroy() forgot this handle on purpose; resuming it would undo them.
    if (this.boxes.get(id) !== desktop && !this.boxes.has(id) && !this.connections.has(id)) {
      return new Error("computer stopped during the request");
    }
    this.drop(id, desktop);
    await this.connect(id);
    return new Error("computer was not running and has been resumed; try again");
  }

  private async use<T>(
    computer: ComputerRef,
    work: (desktop: E2BDesktop) => Promise<T>,
  ): Promise<T> {
    const desktop = await this.box(computer);
    try {
      return await work(desktop);
    } catch (error) {
      throw await this.recover(computer, desktop, error);
    }
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
        const desktop = await this.box({
          id: request.providerRef,
          providerRef: request.providerRef,
          kind: "e2b",
          botId: request.botId,
        });
        return {
          id: desktop.sandboxId,
          botId: request.botId,
          kind: "e2b",
          providerRef: desktop.sandboxId,
          fresh: false,
        };
      } catch (error) {
        this.boxes.delete(request.providerRef);
        // A transport failure says nothing about the workspace still on the server.
        if (!isSandboxGoneError(error)) throw error;
      }
    }
    const desktop = await this.createDesktop(e2bCreateOptions(request.botId, this.apiKey));
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

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (computer.fresh) await this.use(computer, (desktop) => desktop.files.makeDir(E2B_WORKSPACE));
    const result = await this.runSetupCommand(computer, PREPARE_LINUX_DESKTOP, context.signal);
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "could not prepare computer desktop tools");
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const result = await this.run(computer, sandboxCommandArgv(request).map(shellQuote).join(" "), {
      cwd: e2bCwd(request.cwd),
      envs: request.env,
      signal: context.signal,
      timeoutMs: boundedSandboxCommandTimeoutMs(request.timeoutMs),
    });
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.exitCode };
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.desktops.connectScreen(computer, request, context);
  }
  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    return this.desktops.connectTerminal(computer, request, context);
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
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const relative = normalizeWorkspacePath(directory);
    const entries = await this.use(computer, (desktop) =>
      desktop.files.list(workspacePath(E2B_WORKSPACE, relative), { signal: context.signal }),
    );
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
    const target = workspacePath(E2B_WORKSPACE, filePath);
    return this.use(computer, async (desktop) => {
      if (options?.maxBytes !== undefined) {
        const info = await desktop.files.getInfo(target, { signal: context.signal });
        if (info.size > options.maxBytes) {
          throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
        }
      }
      return desktop.files.read(target, { format: "bytes", signal: context.signal });
    });
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.use(computer, (desktop) => writeE2BFiles(desktop, [file], context));
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const desktop = await this.box(computer);
    await this.desktops.stopBrowsers(computer, context);
    try {
      yield* keepingAwake(desktop, walkE2BWorkspace(desktop, "", context));
    } catch (error) {
      throw await this.recover(computer, desktop, error);
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    await this.desktops.stopBrowsers(computer, context);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const files = batch;
      await this.use(computer, (desktop) => writeE2BFiles(desktop, files, context));
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
    // Imported browser profiles remain dormant until their owning bot needs a desktop.
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    const observation = await this.observe(computer, _context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    // Force box()'s probe: extend the timeout, or reconnect, which resumes the sandbox and
    // throws when it is gone or the key no longer works.
    this.lastTouchedAt.delete(sandboxId(computer));
    await this.box(computer);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = sandboxId(computer);
    this.forget(id);
    // A failed pause leaves the sandbox running and billing, so the caller must know.
    await this.sdk.pause(id, { apiKey: this.apiKey });
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = sandboxId(computer);
    this.forget(id);
    // Killing by id never resumes a paused sandbox; false means it was already gone.
    await this.sdk.kill(id, { apiKey: this.apiKey });
  }

  /** Prefer the right-sized template; an account that has not built it keeps the stock one. */
  private async createDesktop(options: ReturnType<typeof e2bCreateOptions>): Promise<E2BDesktop> {
    try {
      return await this.sdk.create(E2B_COMPUTER_TEMPLATE, options);
    } catch (error) {
      if (!isTemplateMissingError(error)) throw error;
      getLogger().warn("E2B computer template is not built; using the stock desktop template", {
        template: E2B_COMPUTER_TEMPLATE,
      });
      return this.sdk.create(E2B_DESKTOP_TEMPLATE, options);
    }
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.connections.delete(id);
    this.lastTouchedAt.delete(id);
  }

  /** Drop a failed handle unless a reconnect has already replaced it. */
  private drop(id: string, desktop: E2BDesktop): void {
    if (this.boxes.get(id) !== desktop) return;
    this.boxes.delete(id);
    this.lastTouchedAt.delete(id);
  }

  private runSetupCommand(
    computer: ComputerRef,
    command: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    // E2B's outer login shell can fail its logout hook under `set -e`, even after `exit 0`.
    return this.run(computer, `bash -c ${shellQuote(command)}`, {
      ...(signal ? { signal } : {}),
      timeoutMs: boundedSandboxCommandTimeoutMs(undefined),
    });
  }

  /**
   * Run with an explicit timeout (the SDK default is 60s), holding the sandbox awake throughout.
   * A non-zero exit or the command's own deadline is a result, not an error.
   */
  private run(
    computer: ComputerRef,
    command: string,
    options: CommandStartOpts & { background?: false; timeoutMs: number },
  ): Promise<CommandResult> {
    return this.use(computer, async (desktop) => {
      try {
        return await whileAwake(desktop, desktop.commands.run(command, options));
      } catch (error) {
        if (error instanceof TimeoutError && COMMAND_DEADLINE.test(error.message)) {
          const message = `command timed out after ${options.timeoutMs} ms\n`;
          return { exitCode: 124, stdout: "", stderr: message, error: message };
        }
        const result = (error as { result?: CommandResult }).result;
        if (result) return result;
        throw error;
      }
    });
  }
}

async function writeE2BFiles(
  desktop: E2BDesktop,
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

/**
 * Reading a large workspace can outlast the idle window, and E2B pauses the sandbox mid-read
 * when it does. Extend the timeout until the reader finishes.
 */
export async function* keepingAwake<T>(
  desktop: Pick<E2BDesktop, "setTimeout">,
  items: AsyncIterable<T>,
): AsyncIterable<T> {
  await desktop.setTimeout(sandboxIdleMs()).catch(() => undefined);
  const stop = extendPeriodically(desktop);
  try {
    yield* items;
  } finally {
    stop();
  }
}

/** E2B's timeout is an absolute deadline that command activity does not move. */
async function whileAwake<T>(
  desktop: Pick<E2BDesktop, "setTimeout">,
  work: Promise<T>,
): Promise<T> {
  const stop = extendPeriodically(desktop);
  try {
    return await work;
  } finally {
    stop();
  }
}

function extendPeriodically(desktop: Pick<E2BDesktop, "setTimeout">): () => void {
  const idleMs = sandboxIdleMs();
  // A failed extension surfaces through the work itself once E2B pauses the sandbox.
  const timer = setInterval(
    () => void desktop.setTimeout(idleMs).catch(() => undefined),
    extendEveryMs(),
  );
  return () => clearInterval(timer);
}

/** A third of the idle window, so a handle box() returns outlives the first extension. */
function extendEveryMs(): number {
  return Math.min(60_000, sandboxIdleMs() / 3);
}

async function* walkE2BWorkspace(
  desktop: E2BDesktop,
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

function sandboxId(computer: ComputerRef): string {
  return computer.providerRef || computer.id;
}

function isBeingKilled(error: unknown): boolean {
  return error instanceof Error && statusCode(error) === 409 && /kill/i.test(error.message);
}

/** Named so isSandboxGoneError lets callers replace the sandbox. */
function sandboxGoneError(id: string, cause: unknown): Error {
  return Object.assign(new Error(`E2B sandbox ${id} is being deleted`, { cause }), {
    name: "SandboxNotFoundError",
  });
}
