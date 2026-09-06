import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Box,
  BoxApi,
  type Command200Response,
  type CommandResponse,
  Configuration,
  ResponseError,
} from "@asciidev/box-sdk";
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
import { boundedSandboxCommandTimeoutMs, canReleaseScreenLease } from "@rakazo/core";
import { boxResponseError, wrapBoxCall } from "./box-errors.js";
import { SingleScreenClaimTracker } from "./computer-screens.js";
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

const BOX_API_BASE = "https://ascii.dev/api/box/v1";
const BOX_WORKSPACE = "/home/user/rakazo-home";
const BOX_BROWSER_PROFILES = `${BOX_WORKSPACE}/.browser-profiles`;
const BOX_READY_TIMEOUT_MS = 5 * 60_000;
const BOX_API_COMMAND_TIMEOUT_SECONDS = 600;
const BOX_TTL_SECONDS = 2 * 60 * 60;
const BOX_EXPORT_CONCURRENCY = 16;
const BOX_SCREEN_LEASE_PATH = "/tmp/rakazo-screen-lease";

export type BoxSandboxSdk = Pick<
  BoxApi,
  | "artifactRaw"
  | "command"
  | "commandStatus"
  | "create"
  | "desktop"
  | "get"
  | "resume"
  | "stop"
  | "update"
  | "writeFile"
> & {
  deleteBox(boxId: string): Promise<void>;
};

interface BoxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Decide whether cancel may stop Box browsers across API/worker processes. */
export type BoxRemoteScreenLease =
  | { status: "missing" }
  | { status: "present"; leaseId: string }
  | { status: "error" };

/** Decide whether cancel may stop Box browsers across API/worker processes. */
export function shouldStopBoxBrowsersOnCancel(input: {
  remoteLease: BoxRemoteScreenLease;
  screenLeaseId?: string;
}): boolean {
  // Fail closed on transport/command errors so a stale cancel cannot kill a newer browser.
  if (input.remoteLease.status === "error") return false;
  // No remote fence: treat as orphaned work from this cancel path.
  if (input.remoteLease.status === "missing") return true;
  // A remote fence always wins over any local claim state.
  if (!input.screenLeaseId) return false;
  return canReleaseScreenLease(input.remoteLease.leaseId, input.screenLeaseId);
}

export class BoxSandboxProvider implements SandboxProvider {
  private readonly client: BoxSandboxSdk;
  private readonly pendingProvisions = new Map<string, Promise<ComputerRef>>();
  private readonly prepared = new Set<string>();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly screens = new SingleScreenClaimTracker();

  constructor(
    config: { apiKey: string; apiUrl?: string },
    client: BoxSandboxSdk = createBoxSdk(config),
  ) {
    this.client = client;
  }

