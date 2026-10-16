import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import type { RailwayClientConfig } from "railway";
import {
  Sandbox,
  SandboxFailedError,
  SandboxFileNotFoundError,
  SandboxNotFoundError,
  SandboxTimeoutError,
} from "railway";
import WebSocket from "ws";
import { z } from "zod";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import {
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import { LinuxDesktop, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { readBodyCapped } from "./web-ssrf.js";

const WORKSPACE = "/home/rakazo";
const SCREEN_PORT = 6080;
const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface RailwaySandboxOptions {
  token: string;
  environmentId: string;
  maxWorkspaceFileBytes?: string;
}

export class RailwaySandboxProvider implements SandboxProvider {
  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: WORKSPACE,
      workspaceDir: WORKSPACE,
      browserProfilesDir: `${WORKSPACE}/.browser-profiles`,
      displayStart: 1,
      portStart: SCREEN_PORT,
    }),
    run: async (computer, command, context) => {
      const result = await this.run(computer, command, context);
      return { code: result.timedOut ? 124 : (result.exitCode ?? 1), ...result };
    },
    screenUrl: async (computer, port, context) => {
      const sandbox = await this.connect(computer, context);
      const domain = sandbox.domains.find((entry) => entry.port === port);
      if (!domain) throw new Error("Railway computer has no screen domain");
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.up\.railway\.app$/i.test(domain.domain))
        throw new Error("Invalid Railway screen domain");
      return `https://${domain.domain}/vnc.html`;
    },
  });

  private readonly options: RailwayClientConfig;

  private readonly maxWorkspaceFileBytes: number;

  constructor({ maxWorkspaceFileBytes, ...options }: RailwaySandboxOptions) {
    this.maxWorkspaceFileBytes = z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1)
      .default(64 * 1024 * 1024)
      .parse(maxWorkspaceFileBytes);
    // Node's native WebSocket can recurse when the SDK closes a failed handshake.
    this.options = {
      ...options,
      endpoint: RAILWAY_API,
      tcpProxyWsEndpoint: "wss://ssh.railway.com:2226/ws/exec",
      verbose: false,
      fetch: railwayFetch,
      webSocketImpl: RailwayWebSocket,
    };
  }

  describe() {
    return {
      id: "railway",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: true,
        takeover: true,
        persistentHome: false,
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
    context.signal.throwIfAborted();
    if (request.providerRef && request.providerKind === "railway") {
      try {
        const sandbox = await this.connect(
          this.ref(request.providerRef, request.botId, false),
          context,
        );
        if (sandbox.status === "RUNNING") {
          return this.ref(sandbox.id, request.botId, false);
        }
        if (sandbox.status === "CREATING") throw new Error("Railway computer is still starting");
        await this.destroy(this.ref(sandbox.id, request.botId, false), context);
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
    }
    let sandbox: Sandbox;
    let createdId: string | undefined;
    try {
      sandbox = await Sandbox.create({
        ...this.options,
        fetch: async (input, init) => {
          // Finish the bounded request so cancellation cannot hide a created sandbox's ID.
          const response = await railwayFetch(input, init, (id) => {
            createdId = id;
          });
          context.signal.throwIfAborted();
          return response;
        },
        // Railway public domains require the sandbox to join the private network.
        networkIsolation: "PRIVATE",
        domains: [{ port: SCREEN_PORT }],
      });
      createdId = sandbox.id;
      assertPrivateNetwork(sandbox);
    } catch (error) {
      if (
        error instanceof SandboxFailedError ||
        (error instanceof SandboxTimeoutError && error.resource === "sandbox")
      ) {
        createdId = error.id;
      }
      if (createdId) await this.destroy(this.ref(createdId, request.botId, true), context);
      throw error;
    }
    if (context.signal.aborted) {
      await this.destroy(this.ref(sandbox.id, request.botId, true), context);
      context.signal.throwIfAborted();
    }
    return this.ref(sandbox.id, request.botId, true);
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    try {
      return (await this.connect(computer, context)).status === "RUNNING";
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    }
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.checked(computer, PREPARE_RAILWAY_DESKTOP, context, 300_000);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    try {
      const sandbox = await this.connect(computer, context);
      const result = await sandbox.exec(sandboxCommandArgv(request).map(shellQuote).join(" "), {
        cwd: railwayCwd(request.cwd),
        env: request.env,
        timeoutSec: boundedSandboxCommandTimeoutMs(request.timeoutMs) / 1_000,
        maxOutputBytes: MAX_RESPONSE_BYTES,
        signal: context.signal,
      });
      if (result.truncated)
        throw new Error(`Railway command output exceeds ${MAX_RESPONSE_BYTES} bytes`);
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.timedOut ? 124 : (result.exitCode ?? 1) };
    } catch (error) {
      if (!context.signal.aborted) throw error;
      yield { type: "stderr", data: "command aborted\n" };
      yield { type: "exit", code: 130 };
    }
  }

  async connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
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
  ) {
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return this.desktops.sendInput(computer, input, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    return this.desktops.observe(computer, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    return this.desktops.releaseScreen(computer, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const sandbox = await this.connect(computer, context);
    const relative = normalizeWorkspacePath(directory);
    const entries = await sandbox.files.list(workspacePath(WORKSPACE, relative));
    return entries.map((entry) => ({
      path: normalizeWorkspacePath(path.posix.join(relative, entry.name)),
      kind: entry.isDir ? "dir" : "file",
      size: entry.size,
      ...(!entry.isDir && (entry.mode & 0o111) !== 0 ? { executable: true } : {}),
    }));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const sandbox = await this.connect(computer, context);
    const content = await sandbox.files.read(workspacePath(WORKSPACE, filePath), {
      format: "bytes",
      length: (options?.maxBytes ?? this.maxWorkspaceFileBytes) + 1,
    });
    const maxBytes = options?.maxBytes ?? this.maxWorkspaceFileBytes;
    if (content.byteLength > maxBytes) {
      throw new Error(`computer file exceeds ${maxBytes} bytes`);
    }
    return content;
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const sandbox = await this.connect(computer, context);
    await sandbox.files.write(workspacePath(WORKSPACE, file.path), file.content, {
      mode: file.executable ? 0o700 : 0o600,
    });
  }

  async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    await this.desktops.stopBrowsers(computer, context);
    const result = await this.run(
      computer,
      [
        "set -euo pipefail",
        `cd ${shellQuote(WORKSPACE)}`,
        'find . -type f -print0 | while IFS= read -r -d "" entry; do',
        '  if [ -x "$entry" ]; then mode=700; else mode=600; fi',
        `  printf '%s\\0%s\\0%s\\0' "\${entry#./}" "$mode" "$(wc -c < "$entry")"`,
        "done",
      ].join("\n"),
      context,
    );
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw new Error("could not list Railway workspace");
    const entries = result.stdout.split("\0");
    const sandbox = await this.connect(computer, context);
    const batches: Array<Array<{ path: string; executable: boolean; size: number }>> = [];
    let files: Array<{ path: string; executable: boolean; size: number }> = [];
    let batchBytes = 0;
    for (let index = 0; index + 2 < entries.length; index += 3) {
      const filePath = entries[index];
      const mode = entries[index + 1];
      if (!filePath || !mode || shouldSkipPortableWorkspaceFile(filePath)) continue;
      const size = Number(entries[index + 2]);
      if (!Number.isSafeInteger(size) || size < 0 || size > this.maxWorkspaceFileBytes)
        throw new Error(
          `Railway workspace file exceeds ${this.maxWorkspaceFileBytes} bytes or has an invalid size`,
        );
      if (
        files.length &&
        (files.length >= 4 || batchBytes + size > PORTABLE_TRANSFER_BATCH_BYTES)
      ) {
        batches.push(files);
        files = [];
        batchBytes = 0;
      }
      files.push({
        path: filePath,
        size,
        executable: (Number.parseInt(mode, 8) & 0o111) !== 0,
      });
      batchBytes += size;
    }
    if (files.length) batches.push(files);
    const growing: Array<{ path: string; executable: boolean }> = [];
    for (const files of batches) {
      context.signal.throwIfAborted();
      const batch = await Promise.all(
        files.map(async (file) => {
          try {
            const content = await sandbox.files.read(workspacePath(WORKSPACE, file.path), {
              format: "bytes",
              length: file.size + 1,
            });
            if (content.byteLength > this.maxWorkspaceFileBytes)
              throw new Error(`Railway workspace file exceeds ${this.maxWorkspaceFileBytes} bytes`);
            if (content.byteLength > file.size) {
              growing.push({ path: file.path, executable: file.executable });
              return undefined;
            }
            return { path: file.path, executable: file.executable, content };
          } catch (error) {
            if (error instanceof SandboxFileNotFoundError) return undefined;
            throw error;
          }
        }),
      );
      for (const file of batch) if (file) yield file;
    }
    // Changed files no longer fit their reserved batch; read them one at a time.
    for (const file of growing) {
      context.signal.throwIfAborted();
      try {
        const content = await sandbox.files.read(workspacePath(WORKSPACE, file.path), {
          format: "bytes",
          length: this.maxWorkspaceFileBytes + 1,
        });
        if (content.byteLength > this.maxWorkspaceFileBytes)
          throw new Error(`Railway workspace file exceeds ${this.maxWorkspaceFileBytes} bytes`);
        yield { ...file, content };
      } catch (error) {
        if (!(error instanceof SandboxFileNotFoundError)) throw error;
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    await this.desktops.stopBrowsers(computer, context);
    const sandbox = await this.connect(computer, context);
    // SDK uploads default to 0644; the private parent also protects interrupted restores.
    const privacy = await sandbox.exec(`chmod 700 -- ${shellQuote(WORKSPACE)}`, {
      timeoutSec: 30,
      signal: context.signal,
    });
    if (privacy.exitCode !== 0 || privacy.timedOut)
      throw new Error("could not protect Railway workspace permissions");
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const permissions = new Map<number, string[]>([
      [0o600, []],
      [0o700, []],
    ]);
    const flush = async () => {
      context.signal.throwIfAborted();
      // Passing mode makes the SDK open an exec connection for every file.
      await Promise.all(
        batch.map((file) => sandbox.files.write(workspacePath(WORKSPACE, file.path), file.content)),
      );
      batch = [];
      batchBytes = 0;
    };
    for await (const file of files) {
      context.signal.throwIfAborted();
      if (batch.length >= 4 || batchBytes + file.content.byteLength > PORTABLE_TRANSFER_BATCH_BYTES)
        await flush();
      const target = workspacePath(WORKSPACE, file.path);
      permissions.get(file.executable ? 0o700 : 0o600)?.push(target);
      batch.push(file);
      batchBytes += file.content.byteLength;
    }
    await flush();
    for (const [mode, paths] of permissions) {
      for (let offset = 0; offset < paths.length; offset += 64) {
        const result = await sandbox.exec(
          `chmod ${mode.toString(8)} -- ${paths
            .slice(offset, offset + 64)
            .map(shellQuote)
            .join(" ")}`,
          { timeoutSec: 30, signal: context.signal },
        );
        if (result.exitCode !== 0 || result.timedOut)
          throw new Error("could not restore Railway workspace permissions");
      }
    }
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef) {
    const sandbox = await Sandbox.connect(computer.providerRef, this.options);
    assertPrivateNetwork(sandbox);
    await sandbox.heartbeat();
  }

  async stop(computer: ComputerRef, context: AdapterContext) {
    // Railway has no suspend operation. Core checkpoints the portable home before stopping.
    await this.destroy(computer, context);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext) {
    try {
      // Cleanup must still run when provisioning or preparation was canceled.
      const sandbox = await Sandbox.connect(computer.providerRef, this.options);
      await sandbox.destroy();
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }
  }

  private async connect(computer: ComputerRef, context: AdapterContext) {
    context.signal.throwIfAborted();
    const sandbox = await Sandbox.connect(computer.providerRef, {
      ...this.options,
      fetch: (input, init) =>
        railwayFetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, context.signal]) : context.signal,
        }),
    });
    assertPrivateNetwork(sandbox);
    return sandbox;
  }

  private async run(
    computer: ComputerRef,
    command: string,
    context: AdapterContext,
    timeoutMs = 120_000,
  ) {
    const sandbox = await this.connect(computer, context);
    return sandbox.exec(`bash -c ${shellQuote(command)}`, {
      timeoutSec: timeoutMs / 1_000,
      maxOutputBytes: MAX_RESPONSE_BYTES,
      signal: context.signal,
    });
  }

  private async checked(
    computer: ComputerRef,
    command: string,
    context: AdapterContext,
    timeoutMs: number,
  ) {
    const result = await this.run(computer, command, context, timeoutMs);
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      throw new Error(result.stderr || "could not prepare Railway computer");
    }
  }

  private ref(id: string, botId: string, fresh: boolean): ComputerRef {
    return { id, botId, kind: "railway", providerRef: id, fresh };
  }
}

