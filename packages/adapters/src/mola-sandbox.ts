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
import {
  normalizeWorkspacePath,
  shellQuote,
  workspacePath,
} from "./computer-support.js";
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
  status: "starting" | "ready" | "stopped" | "unknown";
  runtime_status?: string;
  vcpus: number;
  memory_mb: number;
  disk_gb: number;
  created_at: string;
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
  };
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
    const lower = url.toLowerCase();
    if (lower.includes("cloud.mola.sh")) {
      return "cloud";
    }
    if (lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("0.0.0.0")) {
      return "selfhosted";
    }
    return "cloud";
  }

  private resourcePath(resource: "machines" | "computers"): string {
    return this.apiMode === "cloud" ? "computers" : "machines";
  }

  describe() {
    return {
      id: "mola",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: false,
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
    } = {},
  ): Promise<Response> {
    const url = `${this.apiUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MOLA_API_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal || controller.signal,
      });

      if (response.status === 401) {
        throw new SandboxUnresponsiveError("Mola API key is invalid or expired");
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

      if (!response.ok) {
        const text = await response.text();
        throw new SandboxUnresponsiveError(`Mola API error: ${text || response.statusText}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getMachine(machineId: string): Promise<MolaMachine> {
    const now = Date.now();
    const cached = this.machines.get(machineId);
    const lastCheck = this.checkedAt.get(machineId) ?? 0;

    if (cached && now - lastCheck < MOLA_HANDLE_PROBE_MS) {
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

  private async executeAction(
    machineId: string,
    action: MolaActionRequest,
  ): Promise<MolaActionResponse> {
    const resource = this.resourcePath("computers");
    const response = await this.request(`/${resource}/${machineId}/actions`, {
      method: "POST",
      body: action,
    });
    return await response.json();
  }

  private async getDesktopUrl(
    machineId: string,
  ): Promise<{ url: string; expires_in: number }> {
    if (this.apiMode === "cloud") {
      const response = await this.request(`/computers/${machineId}/viewers`, {
        method: "POST",
        body: {
          origin: "https://rakazo.app",
          mode: "desktop",
          expires_in_minutes: 60,
        },
      });
      const result: { data: { embed_url: string; expires_at?: string } } = await response.json();
      return { url: result.data.embed_url, expires_in: 3600 };
    }
    const response = await this.request(`/machines/${machineId}/desktop`, {
      method: "POST",
    });
    const result: { data: { desktop_url: string; expires_in: number } } = await response.json();
    return { url: result.data.desktop_url, expires_in: result.data.expires_in };
  }

  private async waitForReady(machineId: string, context: AdapterContext): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < MOLA_READY_TIMEOUT_MS) {
      context.signal.throwIfAborted();
      const machine = await this.getMachine(machineId);

      if (machine.status === "ready") {
        return;
      }

      if (machine.status === "stopped") {
        throw new SandboxUnavailableError({ cause: new Error("Machine stopped during startup") });
      }

      await abortableDelay(MOLA_POLL_MS, context.signal);
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
        const machine = await withAbort(this.getMachine(request.providerRef), context.signal);
        if (machine.status === "stopped") {
          await this.request(`/${resource}/${request.providerRef}/start`, { method: "POST" });
          await this.waitForReady(request.providerRef, context);
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
            auto_stop_minutes: 120,
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

    this.machines.set(machine.id, machine);
    this.checkedAt.set(machine.id, Date.now());

    try {
      await this.waitForReady(machine.id, context);
      return this.ref(machine, request.botId, true);
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

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
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
      context.signal.throwIfAborted();
      const machine = await this.getMachine(computer.providerRef);

      if (machine.status !== "ready") {
        throw new Error("Machine must be ready before preparation");
      }

      // Set up the workspace directory
      await this.executeAction(computer.providerRef, {
        action: "exec",
        command: `mkdir -p ${MOLA_WORKSPACE}`,
        timeout: 30,
      });

      this.prepared.add(computer.providerRef);
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

    try {
      const result = await this.executeAction(computer.providerRef, {
        action: "exec",
        command,
        timeout: Math.ceil(timeoutMs / 1000),
      });

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
    const desktop = await this.getDesktopUrl(computer.providerRef);
    return {
      url: desktop.url,
      mimeType: "text/html",
      async close() {
        // Mola desktop URLs are single-use tickets that expire
      },
    };
  }

  async sendInput(): Promise<void> {
    // Mola input via API actions is not integrated - would need complex mapping
    throw new Error("Direct input not implemented for Mola provider");
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    context.signal.throwIfAborted();

    const result = await this.executeAction(computer.providerRef, {
      action: "screenshot",
    });

    if (!result.data?.image_base64) {
      throw new Error("Screenshot failed");
    }

    const image = Buffer.from(result.data.image_base64, "base64");
    const now = new Date().toISOString();

    return {
      frameId: randomUUID(),
      capturedAt: now,
      mimeType: "image/png",
      image,
      width: 1280,
      height: 800,
    };
  }

  async act(
    computer: ComputerRef,
    _request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult> {
    const observation = await this.observe(computer, context);
    return {
      completed: 1,
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

    const result = await this.executeAction(computer.providerRef, {
      action: "exec",
      command: `ls -la ${shellQuote(fullPath)} | tail -n +2`,
      timeout: 30,
    });

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

      const isDir = parts[0]?.startsWith("d");
      entries.push({
        path: path.posix.join(filePath, name),
        kind: isDir ? "dir" : "file",
        size: Number.parseInt(parts[4] ?? "0", 10),
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

    const result = await this.executeAction(computer.providerRef, {
      action: "read_file",
      path: fullPath,
    });

    if (!result.data?.content_base64) {
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

    await this.executeAction(computer.providerRef, {
      action: "write_file",
      path: fullPath,
      content_base64: Buffer.from(
        file.content.buffer,
        file.content.byteOffset,
        file.content.byteLength,
      ).toString("base64"),
    });
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile | StreamedPortableFile> {
    context.signal.throwIfAborted();

    // List all files in workspace
    const result = await this.executeAction(computer.providerRef, {
      action: "exec",
      command: `find ${shellQuote(MOLA_WORKSPACE)} -type f`,
      timeout: 60,
    });

    if (result.data?.exit_code !== 0) {
      return;
    }

    const files = (result.data?.stdout ?? "").split("\n").filter(Boolean);

    for (const filePath of files) {
      if (shouldSkipPortableWorkspaceFile(filePath)) continue;

      try {
        const relativePath = filePath.slice(MOLA_WORKSPACE.length + 1);
        const content = await this.readFile(computer, relativePath, context);

        yield {
          path: relativePath,
          content,
        };
      } catch (error) {
        log.warn("Failed to export file", { error, path: filePath });
      }
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

  async snapshot(computer: ComputerRef, _context: AdapterContext): Promise<{ id: string; createdAt: string }> {
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
    } catch (error) {
      if (!isSandboxGoneError(error)) throw error;
    }
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    context.signal.throwIfAborted();
    const resource = this.resourcePath("computers");

    try {
      await this.request(`/${resource}/${computer.providerRef}`, {
        method: "DELETE",
      });
      this.machines.delete(computer.providerRef);
      this.checkedAt.delete(computer.providerRef);
      this.prepared.delete(computer.providerRef);
      this.preparations.delete(computer.providerRef);
    } catch (error) {
      if (!isSandboxGoneError(error)) throw error;
    }
  }
}

export function createMolaSandboxProvider(config: {
  apiKey: string;
  apiUrl?: string;
}): MolaSandboxProvider {
  return new MolaSandboxProvider(config);
}