  describe() {
    return {
      id: "box",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: false,
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
    const reconnecting = request.providerRef && request.providerKind === "box";
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
    if (request.providerRef && request.providerKind === "box") {
      try {
        const existing = await this.client.get(
          { boxId: request.providerRef },
          { signal: context.signal },
        );
        if (existing.box.state === "archived") {
          await this.client.resume(
            {
              boxId: request.providerRef,
              resumeRequest: { noEnv: true, ttlSeconds: BOX_TTL_SECONDS },
            },
            { signal: context.signal },
          );
        }
        return this.ref(request.providerRef, request.botId, false);
      } catch (error) {
        if (!isUnrecoverableBoxError(error)) throw error;
        this.forget(request.providerRef);
      }
    }

    const created = await this.client.create(
      {
        createBoxRequest: {
          ttlSeconds: BOX_TTL_SECONDS,
          noEnv: true,
          env: {
            RAKAZO_BOT_ID: request.botId,
            RAKAZO_SANDBOX: "computer",
          },
        },
      },
      { signal: context.signal },
    );
    return this.ref(created.box.id, request.botId, true);
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    if (this.prepared.has(id)) return;
    const pending = this.preparations.get(id);
    if (pending) return pending;
    let preparation!: Promise<void>;
    preparation = (async () => {
      await this.ensureRunnable(id, context);
      await this.stopBrowsers(id);
      const result = await this.runCommand(
        id,
        configureBoxWorkspaceCommand(),
        undefined,
        60_000,
        context.signal,
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "could not prepare Box workspace");
      }
      await this.openBrowser(id);
      if (this.preparations.get(id) !== preparation) {
        throw new Error("Box workspace preparation was invalidated during teardown");
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
    const argv = request.argv.length ? request.argv : ["true"];
    const environment = Object.entries(request.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = [...(environment.length ? ["env", ...environment] : []), ...argv]
      .map(shellQuote)
      .join(" ");
    try {
      const result = await this.runCommand(
        this.id(computer),
        command,
        boxCwd(request.cwd),
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
    const id = this.id(computer);
    await this.claimScreen(id, context);
    try {
      const deadline = Date.now() + 60_000;
      while (true) {
        if (context.signal.aborted) {
          throw context.signal.reason ?? new Error("screen connection aborted");
        }
        const desktop = await this.client.desktop(
          {
            boxId: id,
            vnc: 1,
            desktopRequest: { publicAccess: false },
          },
          { signal: context.signal },
        );
        if (!desktop.provisioning && desktop.desktopUrl) {
          const url = new URL(desktop.desktopUrl);
          url.searchParams.set("autoconnect", "true");
          url.searchParams.set("resize", "scale");
          url.searchParams.set("view_only", request.interactive ? "false" : "true");
          return {
            url: url.toString(),
            mimeType: "text/html",
            close: async () => undefined,
          };
        }
        if (Date.now() >= deadline) throw new Error("Box desktop did not become ready");
        await delay(1_000, undefined, { signal: context.signal });
      }
    } catch (error) {
      this.screens.release(id, context);
      throw error;
    }
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    _controlToken?: string,
  ): Promise<void> {
    if (interactive) await this.claimScreen(this.id(computer), context);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const id = this.id(computer);
    await this.claimScreen(id, context);
    await this.applyAction(id, input, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const id = this.id(computer);
    await this.claimScreen(id, context);
    const imagePath = `/tmp/rakazo-observe-${randomUUID()}.png`;
    try {
      const result = await this.runCommand(
        id,
        observeBoxCommand(imagePath),
        undefined,
        60_000,
        context.signal,
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "Box screenshot failed");
      }
      const image = await this.readRemoteFile(id, imagePath, context.signal);
      if (!image.byteLength) throw new Error("Box screenshot did not contain image data");
      return parseBoxObservation(image, result.stdout);
    } finally {
      await this.rawCommand(id, `rm -f -- ${shellQuote(imagePath)}`, 10).catch(() => undefined);
    }
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const id = this.id(computer);
    await this.claimScreen(id, context);
    const actions = boundedComputerActions(request.actions);
    let completed = 0;
    for (const action of actions) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("computer action aborted");
      }
      await this.applyAction(id, action, context);
      completed += 1;
    }
    if (request.settleMs) {
      await delay(clampRounded(request.settleMs, 0, 5_000), undefined, {
        signal: context.signal,
      });
    }
    return {
      completed,
      ...(request.observe === false ? {} : { observation: await this.observe(computer, context) }),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const relative = normalizeWorkspacePath(directory);
    const result = await this.runCommand(
      this.id(computer),
      listBoxFilesCommand(workspacePath(BOX_WORKSPACE, relative)),
      undefined,
      60_000,
      context.signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "could not list Box workspace");
    }
    return parseBoxFileEntries(result.stdout);
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    return this.readRemoteFile(
      this.id(computer),
      workspacePath(BOX_WORKSPACE, filePath),
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
    await this.stopBrowsers(id);
    try {
      const entries = await this.listWorkspaceFiles(id, context);
      for (let index = 0; index < entries.length; index += BOX_EXPORT_CONCURRENCY) {
        const files = await Promise.all(
          entries.slice(index, index + BOX_EXPORT_CONCURRENCY).map(async (entry) => ({
            path: entry.path,
            content: await this.readFile(computer, entry.path, context),
            executable: entry.executable,
          })),
        );
        yield* files;
      }
    } finally {
      if (context.operationId !== "stop" && context.operationId !== "computer.sleep") {
        await this.openBrowser(id).catch(() => undefined);
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const id = this.id(computer);
    await this.stopBrowsers(id);
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
    await this.openBrowser(id).catch(() => undefined);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    await this.client.update({
      boxId: this.id(computer),
      updateBoxRequest: { ttlSeconds: BOX_TTL_SECONDS },
    });
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    this.screens.release(id, context);
    if (!context.cancelRunWork || !context.screenLeaseId) return;
    // Atomically re-check the remote fence under flock before stopping browsers.
    await this.stopBrowsersIfLeaseAllows(id, context.screenLeaseId);
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    try {
      const current = await this.client.get({ boxId: id }, { signal: context.signal });
      if (current.box.state !== "archived" && current.box.state !== "archiving") {
        await this.client.stop({ boxId: id }, { signal: context.signal });
      }
      await this.waitForState(id, new Set(["archived"]), context);
    } catch (error) {
      if (!isUnrecoverableBoxError(error)) throw error;
    } finally {
      this.forget(id);
    }
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    try {
      await this.client.deleteBox(id);
    } catch (error) {
      if (!isUnrecoverableBoxError(error)) throw error;
    } finally {
      this.forget(id);
    }
  }

  private async ensureRunnable(id: string, context: AdapterContext): Promise<Box> {
    const deadline = Date.now() + BOX_READY_TIMEOUT_MS;
    let resumed = false;
    while (true) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("Box preparation aborted");
      }
      const response = await this.client.get({ boxId: id }, { signal: context.signal });
      const box = response.box;
      if (box.state === "ready" || box.state === "idle" || box.state === "running") return box;
      if (box.state === "archived" && !resumed) {
        await this.client.resume(
          { boxId: id, resumeRequest: { noEnv: true, ttlSeconds: BOX_TTL_SECONDS } },
          { signal: context.signal },
        );
        resumed = true;
      } else if (box.state === "error") {
        throw new Error(`Box ${id} entered the error state`);
      }
      if (Date.now() >= deadline) throw new Error(`Box ${id} did not become ready`);
      await delay(1_000, undefined, { signal: context.signal });
    }
  }

  private async waitForState(
    id: string,
    states: Set<Box["state"]>,
    context: AdapterContext,
  ): Promise<Box> {
    const deadline = Date.now() + BOX_READY_TIMEOUT_MS;
    while (true) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error("Box wait aborted");
      const response = await this.client.get({ boxId: id }, { signal: context.signal });
      if (states.has(response.box.state)) return response.box;
      if (response.box.state === "error") throw new Error(`Box ${id} entered the error state`);
      if (Date.now() >= deadline)
        throw new Error(`Box ${id} did not reach ${[...states].join("/")}`);
      await delay(1_000, undefined, { signal: context.signal });
    }
  }

  private async applyAction(
    id: string,
    action: ComputerAction,
    context: AdapterContext,
  ): Promise<void> {
    if (action.kind === "wait") {
      await delay(clampRounded(action.ms, 0, 5_000), undefined, { signal: context.signal });
      return;
    }
    const command = boxActionCommand(action);
    const result = await this.runCommand(id, command, undefined, 60_000, context.signal);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `Box ${action.kind} action failed`);
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
            boxId: id,
            fileWriteRequest: {
              path: workspacePath(BOX_WORKSPACE, file.path),
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
        `${file.executable ? "700" : "600"} ${shellQuote(workspacePath(BOX_WORKSPACE, file.path))}`,
    );
    const result = await this.runCommand(
      id,
      executable.map((entry) => `chmod ${entry}`).join(" && "),
      undefined,
      60_000,
      context.signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "could not set Box file permissions");
    }
  }

  private async listWorkspaceFiles(
    id: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const result = await this.runCommand(
      id,
      listBoxWorkspaceFilesCommand(),
      undefined,
      60_000,
      context.signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "could not enumerate Box workspace");
    }
    return parseBoxFileEntries(result.stdout).filter(
      (entry) => entry.kind === "file" && !shouldSkipPortableWorkspaceFile(entry.path),
    );
  }

  private async claimScreen(id: string, context: AdapterContext): Promise<void> {
    this.screens.claim(id, context);
    if (!context.screenLeaseId) return;
    try {
      await this.writeScreenLease(id, context.screenLeaseId);
    } catch (error) {
      this.screens.release(id, context);
      throw error;
    }
  }

  private async writeScreenLease(id: string, leaseId: string): Promise<void> {
    const lockPath = `${BOX_SCREEN_LEASE_PATH}.lock`;
    const script = [
      "set -eu",
      `lease=${shellQuote(BOX_SCREEN_LEASE_PATH)}`,
      `lock=${shellQuote(lockPath)}`,
      `incoming=${shellQuote(leaseId)}`,
      'exec 9>"$lock"',
      "flock 9",
      'current="$(cat -- "$lease" 2>/dev/null || true)"',
      'current="$(printf "%s" "$current" | tr -d "\\r\\n")"',
      'if [ -n "$current" ] && [ "$current" != "$incoming" ]; then',
      '  current_fence="${current##*:}"',
      '  incoming_fence="${incoming##*:}"',
      "  case \"$current_fence\" in ''|*[!0-9]*) exit 1 ;; esac",
      "  case \"$incoming_fence\" in ''|*[!0-9]*) exit 1 ;; esac",
      '  if [ "$incoming_fence" -le "$current_fence" ]; then exit 2; fi',
      "fi",
      'printf "%s\\n" "$incoming" >"$lease"',
    ].join("\n");
    const result = await this.rawCommand(id, script, 10);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(result.stderr || result.stdout || "could not publish Box screen lease");
    }
  }