function assertPrivateNetwork(sandbox: Sandbox) {
  if (sandbox.networkIsolation !== "PRIVATE")
    throw new Error(
      "Railway live screen requires PRIVATE networking; recreate the computer before use",
    );
}

class RailwayWebSocket extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { maxPayload: MAX_RESPONSE_BYTES, handshakeTimeout: 30_000 });
  }
}

async function railwayFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  onCreated?: (id: string) => void,
): Promise<Response> {
  if (String(input) !== RAILWAY_API) throw new Error("Invalid Railway API endpoint");
  const deadline = AbortSignal.timeout(30_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(input, { ...init, signal, redirect: "error" });
  const bytes = await readBodyCapped(response, MAX_RESPONSE_BYTES, signal);
  let body: { data?: { sandboxCreate?: { id?: unknown } }; errors?: unknown[] };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    throw new Error("Invalid Railway API response");
  }
  // GraphQL can return a created resource alongside errors. Preserve its ID before
  // sanitizing the response so a failed create can still clean it up.
  const createdId = body.data?.sandboxCreate?.id;
  if (typeof createdId === "string") onCreated?.(createdId);
  // Never attach upstream error bodies (which may echo credentials) to SDK errors.
  const failed = !response.ok || body.errors?.length || !body.data;
  return new Response(
    failed ? '{"errors":[{"message":"Railway API request failed"}]}' : new Uint8Array(bytes),
    {
      status: response.status,
      headers: { "content-type": "application/json" },
    },
  );
}

function railwayCwd(cwd: string | undefined) {
  if (!cwd || cwd === "." || cwd === "/" || cwd === WORKSPACE) return WORKSPACE;
  return workspacePath(
    WORKSPACE,
    cwd.startsWith(`${WORKSPACE}/`) ? cwd.slice(WORKSPACE.length + 1) : cwd,
  );
}

const PREPARE_RAILWAY_DESKTOP = [
  "set -eu",
  "exec 9>/tmp/rakazo-prepare.lock; flock -w 300 9",
  PREPARE_LINUX_DESKTOP,
  "if ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null; then",
  '  if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi',
  "  package=$(mktemp /tmp/rakazo-chrome-XXXXXX.deb)",
  "  trap 'rm -f \"$package\"' EXIT",
  '  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$package"',
  '  $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$package"',
  "fi",
  `mkdir -p ${WORKSPACE}/.browser-profiles`,
].join("\n");
