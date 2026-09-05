import path from "node:path";
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
import { boundedSandboxCommandTimeoutMs, resolveSupervisorToken } from "@rakazo/core";
import { outgoingCorrelationHeaders } from "@rakazo/logging";
import {
  boundedComputerActions,
  clampRounded,
  computerObservation,
  normalizeWorkspacePath,
} from "./computer-support.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export const MAX_SANDBOX_ERROR_RESPONSE_BYTES = 8 * 1024;
export const SCREEN_RELEASE_TIMEOUT_MS = 8_000;
const SANDBOX_ERROR_RESPONSE_TIMEOUT_MS = 1_000;

async function safeBody(res: Response, signal?: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SANDBOX_ERROR_RESPONSE_BYTES) {
    cancelResponseBody(res);
    return "";
  }
  try {
    const readSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(SANDBOX_ERROR_RESPONSE_TIMEOUT_MS)])
      : AbortSignal.timeout(SANDBOX_ERROR_RESPONSE_TIMEOUT_MS);
    const bytes = await readBodyCapped(res, MAX_SANDBOX_ERROR_RESPONSE_BYTES, readSignal);
    return new TextDecoder().decode(bytes).slice(0, 200);
  } catch {
    return "";
  }
}

function cancelResponseBody(res: Response): void {
  try {
    void Promise.resolve(res.body?.cancel()).catch(() => undefined);
  } catch {
    // Error diagnostics are best-effort and must not delay the operation failure.
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly supervisorToken: string;

  constructor(
    private readonly supervisorUrl: string,
    supervisorToken?: string,
  ) {
    this.supervisorToken = supervisorToken ?? resolveSupervisorToken(process.env);
  }

  describe() {
    return {
      id: "docker",
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

  private url(path: string) {
    return `${this.supervisorUrl.replace(/\/$/, "")}${path}`;
  }

  // No x-rakazo-screen-id here: the supervisor keys a screen off
  // x-rakazo-bot-id alone (the ComputerRef's homeKey — shared across every
  // bot on a Team Computer, distinct per bot on a dedicated one). Keying it
  // off the calling bot's own id instead would give each bot on a shared
  // Team Computer its own Xvfb/Chromium/x11vnc stack — several times the RAM
  // for one container, and each stack fighting the same Chromium profile dir
  // (homeKey is shared too) for its SingletonLock, so only the first bot to
  // grab it gets the real logged-in session and the rest boot to a blank
  // profile. Screen VIEWING is safely shared already (x11vnc -shared serves
  // any number of simultaneous viewers of the one desktop); who gets to
  // actually drive it is gated separately by the execution lease.
  private headers(context: AdapterContext, botId?: string) {
    return {
      authorization: `Bearer ${this.supervisorToken}`,
      "x-rakazo-space-id": context.spaceId,
      ...outgoingCorrelationHeaders(),
      ...(botId ? { "x-rakazo-bot-id": botId } : {}),
      ...(context.screenLeaseId ? { "x-rakazo-screen-lease-id": context.screenLeaseId } : {}),
      ...(context.cancelRunWork ? { "x-rakazo-cancel-run-work": "1" } : {}),
    };
  }

  async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const res = await fetch(this.url("/computers"), {
      method: "POST",
      headers: { ...this.headers(context, request.botId), "content-type": "application/json" },
      body: JSON.stringify({
        botId: request.botId,
        homePath: request.homePath,
        spaceId: context.spaceId,
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox provision failed: ${res.status} ${detail}`.trim());
    }
    const body = (await res.json()) as { id: string; resumed?: boolean };
    return {
      id: body.id,
      botId: request.botId,
      kind: "docker",
      providerRef: body.id,
      fresh: body.resumed !== true,
    };
  }

  async prepare(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const res = await fetch(this.url(`/computers/${computer.id}/exec`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        cwd: dockerCwd(request.cwd),
        timeoutMs: boundedSandboxCommandTimeoutMs(request.timeoutMs),
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      yield { type: "stderr", data: `exec failed: ${res.status}` };
      yield { type: "exit", code: 1 };
      return;
    }
    const body = (await res.json()) as { stdout: string; stderr: string; code: number };
    if (body.stdout) yield { type: "stdout", data: body.stdout };
    if (body.stderr) yield { type: "stderr", data: body.stderr };
    yield { type: "exit", code: body.code };
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const res = await fetch(this.url(`/computers/${computer.id}/screen-mode`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        interactive: request.interactive === true,
        controlToken: request.controlToken,
        revokeControl: false,
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      if (/cannot allocate another screen/i.test(detail)) {
        throw new Error("This Team Computer cannot allocate another screen.");
      }
      return { url: null, mimeType: "text/html", close: async () => undefined };
    }
    const body = (await res.json()) as { screenUrl?: string };
    return {
      url: body.screenUrl ?? this.url(`/computers/${computer.id}/screen`),
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    const res = await fetch(this.url(`/computers/${computer.id}/screen-mode`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({ interactive, controlToken }),
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`sandbox screen mode failed: ${res.status}`);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/input`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({ input, leaseId: lease.leaseId }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox input failed: ${res.status} ${detail}`.trim());
    }
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const res = await fetch(this.url(`/computers/${computer.id}/observe`), {
      method: "POST",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `sandbox observation failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    const body = (await res.json()) as {
      image: string;
      mimeType: "image/png" | "image/jpeg";
      width: number;
      height: number;
      cursor?: { x: number; y: number };
      activeWindow?: { id: string; title?: string };
    };
    return computerObservation(Uint8Array.from(Buffer.from(body.image, "base64")), {
      mimeType: body.mimeType,
      width: body.width,
      height: body.height,
      cursor: body.cursor,
      activeWindow: body.activeWindow,
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const actions = boundedComputerActions(request.actions);
    const res = await fetch(this.url(`/computers/${computer.id}/actions`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        actions,
        observe: request.observe,
        settleMs: clampRounded(request.settleMs ?? 0, 0, 5_000),
      }),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `sandbox action failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    const body = (await res.json()) as {
      completed: number;
      observation?: {
        image: string;
        mimeType: "image/png" | "image/jpeg";
        width: number;
        height: number;
        cursor?: { x: number; y: number };
        activeWindow?: { id: string; title?: string };
      };
    };
    return {
      completed: body.completed,
      ...(body.observation
        ? {
            observation: computerObservation(
              Uint8Array.from(Buffer.from(body.observation.image, "base64")),
              body.observation,
            ),
          }
        : {}),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const path = normalizeWorkspacePath(directory);
    const res = await fetch(
      this.url(`/computers/${computer.id}/files?path=${encodeURIComponent(path)}&mode=list`),
      { headers: this.headers(context, computer.botId), signal: context.signal },
    );
    if (!res.ok) throw new Error(`sandbox file listing failed: ${res.status}`);
    return (await res.json()) as ComputerFileEntry[];
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const path = normalizeWorkspacePath(filePath);
    const maxBytes = options?.maxBytes;
    const res = await fetch(
      this.url(
        `/computers/${computer.id}/files?path=${encodeURIComponent(path)}&mode=read${maxBytes === undefined ? "" : `&maxBytes=${maxBytes}`}`,
      ),
      { headers: this.headers(context, computer.botId), signal: context.signal },
    );
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox file read failed: ${res.status} ${detail}`.trim());
    }
    const body = (await res.json()) as { content: string };
    return Uint8Array.from(Buffer.from(body.content, "base64"));
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const res = await fetch(this.url(`/computers/${computer.id}/files`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        path: normalizeWorkspacePath(file.path),
        content: Buffer.from(file.content).toString("base64"),
        executable: file.executable === true,
      }),
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`sandbox file write failed: ${res.status}`);
  }

  async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    yield* this.walkWorkspace(computer, "", context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `docker-snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (!context.botId) return;
    // Run cancellation must not skip cleanup, but cleanup still needs its own deadline.
    const deadline = requestDeadline(SCREEN_RELEASE_TIMEOUT_MS, "sandbox screen release timed out");
    try {
      const res = await withAbort(
        fetch(this.url(`/computers/${computer.id}/screen`), {
          method: "DELETE",
          headers: this.headers(context, computer.botId),
          signal: deadline.signal,
        }),
        deadline.signal,
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`sandbox screen release failed: ${res.status}`);
      }
    } finally {
      deadline.dispose();
    }
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/stop`), {
      method: "POST",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    // 404 means the supervisor no longer has the container, which is the state we want.
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `sandbox stop failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    }
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}`), {
      method: "DELETE",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `sandbox destroy failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    }
  }

  private async *walkWorkspace(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const entries = await this.listFiles(computer, directory, context);
    for (let index = 0; index < entries.length; ) {
      const entry = entries[index]!;
      if (entry.kind === "dir") {
        yield* this.walkWorkspace(computer, entry.path, context);
        index += 1;
        continue;
      }
      const files = [];
      while (index < entries.length && entries[index]?.kind === "file" && files.length < 8) {
        files.push(entries[index]!);
        index += 1;
      }
      const batch = await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          content: await this.readFile(computer, file.path, context),
          executable: file.executable,
        })),
      );
      for (const file of batch) yield file;
    }
  }
}

function requestDeadline(timeoutMs: number, message: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

function dockerCwd(cwd: string | undefined) {
  if (!cwd || cwd === "." || cwd === "/" || cwd === "/home/rakazo") return "/home/rakazo";
  const relative = cwd.startsWith("/home/rakazo/")
    ? cwd.slice("/home/rakazo/".length)
    : normalizeWorkspacePath(cwd);
  return path.posix.join("/home/rakazo", relative);
}