  private async stopBrowsersIfLeaseAllows(id: string, screenLeaseId: string): Promise<void> {
    const lockPath = `${BOX_SCREEN_LEASE_PATH}.lock`;
    const script = [
      "set -eu",
      `lease=${shellQuote(BOX_SCREEN_LEASE_PATH)}`,
      `lock=${shellQuote(lockPath)}`,
      `expected=${shellQuote(screenLeaseId)}`,
      'exec 9>"$lock"',
      "flock 9",
      'current="$(cat -- "$lease" 2>/dev/null || true)"',
      'current="$(printf "%s" "$current" | tr -d "\\r\\n")"',
      'if [ -n "$current" ] && [ "$current" != "$expected" ]; then',
      '  current_owner="${current%:*}"',
      '  expected_owner="${expected%:*}"',
      '  current_fence="${current##*:}"',
      '  expected_fence="${expected##*:}"',
      "  case \"$current_fence\" in ''|*[!0-9]*) exit 3 ;; esac",
      "  case \"$expected_fence\" in ''|*[!0-9]*) exit 3 ;; esac",
      '  if [ "$expected_owner" != "$current_owner" ] || [ "$expected_fence" -lt "$current_fence" ]; then',
      "    exit 2",
      "  fi",
      "fi",
      PORTABLE_BROWSER_STOP_COMMAND,
      'rm -f -- "$lease"',
    ].join("\n");
    const result = await this.rawCommand(id, script, 30).catch(() => undefined);
    // exit 2 = newer remote fence; treat as a successful no-op.
    if (!result || result.timedOut) return;
    if (result.exitCode === 0 || result.exitCode === 2) return;
  }

