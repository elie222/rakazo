import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerObservation,
  ComputerRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  StreamedPortableFile,
} from "@rakazo/adapter-kit";
import {
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import type { ComputerSize } from "@rakazo/contracts";
import { abortableDelay, boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { normalizeWorkspacePath, shellQuote } from "./computer-support.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { abortedCommandEvents, timedOutCommandEvents } from "./sandbox-command-events.js";
import { isSandboxGoneError, sandboxNotFoundError } from "./sandbox-errors.js";
import { withAbort } from "./web-ssrf.js";
import { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";

const MOLA_API_BASE = "https://cloud.mola.sh/api/v1";
const MOLA_HOME = "/home/dev";
const MOLA_WORKSPACE = `${MOLA_HOME}/rakazo-home`;
const MOLA_READY_TIMEOUT_MS = 5 * 60_000;
const MOLA_POLL_MS = 2_000;
const MOLA_API_TIMEOUT_MS = 30_000;
const MOLA_HANDLE_PROBE_MS = 60_000;

const log = getLogger();

type MolaApiMode = "cloud" | "selfhosted";

interface MolaMachine {
  id: string;
  name: string;
  status:
    | "provisioning"
    | "booting"
    | "starting"
    | "ready"
    | "stopped"
    | "stopping"
    | "deleting"
    | "unknown";
  is_transitional?: boolean;
  runtime_status?: string;
  vcpus: number;
  memory_mb: number;
  disk_gb: number;
  created_at: string;
  ready_at?: string;
  address?: string;
  health?: {
    is_healthy?: boolean;
  };
  error?: {
    code?: string;
    message?: string;
  };
  capabilities?: {
    shell?: boolean;
    display?: boolean;
    sshd?: boolean;
  };
  last_heartbeat_at?: string;
}

interface MolaActionRequest {
  action: string;
  command?: string;
  timeout?: number;
  path?: string;
  content?: string;
  content_base64?: string;
  x?: number;
  y?: number;
  button?: number;
  direction?: string;
  amount?: number;
  text?: string;
  key?: string;
}

interface MolaActionResponse {
  data?: {
    exit_code?: number;
    stdout?: string;
    stderr?: string;
    timed_out?: boolean;
    truncated?: boolean;
    content_base64?: string;
    size?: number;
    mime_type?: string;
    image_base64?: string;
    ok?: boolean;
    path?: string;
    bytes_written?: number;
  };
}

/**
 * Read PNG dimensions from the image header.
 * PNG spec: bytes 16-23 contain width (4 bytes big-endian) and height (4 bytes big-endian).
 */
function readPngDimensions(pngBuffer: Uint8Array): { width: number; height: number } {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A (8 bytes)
  // IHDR chunk starts at byte 8: length (4) + "IHDR" (4) + width (4) + height (4)
  if (pngBuffer.length < 24) {
    throw new Error("Invalid PNG: buffer too short");
  }

  // Check PNG signature
  if (
    pngBuffer[0] !== 0x89 ||
    pngBuffer[1] !== 0x50 ||
    pngBuffer[2] !== 0x4e ||
    pngBuffer[3] !== 0x47
  ) {
    throw new Error("Invalid PNG: bad signature");
  }

  // Width is at bytes 16-19 (big-endian)
  const width =
    ((pngBuffer[16] ?? 0) << 24) |
    ((pngBuffer[17] ?? 0) << 16) |
    ((pngBuffer[18] ?? 0) << 8) |
    (pngBuffer[19] ?? 0);

  // Height is at bytes 20-23 (big-endian)
  const height =
    ((pngBuffer[20] ?? 0) << 24) |
    ((pngBuffer[21] ?? 0) << 16) |
    ((pngBuffer[22] ?? 0) << 8) |
    (pngBuffer[23] ?? 0);

  return { width, height };
}

/**
 * Map Rakazo key name to Mola key format.
 * Mola accepts keys matching /^[a-zA-Z0-9_+\-]{1,80}$/
 */
function mapKeyToMola(key: string, modifiers?: string[]): string {
  // Build the key string with modifiers
  const parts: string[] = [];

  if (modifiers?.includes("control") || modifiers?.includes("ctrl")) {
    parts.push("ctrl");
  }
  if (modifiers?.includes("alt")) {
    parts.push("alt");
  }
  if (modifiers?.includes("shift")) {
    parts.push("shift");
  }
  if (modifiers?.includes("meta") || modifiers?.includes("command")) {
    parts.push("meta");
  }

  parts.push(key.toLowerCase());

  return parts.join("+");
}

export class MolaSandboxProvider implements SandboxProvider {
  billsWhileRunning(_computer: Pick<ComputerRef, "kind">): boolean {
    // Mola can be self-hosted or cloud - default to not billing
    return false;
  }

  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly apiMode: MolaApiMode;
  private readonly machines = new Map<string, MolaMachine>();
  private readonly checkedAt = new Map<string, number>();
  private readonly prepared = new Set<string>();
  private readonly preparations = new Map<string, Promise<void>>();

  constructor(config: { apiKey: string; apiUrl?: string }) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl?.trim() || process.env.MOLA_API_URL?.trim() || MOLA_API_BASE;
    this.apiMode = this.detectApiMode(this.apiUrl);
  }

  private detectApiMode(url: string): MolaApiMode {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      // Only treat cloud.mola.sh and *.mola.sh as cloud
      if (hostname === "cloud.mola.sh" || hostname.endsWith(".mola.sh")) {
        return "cloud";
      }
      return "selfhosted";
    } catch {
      // Fallback for invalid URLs
      return "cloud";
    }
  }

  private resourcePath(_resource: "machines" | "computers"): string {
    return this.apiMode === "cloud" ? "computers" : "machines";
  }

  describe() {
    return {
      id: "mola",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: this.apiMode === "selfhosted",
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      },
    };
  }

  private async request(
    endpoint: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const url = `${this.apiUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? MOLA_API_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const combinedSignal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: combinedSignal,
      });

      if (response.status === 401) {
        throw new SandboxUnresponsiveError("Mola API key is invalid or expired");
      }

      if (response.status === 403) {
        let errorMessage = "Permission denied";
        try {
          const error = await response.json();
          if (error.error?.code === "insufficient_token_ability") {
            const required = error.error?.details?.required;
            errorMessage = `Mola API key lacks required permission: ${required || "computers:read and computers:write"}. Generate a new key with both abilities.`;
          }
        } catch {
          // Fallback if JSON parsing fails
        }
        throw new SandboxUnresponsiveError(errorMessage);
      }

      if (response.status === 429) {
        throw new SandboxRateLimitError();
      }

      if (response.status === 404) {
        throw sandboxNotFoundError("Mola machine not found");
      }

      if (response.status === 409) {
        throw new Error("Machine is not in a state that allows this operation");
      }

      if (response.status === 504) {
        // Cloudflare gateway timeout on Cloud (cuts at ~60s)
        throw new Error(
          "Command execution timed out at the Mola Cloud gateway (~60s limit). For Cloud mode, commands are capped to 50 seconds. Use self-hosted Mola for longer commands.",
        );
      }

      if (!response.ok) {
        const text = await response.text();
        throw new SandboxUnresponsiveError(`Mola API error: ${text || response.statusText}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getMachine(machineId: string, options?: { fresh?: boolean }): Promise<MolaMachine> {
    const now = Date.now();
    const cached = this.machines.get(machineId);
    const lastCheck = this.checkedAt.get(machineId) ?? 0;

    if (!options?.fresh && cached && now - lastCheck < MOLA_HANDLE_PROBE_MS) {
      return cached;
    }

    const resource = this.resourcePath("computers");
    const response = await this.request(`/${resource}/${machineId}`);
    const result: { data: MolaMachine } = await response.json();
    const machine = result.data;

    this.machines.set(machineId, machine);
    this.checkedAt.set(machineId, now);

    return machine;
  }

  private invalidateCache(machineId: string): void {
    this.machines.delete(machineId);
    this.checkedAt.delete(machineId);
    this.prepared.delete(machineId);
    this.preparations.delete(machineId);
  }

  private async executeAction(
    machineId: string,
    action: MolaActionRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<MolaActionResponse> {
    const resource = this.resourcePath("computers");
    const response = await this.request(`/${resource}/${machineId}/actions`, {
      method: "POST",
      body: action,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    return await response.json();
  }

  private async getDesktopUrl(machineId: string): Promise<{ url: string; expires_in: number }> {
    const response = await this.request(`/machines/${machineId}/desktop`, {
      method: "POST",
    });
    const result: { data: { desktop_url: string; expires_in: number } } = await response.json();
    return { url: result.data.desktop_url, expires_in: result.data.expires_in };
  }

  private async waitForReady(machineId: string, context: AdapterContext): Promise<MolaMachine> {
    const start = Date.now();
    while (Date.now() - start < MOLA_READY_TIMEOUT_MS) {
      context.signal.throwIfAborted();
      const machine = await this.getMachine(machineId, { fresh: true });

      if (machine.status === "ready") {
        return machine;
      }

      if (
        machine.is_transitional ||
        machine.status === "provisioning" ||
        machine.status === "booting" ||
        machine.status === "starting" ||
        machine.status === "stopping"
      ) {
        await abortableDelay(MOLA_POLL_MS, context.signal);
        continue;
      }

      if (machine.status === "stopped") {
        throw new SandboxUnavailableError({ cause: new Error("Machine stopped during startup") });
      }

      if (machine.status === "deleting") {
        throw new SandboxUnavailableError({ cause: new Error("Machine is being deleted") });
      }

      throw new SandboxUnavailableError({
        cause: new Error(`Unexpected machine status: ${machine.status}`),
      });
    }

    throw new SandboxUnavailableError({ cause: new Error("Machine did not become ready in time") });
  }

  private ref(machine: MolaMachine, botId: string, fresh?: boolean): ComputerRef {
    return {
      id: machine.id,
      kind: "mola",
      providerRef: machine.id,
      botId,
      ...(fresh !== undefined ? { fresh } : {}),
    };
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
      size?: ComputerSize;
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const resource = this.resourcePath("computers");

    if (request.providerRef && request.providerKind === "mola") {
      try {
        const machine = await withAbort(
          this.getMachine(request.providerRef, { fresh: true }),
          context.signal,
        );
        if (machine.status === "stopped") {
          await this.request(`/${resource}/${request.providerRef}/start`, { method: "POST" });
          this.invalidateCache(request.providerRef);
          const readyMachine = await this.waitForReady(request.providerRef, context);
          return this.ref(readyMachine, request.botId);
        }
        return this.ref(machine, request.botId);
      } catch (error) {
        if (!isSandboxGoneError(error)) throw error;
      }
    }

    const name = `rakazo-${randomUUID()}`;
    const sizeConfig = this.getSizeConfig(request.size);

    const body =
      this.apiMode === "cloud"
        ? {
            name,
            image: "ubuntu",
            auto_stop_minutes: 30,
          }
        : {
            name,
            vcpus: sizeConfig.vcpus,
            memory_mb: sizeConfig.memory_mb,
            disk_gb: sizeConfig.disk_gb,
          };

    const response = await this.request(`/${resource}`, {
      method: "POST",
      body,
    });

    const result: { data: MolaMachine } = await response.json();
    const machine = result.data;

    try {
      const readyMachine = await this.waitForReady(machine.id, context);
      return this.ref(readyMachine, request.botId, true);
    } catch (error) {
      try {
        await this.request(`/${resource}/${machine.id}`, { method: "DELETE" });
      } catch (cleanupError) {
        log.warn("Failed to clean up machine after provision failure", { error: cleanupError });
      }
      throw error;
    }
  }

  private getSizeConfig(size?: ComputerSize): {
    vcpus: number;
    memory_mb: number;
    disk_gb: number;
  } {
    switch (size) {
      case "large":
        return { vcpus: 4, memory_mb: 8192, disk_gb: 60 };
      case "xlarge":
        return { vcpus: 8, memory_mb: 16384, disk_gb: 80 };
      default:
        return { vcpus: 2, memory_mb: 4096, disk_gb: 40 };
    }
  }

  async isRunning(computer: ComputerRef, _context: AdapterContext): Promise<boolean> {
    try {
      const machine = await this.getMachine(computer.providerRef);
      return machine.status === "ready" || machine.runtime_status === "running";
    } catch (error) {
      if (isSandboxGoneError(error)) return false;
      throw error;
    }
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (this.prepared.has(computer.providerRef)) return;

    const existing = this.preparations.get(computer.providerRef);
    if (existing) return existing;

    const preparation = (async () => {
      try {
        context.signal.throwIfAborted();
        const machine = await this.getMachine(computer.providerRef, { fresh: true });

        if (machine.status !== "ready") {
          throw new Error("Machine must be ready before preparation");
        }

        // Set up the workspace directory
        const result = await this.executeAction(
          computer.providerRef,
          {
            action: "exec",
            command: `mkdir -p ${MOLA_WORKSPACE}`,
            timeout: 30,
          },
          { signal: context.signal },
        );

        if (result.data?.exit_code !== 0) {
          throw new Error(
            `Workspace setup failed with exit code ${result.data?.exit_code}: ${result.data?.stderr || "unknown error"}`,
          );
        }

        this.prepared.add(computer.providerRef);
      } finally {
        // Remove from preparations map whether successful or not
        this.preparations.delete(computer.providerRef);
      }
    })();

    this.preparations.set(computer.providerRef, preparation);
    return preparation;
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    context.signal.throwIfAborted();

    const argv = sandboxCommandArgv(request);
    const command = argv.map(shellQuote).join(" ");
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);

    // Cloud has Cloudflare 504 gateway timeout at ~60s, so cap to 50s for safety
    // Self-hosted accepts 1-120s
    const maxExecSeconds = this.apiMode === "cloud" ? 50 : 120;
    const execTimeoutSeconds = Math.max(1, Math.min(maxExecSeconds, Math.ceil(timeoutMs / 1000)));
    // HTTP timeout = exec timeout + 10s margin
    const httpTimeoutMs = (execTimeoutSeconds + 10) * 1000;

    try {
      const result = await this.executeAction(
        computer.providerRef,
        {
          action: "exec",
          command,
          timeout: execTimeoutSeconds,
        },
        {
          signal: context.signal,
          timeoutMs: httpTimeoutMs,
        },
      );

      if (result.data?.timed_out) {
        yield* timedOutCommandEvents(timeoutMs);
        return;
      }

      if (result.data?.stdout) {
        yield { type: "stdout", data: result.data.stdout };
      }

      if (result.data?.stderr) {
        yield { type: "stderr", data: result.data.stderr };
      }

      yield { type: "exit", code: result.data?.exit_code ?? 1 };
    } catch (error) {
      if (context.signal.aborted) {
        yield* abortedCommandEvents();
        return;
      }
      throw error;
    }
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    if (this.apiMode === "cloud") {
      throw new Error(
        "Live view for Mola Cloud is not supported in Rakazo yet. Mola Cloud's iframe-based viewer requires postMessage authentication that is incompatible with Rakazo's HTTP proxy pattern.",
      );
    }

    const desktop = await this.getDesktopUrl(computer.providerRef);
    return {
      url: desktop.url,
      mimeType: "text/html",
      async close() {
        // Mola desktop URLs expire automatically
      },
    };
  }

  async sendInput(): Promise<void> {
    // Mola input via API actions is not integrated - would need complex mapping
    throw new Error("Direct input not implemented for Mola provider");
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    context.signal.throwIfAborted();

    const result = await this.executeAction(
      computer.providerRef,
      {
        action: "screenshot",
      },
      { signal: context.signal },
    );

    if (!result.data?.image_base64) {
      throw new Error("Screenshot failed");
    }

    const image = Buffer.from(result.data.image_base64, "base64");
    const now = new Date().toISOString();

    let width = 1280;
    let height = 800;
    try {
      const dimensions = readPngDimensions(image);
      width = dimensions.width;
      height = dimensions.height;
    } catch (error) {
      log.warn("Failed to read PNG dimensions, using defaults", { error });
    }

    return {
      frameId: randomUUID(),
      capturedAt: now,
      mimeType: "image/png",
      image,
      width,
      height,
    };
  }

  async act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult> {
    context.signal.throwIfAborted();

    let completed = 0;

    for (const action of request.actions) {
      context.signal.throwIfAborted();

      try {
        if (action.kind === "key") {
          // Map key action to Mola key format
          const molaKey = mapKeyToMola(action.key, action.modifiers);
          await this.executeAction(
            computer.providerRef,
            {
              action: "key",
              key: molaKey,
            },
            { signal: context.signal },
          );
          completed++;
        } else if (action.kind === "pointer") {
          if (action.type === "click") {
            // Single click
            const button = action.button === "right" ? 3 : action.button === "left" ? 1 : 1;
            await this.executeAction(
              computer.providerRef,
              {
                action: "click",
                x: Math.round(action.x),
                y: Math.round(action.y),
                button,
              },
              { signal: context.signal },
            );
            completed++;
          } else if (action.type === "move") {
            // Move cursor
            await this.executeAction(
              computer.providerRef,
              {
                action: "move",
                x: Math.round(action.x),
                y: Math.round(action.y),
              },
              { signal: context.signal },
            );
            completed++;
          } else if (action.type === "down" || action.type === "up") {
            // Mouse button down/up not directly supported by Mola
            throw new Error(
              `Unsupported pointer action: ${action.type}. Mola only supports 'click' and 'move'.`,
            );
          }
        } else if (action.kind === "scroll") {
          // Map scroll direction (Mola only supports up/down)
          if (action.direction === "left" || action.direction === "right") {
            throw new Error(
              `Unsupported scroll direction: ${action.direction}. Mola only supports 'up' and 'down'.`,
            );
          }

          // Move to target coordinates if specified
          if (action.x !== undefined && action.y !== undefined) {
            await this.executeAction(
              computer.providerRef,
              {
                action: "move",
                x: Math.round(action.x),
                y: Math.round(action.y),
              },
              { signal: context.signal },
            );
          }

          // Clamp to Mola's 1-20 range with lower bound
          const amount = Math.max(1, Math.min(20, Math.round(action.amount ?? 5)));
          await this.executeAction(
            computer.providerRef,
            {
              action: "scroll",
              direction: action.direction,
              amount,
            },
            { signal: context.signal },
          );
          completed++;
        } else if (action.kind === "clipboard") {
          // Map clipboard to type action (Mola supports text up to 10000 chars)
          const text = action.text.slice(0, 10000);
          await this.executeAction(
            computer.providerRef,
            {
              action: "type",
              text,
            },
            { signal: context.signal },
          );
          completed++;
        } else if (action.kind === "wait") {
          // Wait is local, not sent to Mola
          await delay(action.ms, { signal: context.signal });
          completed++;
        } else if (action.kind === "open" || action.kind === "launch" || action.kind === "focus") {
          // These actions are not directly supported by Mola's API
          throw new Error(
            `Unsupported action: ${action.kind}. Mola does not provide direct ${action.kind} actions.`,
          );
        }
      } catch (error) {
        // If an action fails, stop executing further actions
        log.warn("Action execution failed", { action, error });
        throw error;
      }
    }

    // Apply settle time if requested
    if (request.settleMs && request.settleMs > 0) {
      await delay(request.settleMs, { signal: context.signal });
    }

    // Take observation if requested
    const observation =
      request.observe !== false ? await this.observe(computer, context) : undefined;

    return {
      completed,
      observation,
    };
  }

  async listFiles(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    context.signal.throwIfAborted();

    const normalized = normalizeWorkspacePath(filePath);
    const fullPath = path.posix.join(MOLA_WORKSPACE, normalized);

    const result = await this.executeAction(
      computer.providerRef,
      {
        action: "exec",
        command: `ls -la ${shellQuote(fullPath)} | tail -n +2`,
        timeout: 30,
      },
      { signal: context.signal },
    );

    if (result.data?.exit_code !== 0) {
      return [];
    }

    const lines = (result.data?.stdout ?? "").split("\n").filter(Boolean);
    const entries: ComputerFileEntry[] = [];

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const name = parts.slice(8).join(" ");
      if (name === "." || name === "..") continue;

      const mode = parts[0] ?? "";
      const isDir = mode.startsWith("d");
      const isExecutable = !isDir && mode.includes("x");

      entries.push({
        path: path.posix.join(filePath, name),
        kind: isDir ? "dir" : "file",
        size: Number.parseInt(parts[4] ?? "0", 10),
        executable: isExecutable ? true : undefined,
      });
    }

    return entries;
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
  ): Promise<Uint8Array> {
    context.signal.throwIfAborted();

    const normalized = normalizeWorkspacePath(filePath);
    const fullPath = path.posix.join(MOLA_WORKSPACE, normalized);

    const result = await this.executeAction(
      computer.providerRef,
      {
        action: "read_file",
        path: fullPath,
      },
      { signal: context.signal },
    );

    if (result.data?.content_base64 === undefined) {
      throw new Error("File read failed");
    }

    return Buffer.from(result.data.content_base64, "base64");
  }

  async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    context.signal.throwIfAborted();

    const normalized = normalizeWorkspacePath(file.path);
    const fullPath = path.posix.join(MOLA_WORKSPACE, normalized);

    // Mola Cloud API expects 'content' field (base64-encoded for binary safety)
    // Self-hosted mola-core may accept content_base64, but content works for both
    const contentBase64 = Buffer.from(
      file.content.buffer,
      file.content.byteOffset,
      file.content.byteLength,
    ).toString("base64");

    await this.executeAction(
      computer.providerRef,
      {
        action: "write_file",
        path: fullPath,
        content: contentBase64,
      },
      { signal: context.signal },
    );

    // Apply executable permission if specified
    if (file.executable) {
      await this.executeAction(
        computer.providerRef,
        {
          action: "exec",
          command: `chmod +x ${shellQuote(fullPath)}`,
          timeout: 10,
        },
        { signal: context.signal },
      );
    }
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile | StreamedPortableFile> {
    context.signal.throwIfAborted();

    // List all files in workspace using -print0 for safety with special filenames
    const findResult = await this.executeAction(
      computer.providerRef,
      {
        action: "exec",
        command: `find ${shellQuote(MOLA_WORKSPACE)} -type f -print0`,
        timeout: 60,
      },
      { signal: context.signal },
    );

    if (findResult.data?.exit_code !== 0) {
      throw new Error(
        `Workspace export failed: find command exited with code ${findResult.data?.exit_code}: ${findResult.data?.stderr || "unknown error"}`,
      );
    }

    const files = (findResult.data?.stdout ?? "").split("\0").filter((f) => f.length > 0);

    for (const filePath of files) {
      if (shouldSkipPortableWorkspaceFile(filePath)) continue;

      const relativePath = filePath.slice(MOLA_WORKSPACE.length + 1);

      // Check if file is executable
      const statResult = await this.executeAction(
        computer.providerRef,
        {
          action: "exec",
          command: `stat -c '%a' ${shellQuote(filePath)}`,
          timeout: 10,
        },
        { signal: context.signal },
      );

      const isExecutable =
        statResult.data?.exit_code === 0 &&
        statResult.data.stdout &&
        /[1357]$/.test(statResult.data.stdout.trim());

      const content = await this.readFile(computer, relativePath, context);

      yield {
        path: relativePath,
        content,
        executable: isExecutable ? true : undefined,
      };
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    context.signal.throwIfAborted();

    for await (const file of files) {
      await this.writeFile(computer, file, context);
    }
  }

  async snapshot(
    computer: ComputerRef,
    _context: AdapterContext,
  ): Promise<{ id: string; createdAt: string }> {
    // Mola doesn't support snapshots yet
    return {
      id: computer.providerRef,
      createdAt: new Date().toISOString(),
    };
  }

  async stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { discardUnsaved?: boolean },
  ): Promise<void> {
    context.signal.throwIfAborted();
    const resource = this.resourcePath("computers");

    try {
      await this.request(`/${resource}/${computer.providerRef}/stop`, {
        method: "POST",
        body: { force: options?.discardUnsaved ?? false },
      });
      this.invalidateCache(computer.providerRef);
    } catch (error) {
      if (isSandboxGoneError(error)) {
        this.invalidateCache(computer.providerRef);
      } else {
        throw error;
      }
    }
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    context.signal.throwIfAborted();
    const resource = this.resourcePath("computers");

    try {
      await this.request(`/${resource}/${computer.providerRef}`, {
        method: "DELETE",
      });
      this.invalidateCache(computer.providerRef);
    } catch (error) {
      if (isSandboxGoneError(error)) {
        this.invalidateCache(computer.providerRef);
      } else {
        throw error;
      }
    }
  }
}

export function createMolaSandboxProvider(config: {
  apiKey: string;
  apiUrl?: string;
}): MolaSandboxProvider {
  return new MolaSandboxProvider(config);
}
