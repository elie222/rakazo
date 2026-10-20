import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Sandbox as BoatMachine, Command200Response, CommandResponse } from "@boatdev/sdk";
import { BoatApi, Configuration, ResponseError } from "@boatdev/sdk";
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
import { boatResponseError, wrapBoatCall } from "./boat-errors.js";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import {
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import { LinuxDesktop, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { withAbort } from "./web-ssrf.js";

const BOAT_API_BASE = "https://boat.dev/api/v1";
const BOAT_WORKSPACE = "/home/user/rakazo-home";
const BOAT_BROWSER_PROFILES = `${BOAT_WORKSPACE}/.browser-profiles`;
const BOAT_READY_TIMEOUT_MS = 5 * 60_000;
const BOAT_API_COMMAND_TIMEOUT_SECONDS = 600;
const BOAT_TTL_SECONDS = 2 * 60 * 60;
const BOAT_DELETE_TIMEOUT_MS = 60_000;
const BOAT_GONE_CHECK_TIMEOUT_MS = 10_000;
const BOAT_EXPORT_CONCURRENCY = 16;

export type BoatSandboxSdk = Pick<
  BoatApi,
  | "artifactRaw"
  | "command"
  | "commandStatus"
  | "create"
  | "desktop"
  | "get"
  | "hostPort"
  | "resume"
  | "stop"
  | "update"
  | "writeFile"
> & {
  deleteSandbox(sandboxId: string): Promise<void>;
};

interface BoatCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export class BoatSandboxProvider implements SandboxProvider {
  billsWhileRunning(): boolean {
    return true;
  }

  private readonly client: BoatSandboxSdk;
  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: "/home/user",
      workspaceDir: BOAT_WORKSPACE,
      browserProfilesDir: BOAT_BROWSER_PROFILES,
      displayStart: 20,
      portStart: 6100,
    }),
    run: async (computer, command, context) => {
      const result = await this.runCommand(
        this.id(computer),
        `bash -c ${shellQuote(command)}`,
        undefined,
        120_000,
        context.signal,
      );
      return {
        code: result.timedOut ? 124 : result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    screenUrl: async (computer, port, context) => {
      const hosted = await this.client.hostPort(
        { sandboxId: this.id(computer), hostPortRequest: { port, _public: false } },
        { signal: context.signal },
      );
      if (!hosted.url) throw new Error("Boat did not return a desktop URL");
      const url = new URL(hosted.url);
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".on.boat.dev") ||
        !url.searchParams.get("_token")
      )
        throw new Error("Boat desktop URL is not protected");
      url.pathname = "/vnc.html";
      return url.toString();
    },
  });
  private readonly pendingProvisions = new Map<string, Promise<ComputerRef>>();
  private readonly prepared = new Set<string>();
  private readonly preparations = new Map<string, Promise<void>>();

  constructor(
    config: { apiKey: string; apiUrl?: string },
    client: BoatSandboxSdk = createBoatSdk(config),
  ) {
    this.client = client;
  }

  describe() {
    return {
      id: "boat",
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
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const reconnecting = request.providerRef && request.providerKind === "boat";
    const key = reconnecting ? request.providerRef! : `new:${request.botId}`;
    const pending = this.pendingProvisions.get(key);
    if (pending) return pending;
    let provision!: Promise<ComputerRef>;
    provision = this.provisionOnce(request, context).finally(() => {
      if (this.pendingProvisions.get(key) === provision) this.pendingProvisions.delete(key);
    });
    this.pendingProvisions.set(key, provision);
    return provision;
  }

  private async provisionOnce(
    request: {
      botId: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef && request.providerKind === "boat") {
      try {
        const existing = await this.client.get(
          { sandboxId: request.providerRef },
          { signal: context.signal },
        );
        if (existing.sandbox.state === "archived") {
          await this.client.resume(
            {
              sandboxId: request.providerRef,
              resumeRequest: { noEnv: true, ttlSeconds: BOAT_TTL_SECONDS },
            },
            { signal: context.signal },
          );
        }
        return this.ref(request.providerRef, request.botId, false);
      } catch (error) {
        if (!isUnrecoverableBoatError(error)) throw error;
        this.forget(request.providerRef);
      }
    }

    const created = await this.client.create(
      {
        createSandboxRequest: {
          ttlSeconds: BOAT_TTL_SECONDS,
          noEnv: true,
          env: {
            RAKAZO_BOT_ID: request.botId,
            RAKAZO_SANDBOX: "computer",
          },
        },
      },
      { signal: context.signal },
    );
    return this.ref(created.sandbox.id, request.botId, true);
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    if (this.prepared.has(id)) return;
    const pending = this.preparations.get(id);
    if (pending) return pending;
    let preparation!: Promise<void>;
    preparation = (async () => {
      await this.ensureRunnable(id, context);
      const result = await this.runCommand(
        id,
        configureBoatWorkspaceCommand(),
        undefined,
        60_000,
        context.signal,
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "could not prepare Boat workspace");
      }
      const runtime = await this.runCommand(
        id,
        PREPARE_LINUX_DESKTOP,
        undefined,
        180_000,
        context.signal,
      );
      if (runtime.exitCode !== 0 || runtime.timedOut)
        throw new Error("could not prepare computer desktop tools");
      if (this.preparations.get(id) !== preparation) {
        throw new Error("Boat workspace preparation was invalidated during teardown");
      }
      this.prepared.add(id);
    })().finally(() => {
      if (this.preparations.get(id) === preparation) this.preparations.delete(id);
    });
    this.preparations.set(id, preparation);
    return preparation;
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
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const argv = sandboxCommandArgv({
      ...request,
      argv: request.argv.length ? request.argv : ["true"],
    });
    const environment = Object.entries(request.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = [...(environment.length ? ["env", ...environment] : []), ...argv]
      .map(shellQuote)
      .join(" ");
    try {
      const result = await this.runCommand(
        this.id(computer),
        command,
        boatCwd(request.cwd),
        timeoutMs,
        context.signal,
      );
      if (context.signal.aborted) {
        yield { type: "stderr", data: "command aborted\n" };
        yield { type: "exit", code: 130 };
        return;
      }
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.timedOut) {
        yield { type: "stderr", data: `command timed out after ${timeoutMs} ms\n` };
        yield { type: "exit", code: 124 };
        return;
      }
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.exitCode };
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        yield { type: "stderr", data: "command aborted\n" };
        yield { type: "exit", code: 130 };
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
    const result = await this.runCommand(
      this.id(computer),
      listBoatFilesCommand(workspacePath(BOAT_WORKSPACE, relative)),
      undefined,
      60_000,
      context.signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "could not list Boat workspace");
    }
    return parseBoatFileEntries(result.stdout);
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    return this.readRemoteFile(
      this.id(computer),
      workspacePath(BOAT_WORKSPACE, filePath),
      context.signal,
      options?.maxBytes,
    );
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.writeFiles(this.id(computer), [file], context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const id = this.id(computer);
    await this.desktops.stopBrowsers(computer, context);
    const entries = await this.listWorkspaceFiles(id, context);
    for (let index = 0; index < entries.length; index += BOAT_EXPORT_CONCURRENCY) {
      const files = await Promise.all(
        entries.slice(index, index + BOAT_EXPORT_CONCURRENCY).map(async (entry) => ({
          path: entry.path,
          content: await this.readFile(computer, entry.path, context),
          executable: entry.executable,
        })),
      );
      yield* files;
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const id = this.id(computer);
    await this.desktops.stopBrowsers(computer, context);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.writeFiles(id, batch, context);
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
    await this.client.update({
      sandboxId: this.id(computer),
      updateSandboxRequest: { ttlSeconds: BOAT_TTL_SECONDS },
    });
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    try {
      const current = await this.client.get({ sandboxId: id }, { signal: context.signal });
      if (current.sandbox.state !== "archived" && current.sandbox.state !== "archiving") {
        await this.client.stop({ sandboxId: id }, { signal: context.signal });
      }
      await this.waitForState(id, new Set(["archived"]), context);
    } catch (error) {
      if (!isUnrecoverableBoatError(error)) throw error;
    } finally {
      this.forget(id);
    }
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    try {
      await this.client.deleteSandbox(id);
    } catch (error) {
      if (!isUnrecoverableBoatError(error)) throw error;
    } finally {
      this.forget(id);
    }
  }

  private async ensureRunnable(id: string, context: AdapterContext): Promise<BoatMachine> {
    const deadline = Date.now() + BOAT_READY_TIMEOUT_MS;
    let resumed = false;
    while (true) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("Boat preparation aborted");
      }
      const response = await this.client.get({ sandboxId: id }, { signal: context.signal });
      const sandbox = response.sandbox;
      if (sandbox.state === "ready" || sandbox.state === "idle" || sandbox.state === "running")
        return sandbox;
      if (sandbox.state === "archived" && !resumed) {
        await this.client.resume(
          { sandboxId: id, resumeRequest: { noEnv: true, ttlSeconds: BOAT_TTL_SECONDS } },
          { signal: context.signal },
        );
        resumed = true;
      } else if (sandbox.state === "error") {
        throw new Error(`Boat ${id} entered the error state`);
      }
      if (Date.now() >= deadline) throw new Error(`Boat ${id} did not become ready`);
      await delay(1_000, undefined, { signal: context.signal });
    }
  }

  private async waitForState(
    id: string,
    states: Set<BoatMachine["state"]>,
    context: AdapterContext,
  ): Promise<BoatMachine> {
    const deadline = Date.now() + BOAT_READY_TIMEOUT_MS;
    while (true) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error("Boat wait aborted");
      const response = await this.client.get({ sandboxId: id }, { signal: context.signal });
      if (states.has(response.sandbox.state)) return response.sandbox;
      if (response.sandbox.state === "error") throw new Error(`Boat ${id} entered the error state`);
      if (Date.now() >= deadline)
        throw new Error(`Boat ${id} did not reach ${[...states].join("/")}`);
      await delay(1_000, undefined, { signal: context.signal });
    }
  }

  private async writeFiles(
    id: string,
    files: readonly PortableFile[],
    context: AdapterContext,
  ): Promise<void> {
    if (!files.length) return;
    await Promise.all(
      files.map((file) =>
        this.client.writeFile(
          {
            sandboxId: id,
            fileWriteRequest: {
              path: workspacePath(BOAT_WORKSPACE, file.path),
              content: Buffer.from(file.content).toString("base64"),
              encoding: "base64",
            },
          },
          { signal: context.signal },
        ),
      ),
    );
    const executable = files.map(
      (file) =>
        `${file.executable ? "700" : "600"} ${shellQuote(workspacePath(BOAT_WORKSPACE, file.path))}`,
    );
    const result = await this.runCommand(
      id,
      executable.map((entry) => `chmod ${entry}`).join(" && "),
      undefined,
      60_000,
      context.signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "could not set Boat file permissions");
    }
  }

  private async listWorkspaceFiles(
    id: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const result = await this.runCommand(
      id,
      listBoatWorkspaceFilesCommand(),
      undefined,
      60_000,
      context.signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "could not enumerate Boat workspace");
    }
    return parseBoatFileEntries(result.stdout).filter(
      (entry) => entry.kind === "file" && !shouldSkipPortableWorkspaceFile(entry.path),
    );
  }

  private async readRemoteFile(
    id: string,
    filePath: string,
    signal?: AbortSignal,
    maxBytes?: number,
  ): Promise<Uint8Array> {
    // The JSON/base64 file endpoint rejects files over 5 MiB, including browser profiles.
    const { raw: response } = await this.client.artifactRaw(
      { sandboxId: id, path: filePath },
      signal ? { signal } : undefined,
    );
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (maxBytes !== undefined && Number(response.headers.get("content-length")) > maxBytes) {
        throw new Error(`computer file exceeds ${maxBytes} bytes`);
      }
      if (!reader) return new Uint8Array();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (maxBytes !== undefined && size > maxBytes) {
          throw new Error(`computer file exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
      const content = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return content;
    } catch (error) {
      await reader?.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader?.releaseLock();
    }
  }

  private async runCommand(
    id: string,
    command: string,
    cwd: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BoatCommandResult> {
    const marker = `/tmp/rakazo-command-${randomUUID()}.completed-124`;
    const wrapped = timeoutCommand(command, timeoutMs, marker);
    const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
    const detached = timeoutSeconds + 5 > BOAT_API_COMMAND_TIMEOUT_SECONDS;
    try {
      const response = await this.client.command(
        {
          sandboxId: id,
          commandRequest: {
            command: wrapped,
            cwd,
            ...(detached
              ? { detached: true }
              : { timeoutSeconds: Math.min(timeoutSeconds + 5, BOAT_API_COMMAND_TIMEOUT_SECONDS) }),
          },
        },
        signal ? { signal } : undefined,
      );
      const result = isFinishedCommand(response)
        ? commandResponse(response)
        : await this.pollCommand(id, response.processId, timeoutMs + 10_000, signal);
      if (result.exitCode !== 124 || result.timedOut) return result;
      const completed = await this.rawCommand(id, `test -f ${shellQuote(marker)}`, 10);
      if (completed.exitCode === 0) {
        await this.rawCommand(id, `rm -f -- ${shellQuote(marker)}`, 10).catch(() => undefined);
        return result;
      }
      return { ...result, timedOut: true };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        await this.terminateCommand(id, marker).catch(() => undefined);
      }
      throw error;
    }
  }

  private async pollCommand(
    id: string,
    processId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BoatCommandResult> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("command aborted");
      const status = await this.client.commandStatus(
        { sandboxId: id, processId, tailBytes: 1_000_000 },
        signal ? { signal } : undefined,
      );
      if (!status.running) {
        return {
          stdout: status.stdout,
          stderr: status.stderr,
          exitCode: status.exitCode ?? 1,
          timedOut: false,
        };
      }
      if (Date.now() >= deadline) {
        const pid = status.pid ?? processId;
        await this.rawCommand(
          id,
          `kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null || true`,
          10,
        ).catch(() => undefined);
        return { stdout: status.stdout, stderr: status.stderr, exitCode: 124, timedOut: true };
      }
      await delay(500, undefined, signal ? { signal } : undefined);
    }
  }

  private async terminateCommand(id: string, marker: string): Promise<void> {
    const pattern = marker.replace("rakazo", "[r]akazo");
    await this.rawCommand(
      id,
      `pkill -TERM -f ${shellQuote(pattern)} 2>/dev/null || true; sleep 0.2; pkill -KILL -f ${shellQuote(pattern)} 2>/dev/null || true`,
      10,
    );
  }

  private async rawCommand(id: string, command: string, timeoutSeconds: number) {
    const response = await this.client.command({
      sandboxId: id,
      commandRequest: { command, timeoutSeconds },
    });
    if (!isFinishedCommand(response)) {
      return this.pollCommand(id, response.processId, timeoutSeconds * 1_000 + 5_000);
    }
    return commandResponse(response);
  }

  private ref(id: string, botId: string, fresh: boolean): ComputerRef {
    return { id, botId, kind: "boat", providerRef: id, fresh };
  }

  private id(computer: ComputerRef): string {
    return computer.providerRef || computer.id;
  }

  private forget(id: string): void {
    this.pendingProvisions.delete(id);
    this.prepared.delete(id);
    this.preparations.delete(id);
  }
}

export function isUnrecoverableBoatError(error: unknown): boolean {
  if (error instanceof ResponseError) return error.response.status === 404;
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return value.status === 404 || value.statusCode === 404 || value.code === 404;
}

function createBoatSdk(config: { apiKey: string; apiUrl?: string }): BoatSandboxSdk {
  const apiUrl = (config.apiUrl ?? BOAT_API_BASE).replace(/\/$/, "");
  const api = new BoatApi(
    new Configuration({
      basePath: apiUrl,
      accessToken: config.apiKey,
      // The SDK defaults to its own HTTP/2 client; keep requests on the runtime fetch.
      fetchApi: (input, init) => fetch(input, init),
    }),
  );
  const get = wrapBoatCall(api.get.bind(api), config.apiKey);
  // A 404 can mean a missing file in a live sandbox. Only a missing sandbox counts as gone, and
  // the shared idle and recovery code recognizes it by this message.
  const sandboxCall =
    <Args extends [{ sandboxId: string }, ...unknown[]], Result>(
      call: (...args: Args) => Promise<Result>,
    ) =>
    async (...args: Args): Promise<Result> => {
      try {
        return await call(...args);
      } catch (error) {
        const { sandboxId } = args[0];
        if (
          error instanceof ResponseError &&
          error.response.status === 404 &&
          (await sandboxMissing(get, sandboxId, callerSignal(args[1])))
        ) {
          throw new ResponseError(error.response, `Boat sandbox ${sandboxId} not found`);
        }
        throw error;
      }
    };
  const wrap = <Args extends [{ sandboxId: string }, ...unknown[]], Result>(
    call: (...args: Args) => Promise<Result>,
  ) => sandboxCall(wrapBoatCall(call, config.apiKey));
  return {
    artifactRaw: wrap(api.artifactRaw.bind(api)),
    command: wrap(api.command.bind(api)),
    commandStatus: wrap(api.commandStatus.bind(api)),
    create: wrapBoatCall(api.create.bind(api), config.apiKey),
    desktop: wrap(api.desktop.bind(api)),
    get: sandboxCall(get),
    hostPort: wrap(api.hostPort.bind(api)),
    resume: wrap(api.resume.bind(api)),
    stop: wrap(api.stop.bind(api)),
    update: wrap(api.update.bind(api)),
    writeFile: wrap(api.writeFile.bind(api)),
    deleteSandbox: async (sandboxId: string) => {
      const url = `${apiUrl}/sandboxes/${encodeURIComponent(sandboxId)}`;
      const headers = { Authorization: `Bearer ${config.apiKey}` };
      const signal = AbortSignal.timeout(BOAT_DELETE_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "DELETE",
          headers: {
            ...headers,
            "X-Ascii-Confirm-Delete": sandboxId,
          },
          signal,
        });
        if (response.status === 404) return;
        if (!response.ok) {
          throw await boatResponseError(response, config.apiKey, signal);
        }
        while (!signal.aborted) {
          const status = await fetch(url, { headers, signal });
          if (status.status === 404) return;
          if (!status.ok) {
            throw await boatResponseError(status, config.apiKey, signal);
          }
          await withAbort(delay(500), signal);
        }
      } catch (error) {
        if (!signal.aborted || error !== signal.reason) throw error;
      }
      throw new Error(`Boat ${sandboxId} was not deleted within 60 seconds`);
    },
  };
}

async function sandboxMissing(
  get: (request: { sandboxId: string }, init: RequestInit) => Promise<unknown>,
  sandboxId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const timeout = AbortSignal.timeout(BOAT_GONE_CHECK_TIMEOUT_MS);
  try {
    await get({ sandboxId }, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    return false;
  } catch (error) {
    return error instanceof ResponseError && error.response.status === 404;
  }
}

function callerSignal(init: unknown): AbortSignal | undefined {
  const signal = (init as RequestInit | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function timeoutCommand(command: string, timeoutMs: number, marker: string): string {
  const seconds = Math.max(timeoutMs / 1_000, 0.001);
  const completionScript =
    '"$@"; status=$?; if [ "$status" -eq 124 ]; then : > "$0"; fi; exit "$status"';
  return [
    "timeout",
    "--kill-after=1s",
    `${seconds}s`,
    "sh",
    "-c",
    completionScript,
    marker,
    "bash",
    "-lc",
    command,
  ]
    .map(shellQuote)
    .join(" ");
}

function isFinishedCommand(response: Command200Response): response is CommandResponse {
  return response.type === "command.finished";
}

function commandResponse(response: CommandResponse): BoatCommandResult {
  return {
    stdout: response.stdout,
    stderr: response.stderr,
    exitCode: response.exitCode ?? 1,
    timedOut: response.timedOut,
  };
}

function boatCwd(cwd: string | undefined): string {
  if (
    !cwd ||
    cwd === "." ||
    cwd === "/" ||
    cwd === "/home/rakazo" ||
    cwd === "/home/user" ||
    cwd === BOAT_WORKSPACE
  ) {
    return "rakazo-home";
  }
  const relative = cwd.startsWith(`${BOAT_WORKSPACE}/`)
    ? cwd.slice(BOAT_WORKSPACE.length + 1)
    : cwd.startsWith("/home/rakazo/")
      ? cwd.slice("/home/rakazo/".length)
      : cwd;
  return path.posix.join("rakazo-home", normalizeWorkspacePath(relative));
}

function configureBoatWorkspaceCommand(): string {
  return `mkdir -p ${shellQuote(BOAT_BROWSER_PROFILES)}`;
}

function listBoatFilesCommand(directory: string): string {
  return [
    "set -o pipefail",
    `directory=${shellQuote(directory)}`,
    'test -d "$directory"',
    'find "$directory" -mindepth 1 -maxdepth 1 -print0 | sort -z | while IFS= read -r -d "" entry; do',
    '  if [ -d "$entry" ]; then kind=dir; elif [ -f "$entry" ]; then kind=file; else continue; fi',
    '  encoded=$(printf %s "$entry" | base64 -w0)',
    '  size=$(stat -c %s "$entry")',
    '  if [ "$kind" = file ] && [ -x "$entry" ]; then executable=1; else executable=0; fi',
    '  printf \'%s\\t%s\\t%s\\t%s\\n\' "$encoded" "$kind" "$size" "$executable"',
    "done",
  ].join("\n");
}

function listBoatWorkspaceFilesCommand(): string {
  return [
    "set -o pipefail",
    `find ${shellQuote(BOAT_WORKSPACE)} -type f -print0 | sort -z | while IFS= read -r -d "" entry; do`,
    '  encoded=$(printf %s "$entry" | base64 -w0)',
    '  size=$(stat -c %s "$entry")',
    '  if [ -x "$entry" ]; then executable=1; else executable=0; fi',
    '  printf \'%s\\tfile\\t%s\\t%s\\n\' "$encoded" "$size" "$executable"',
    "done",
  ].join("\n");
}

function parseBoatFileEntries(output: string): ComputerFileEntry[] {
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line): ComputerFileEntry[] => {
      const [encoded, kind, size, executable] = line.split("\t");
      if (!encoded || (kind !== "file" && kind !== "dir")) return [];
      const absolute = Buffer.from(encoded, "base64").toString("utf8");
      if (!absolute.startsWith(`${BOAT_WORKSPACE}/`)) return [];
      const child = normalizeWorkspacePath(absolute.slice(BOAT_WORKSPACE.length + 1));
      return [
        {
          path: child,
          kind,
          size: Number(size) || 0,
          ...(kind === "file" && executable === "1" ? { executable: true } : {}),
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}