  private async stopBrowsers(id: string): Promise<void> {
    await this.rawCommand(id, PORTABLE_BROWSER_STOP_COMMAND, 30).catch(() => undefined);
  }

  private async openBrowser(id: string): Promise<void> {
    const result = await this.rawCommand(id, launchBoxBrowserCommand(), 30);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "Box browser is not installed");
    }
  }

  private async readRemoteFile(
    id: string,
    filePath: string,
    signal?: AbortSignal,
    maxBytes?: number,
  ): Promise<Uint8Array> {
    // The JSON/base64 file endpoint rejects files over 5 MiB, including browser profiles.
    const { raw: response } = await this.client.artifactRaw(
      { boxId: id, path: filePath },
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
  ): Promise<BoxCommandResult> {
    const marker = `/tmp/rakazo-command-${randomUUID()}.completed-124`;
    const wrapped = timeoutCommand(command, timeoutMs, marker);
    const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
    const detached = timeoutSeconds + 5 > BOX_API_COMMAND_TIMEOUT_SECONDS;
    try {
      const response = await this.client.command(
        {
          boxId: id,
          commandRequest: {
            command: wrapped,
            cwd,
            ...(detached
              ? { detached: true }
              : { timeoutSeconds: Math.min(timeoutSeconds + 5, BOX_API_COMMAND_TIMEOUT_SECONDS) }),
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
  ): Promise<BoxCommandResult> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("command aborted");
      const status = await this.client.commandStatus(
        { boxId: id, processId, tailBytes: 1_000_000 },
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
      boxId: id,
      commandRequest: { command, timeoutSeconds },
    });
    if (!isFinishedCommand(response)) {
      return this.pollCommand(id, response.processId, timeoutSeconds * 1_000 + 5_000);
    }
    return commandResponse(response);
  }

  private ref(id: string, botId: string, fresh: boolean): ComputerRef {
    return { id, botId, kind: "box", providerRef: id, fresh };
  }

  private id(computer: ComputerRef): string {
    return computer.providerRef || computer.id;
  }

  private forget(id: string): void {
    this.pendingProvisions.delete(id);
    this.prepared.delete(id);
    this.preparations.delete(id);
    this.screens.release(id);
  }
}

export function isUnrecoverableBoxError(error: unknown): boolean {
  if (error instanceof ResponseError) return error.response.status === 404;
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return value.status === 404 || value.statusCode === 404 || value.code === 404;
}

function createBoxSdk(config: { apiKey: string; apiUrl?: string }): BoxSandboxSdk {
  const apiUrl = (config.apiUrl ?? BOX_API_BASE).replace(/\/$/, "");
  const api = new BoxApi(
    new Configuration({
      basePath: apiUrl,
      accessToken: config.apiKey,
    }),
  );
  return {
    artifactRaw: wrapBoxCall(api.artifactRaw.bind(api), config.apiKey),
    command: wrapBoxCall(api.command.bind(api), config.apiKey),
    commandStatus: wrapBoxCall(api.commandStatus.bind(api), config.apiKey),
    create: wrapBoxCall(api.create.bind(api), config.apiKey),
    desktop: wrapBoxCall(api.desktop.bind(api), config.apiKey),
    get: wrapBoxCall(api.get.bind(api), config.apiKey),
    resume: wrapBoxCall(api.resume.bind(api), config.apiKey),
    stop: wrapBoxCall(api.stop.bind(api), config.apiKey),
    update: wrapBoxCall(api.update.bind(api), config.apiKey),
    writeFile: wrapBoxCall(api.writeFile.bind(api), config.apiKey),
    deleteBox: async (boxId: string) => {
      const url = `${apiUrl}/boxes/${encodeURIComponent(boxId)}`;
      const headers = { Authorization: `Bearer ${config.apiKey}` };
      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          ...headers,
          "X-Ascii-Confirm-Delete": boxId,
        },
      });
      if (response.status === 404) return;
      if (!response.ok) {
        throw await boxResponseError(response, config.apiKey);
      }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const status = await fetch(url, { headers });
        if (status.status === 404) return;
        if (!status.ok) {
          throw await boxResponseError(status, config.apiKey);
        }
        await delay(500);
      }
      throw new Error(`Box ${boxId} was not deleted within 60 seconds`);
    },
  };
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

function commandResponse(response: CommandResponse): BoxCommandResult {
  return {
    stdout: response.stdout,
    stderr: response.stderr,
    exitCode: response.exitCode ?? 1,
    timedOut: response.timedOut,
  };
}

function boxCwd(cwd: string | undefined): string {
  if (
    !cwd ||
    cwd === "." ||
    cwd === "/" ||
    cwd === "/home/rakazo" ||
    cwd === "/home/user" ||
    cwd === BOX_WORKSPACE
  ) {
    return "rakazo-home";
  }
  const relative = cwd.startsWith(`${BOX_WORKSPACE}/`)
    ? cwd.slice(BOX_WORKSPACE.length + 1)
    : cwd.startsWith("/home/rakazo/")
      ? cwd.slice("/home/rakazo/".length)
      : cwd;
  return path.posix.join("rakazo-home", normalizeWorkspacePath(relative));
}

function configureBoxWorkspaceCommand(): string {
  const chrome = `${BOX_BROWSER_PROFILES}/chromium`;
  const firefox = `${BOX_BROWSER_PROFILES}/firefox`;
  return [
    `mkdir -p ${shellQuote(chrome)} ${shellQuote(firefox)} /home/user/.config`,
    `if [ "$(readlink -f /home/user/.config/google-chrome 2>/dev/null)" != ${shellQuote(chrome)} ] || [ "$(readlink -f /home/user/.config/chromium 2>/dev/null)" != ${shellQuote(chrome)} ] || [ "$(readlink -f /home/user/.mozilla 2>/dev/null)" != ${shellQuote(firefox)} ]; then`,
    "  rm -rf /home/user/.config/google-chrome /home/user/.config/chromium /home/user/.mozilla",
    `  ln -s ${shellQuote(chrome)} /home/user/.config/google-chrome`,
    `  ln -s ${shellQuote(chrome)} /home/user/.config/chromium`,
    `  ln -s ${shellQuote(firefox)} /home/user/.mozilla`,
    "fi",
  ].join("\n");
}

function launchBoxBrowserCommand(): string {
  return [
    "for app in google-chrome-stable google-chrome chromium firefox; do",
    '  if command -v "$app" >/dev/null 2>&1; then',
    '    nohup env DISPLAY=:0 "$app" --no-first-run --no-default-browser-check --start-maximized >/tmp/rakazo-browser.log 2>&1 &',
    "    sleep 1",
    "    DISPLAY=:0 wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz 2>/dev/null || true",
    "    exit 0",
    "  fi",
    "done",
    "exit 1",
  ].join("\n");
}

function observeBoxCommand(imagePath: string): string {
  return [
    `DISPLAY=:0 import -window root ${shellQuote(imagePath)}`,
    `test -s ${shellQuote(imagePath)}`,
    "set -- $(DISPLAY=:0 xdotool getdisplaygeometry 2>/dev/null || printf '1920 1080')",
    'printf \'WIDTH=%s\\nHEIGHT=%s\\n\' "$1" "$2"',
    "DISPLAY=:0 xdotool getmouselocation --shell 2>/dev/null || true",
    "window=$(DISPLAY=:0 xdotool getactivewindow 2>/dev/null || true)",
    "printf 'WINDOW=%s\\n' \"$window\"",
    'if [ -n "$window" ]; then title=$(DISPLAY=:0 xdotool getwindowname "$window" 2>/dev/null | base64 -w0 || true); printf \'TITLE=%s\\n\' "$title"; fi',
  ].join("\n");
}

function parseBoxObservation(image: Uint8Array, metadata: string): ComputerObservation {
  const number = (name: string, fallback: number) =>
    Number(metadata.match(new RegExp(`(?:^|\\n)${name}=(\\d+)`))?.[1]) || fallback;
  const windowId = metadata.match(/(?:^|\n)WINDOW=(\d+)/)?.[1];
  const encodedTitle = metadata.match(/(?:^|\n)TITLE=([^\n]*)/)?.[1];
  const title = encodedTitle ? Buffer.from(encodedTitle, "base64").toString("utf8") : undefined;
  const x = metadata.match(/(?:^|\n)X=(\d+)/)?.[1];
  const y = metadata.match(/(?:^|\n)Y=(\d+)/)?.[1];
  return computerObservation(image, {
    mimeType: "image/png",
    width: number("WIDTH", 1920),
    height: number("HEIGHT", 1080),
    ...(x && y ? { cursor: { x: Number(x), y: Number(y) } } : {}),
    ...(windowId ? { activeWindow: { id: windowId, title } } : {}),
  });
}

function listBoxFilesCommand(directory: string): string {
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

function listBoxWorkspaceFilesCommand(): string {
  return [
    "set -o pipefail",
    `find ${shellQuote(BOX_WORKSPACE)} -type f -print0 | sort -z | while IFS= read -r -d "" entry; do`,
    '  encoded=$(printf %s "$entry" | base64 -w0)',
    '  size=$(stat -c %s "$entry")',
    '  if [ -x "$entry" ]; then executable=1; else executable=0; fi',
    '  printf \'%s\\tfile\\t%s\\t%s\\n\' "$encoded" "$size" "$executable"',
    "done",
  ].join("\n");
}

function parseBoxFileEntries(output: string): ComputerFileEntry[] {
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line): ComputerFileEntry[] => {
      const [encoded, kind, size, executable] = line.split("\t");
      if (!encoded || (kind !== "file" && kind !== "dir")) return [];
      const absolute = Buffer.from(encoded, "base64").toString("utf8");
      if (!absolute.startsWith(`${BOX_WORKSPACE}/`)) return [];
      const child = normalizeWorkspacePath(absolute.slice(BOX_WORKSPACE.length + 1));
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

function boxActionCommand(action: Exclude<ComputerAction, { kind: "wait" }>): string {
  if (action.kind === "scroll") {
    const repeat = clampRounded(action.amount ?? 3, 1, 20);
    return `DISPLAY=:0 xdotool click --repeat ${repeat} ${action.direction === "up" ? "4" : "5"}`;
  }
  if (action.kind === "key") {
    const keys = [...(action.modifiers ?? []), action.key].join("+");
    return `DISPLAY=:0 xdotool key ${shellQuote(keys)}`;
  }
  if (action.kind === "clipboard") {
    return `DISPLAY=:0 xdotool type --delay 1 -- ${shellQuote(action.text)}`;
  }
  if (action.kind === "pointer") {
    const button = action.button === "right" ? "3" : "1";
    if (action.type === "move") return `DISPLAY=:0 xdotool mousemove ${action.x} ${action.y}`;
    if (action.type === "down") {
      return `DISPLAY=:0 xdotool mousemove ${action.x} ${action.y} mousedown ${button}`;
    }
    if (action.type === "up") {
      return `DISPLAY=:0 xdotool mousemove ${action.x} ${action.y} mouseup ${button}`;
    }
    return `DISPLAY=:0 xdotool mousemove ${action.x} ${action.y} click ${button}`;
  }
  if (action.kind === "open") {
    const target = /^https?:\/\//i.test(action.path)
      ? action.path
      : workspacePath(BOX_WORKSPACE, action.path);
    return `nohup env DISPLAY=:0 xdg-open ${shellQuote(target)} >/tmp/rakazo-open.log 2>&1 &`;
  }
  const applications =
    action.application === "browser"
      ? ["google-chrome-stable", "google-chrome", "chromium", "firefox"]
      : [action.application];
  return [
    `for app in ${applications.map(shellQuote).join(" ")}; do`,
    '  if command -v "$app" >/dev/null 2>&1; then',
    `    nohup env DISPLAY=:0 "$app"${action.uri ? ` ${shellQuote(action.uri)}` : ""} >/tmp/rakazo-app.log 2>&1 &`,
    "    exit 0",
    "  fi",
    "done",
    "exit 1",
  ].join("\n");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}
