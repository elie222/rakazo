import { setTimeout as delay } from "node:timers/promises";
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
import { stopBrowserProfileCommand } from "@rakazo/core/node/desktop-runtime";
import { sandboxIdleMs } from "./computer-idle.js";
import { screenSessionKey } from "./computer-screens.js";
import {
  boundedComputerActions,
  clampRounded,
  computerObservation,
  normalizeWorkspacePath,
  shellQuote,
  workspacePath,
} from "./computer-support.js";
import {
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import { readBodyCapped } from "./web-ssrf.js";

const CREATEOS_WORKSPACE = "/home/desktop/rakazo-home";
const CREATEOS_CHROMIUM_PROFILE = `${CREATEOS_WORKSPACE}/.browser-profiles/chromium`;
const CREATEOS_FIREFOX_PROFILE = `${CREATEOS_WORKSPACE}/.browser-profiles/firefox`;
const CREATEOS_CHROMIUM_PID = "/tmp/rakazo/createos-chromium.pid";
const CREATEOS_DRAINING_SCREEN = "draining:";
const CREATEOS_SCREEN_MAP_PATH = `${CREATEOS_WORKSPACE}/.rakazo/screens.json`;
export const CREATEOS_SCREEN_MAP_SENTINEL = "RAKAZO_SCREEN_MAP_V1";
const CREATEOS_SCREEN_MAP_NEED_CREATE = "NEED_CREATE";
const DEFAULT_CREATEOS_BASE_URL = "https://api.sb.createos.sh";
const CREATEOS_INGRESS_ZONE = "sb.createos.sh";
const DEFAULT_CREATEOS_SHAPE = "s-2vcpu-2gb";
const DEFAULT_CREATEOS_ROOTFS = "desktop:1";
export const MAX_CREATEOS_ERROR_RESPONSE_BYTES = 8 * 1024;
export const MAX_CREATEOS_SUCCESS_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 2_000;
const CREATEOS_ERROR_RESPONSE_TIMEOUT_MS = 1_000;
const CREATEOS_SUCCESS_RESPONSE_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BROWSER_PROFILE_DIR = ".browser-profiles";
const BROWSER_PROFILE_CACHE_DIRS = new Set([
  "Cache",
  "Code Cache",
  "CacheStorage",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Crashpad",
  "component_crx_cache",
  "startup_cache",
  "cache2",
]);
const TRANSITIONAL_CREATEOS_STATUSES = new Set(["pausing", "resuming"]);
/**
 * Shared by the API and worker. Screen ids are claimed under a file lock so two
 * processes cannot assign the same session to different displays.
 */
export const CREATEOS_SCREEN_MAP_SCRIPT = `
import fcntl, json, os, sys

def write_map(path, data):
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(temporary, path)

op, key, screen_id, path = sys.argv[2:6]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path + ".lock", "a", encoding="utf-8") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data = {
        item_key: item_value
        for item_key, item_value in data.items()
        if isinstance(item_key, str) and isinstance(item_value, str) and item_value
    }
    if op == "remove":
        current = data.get(key) or ""
        if screen_id and current != screen_id:
            print("mismatch")
        else:
            data.pop(key, None)
            write_map(path, data)
            print("ok")
    elif op == "begin-release":
        current = data.get(key) or ""
        if current.startswith("draining:"):
            print(current[len("draining:"):])
        elif current:
            data[key] = "draining:" + current
            write_map(path, data)
            print(current)
        else:
            print("")
    elif op == "abort-release":
        current = data.get(key) or ""
        if screen_id and current == "draining:" + screen_id:
            data[key] = screen_id
            write_map(path, data)
        print("ok")
    elif op == "commit-release":
        current = data.get(key) or ""
        if screen_id and current == "draining:" + screen_id:
            data.pop(key, None)
            write_map(path, data)
        print("ok")
    elif op == "put":
        current = data.get(key) or ""
        if current and not current.startswith("draining:"):
            print(current)
        elif screen_id == "screen-0" and "screen-0" in data.values():
            print("NEED_CREATE")
        else:
            data[key] = screen_id
            write_map(path, data)
            print(screen_id)
    else:
        print(json.dumps(data))
`;

const CHROME_CLEAN_EXIT_SCRIPT = `
import json, os, sys
profile = sys.argv[1]
for relative in ("Default/Preferences", "Local State"):
    path = os.path.join(profile, relative)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        continue
    data.setdefault("profile", {})
    data["profile"]["exited_cleanly"] = True
    data["profile"]["exit_type"] = "Normal"
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
`;

export interface CreateOSSandboxProviderOptions {
  apiKey: string;
  baseUrl?: string;
  shape?: string;
  rootfs?: string;
  fetch?: typeof fetch;
}

interface CreateOSView {
  id: string;
  status: string;
}

interface CreateOSExecResponse {
  result?: {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    error?: string;
  };
}

interface CreateOSScreenConnection {
  screen_id: string;
  url?: string;
  path?: string;
  token?: string;
}

export class CreateOSSandboxProvider implements SandboxProvider {
  private readonly baseUrl: string;
  private readonly shape: string;
  private readonly rootfs: string;
  private readonly fetchImpl: typeof fetch;
  private readonly screenAssignments = new Map<string, Map<string, string>>();
  /** Serializes assignment changes with the connect decision for one session. */
  private readonly screenGates = new Map<string, Promise<void>>();
  /** Sessions whose remote screen is being torn down. Checked before a URL is returned. */
  private readonly retiringSessions = new Set<string>();
  /** Connect calls that already resolved a screen id and have not finished yet. */
  private readonly activeScreenConnections = new Map<string, Set<Promise<void>>>();

  constructor(private readonly options: CreateOSSandboxProviderOptions) {
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_CREATEOS_BASE_URL).replace(/\/+$/, "");
    assertSecureCreateOSBaseUrl(this.baseUrl);
    this.shape = options.shape?.trim() || DEFAULT_CREATEOS_SHAPE;
    this.rootfs = options.rootfs?.trim() || DEFAULT_CREATEOS_ROOTFS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  describe() {
    return {
      id: "createos",
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
    if (request.providerRef && request.providerKind === "createos") {
      try {
        const existing = await this.waitUntilSettled(request.providerRef, context);
        if (existing.status === "destroyed" || existing.status === "failed") {
          throw new Error(`CreateOS sandbox is ${existing.status}`);
        }
        if (existing.status === "paused" || existing.status === "error") {
          await this.postJson(
            `/v1/sandboxes/${encodeURIComponent(existing.id)}/resume`,
            undefined,
            context,
          );
        }
        if (existing.status !== "running") await this.waitUntilRunning(existing.id, context);
        return this.ref(existing.id, request.botId, false);
      } catch (error) {
        if (!isUnrecoverableCreateOSError(error)) throw error;
      }
    }

    const created = await this.postJson<CreateOSView>(
      "/v1/sandboxes",
      {
        shape: this.shape,
        rootfs: this.rootfs,
        ingress_enabled: true,
        auto_pause_after_seconds: Math.max(60, Math.ceil(sandboxIdleMs() / 1_000)),
      },
      context,
    );
    if (!created?.id) throw new Error("CreateOS did not return a sandbox id");
    try {
      await this.waitUntilRunning(created.id, context);
    } catch (error) {
      await this.abandonCreatedSandbox(created.id);
      throw error;
    }
    return this.ref(created.id, request.botId, true);
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.executeChecked(
      computer,
      [
        "bash",
        "-lc",
        [
          `mkdir -p ${shellQuote(CREATEOS_WORKSPACE)} ${shellQuote(CREATEOS_CHROMIUM_PROFILE)} ${shellQuote(CREATEOS_FIREFOX_PROFILE)}`,
          "mkdir -p /tmp/runtime-desktop",
          "chmod 700 /tmp/runtime-desktop",
          "mkdir -p /home/desktop/.config",
          `ln -sfn ${shellQuote(CREATEOS_CHROMIUM_PROFILE)} /home/desktop/.config/google-chrome`,
          `ln -sfn ${shellQuote(CREATEOS_CHROMIUM_PROFILE)} /home/desktop/.config/chromium`,
          `ln -sfn ${shellQuote(CREATEOS_FIREFOX_PROFILE)} /home/desktop/.mozilla`,
          `chown -R desktop:desktop ${shellQuote(CREATEOS_WORKSPACE)} /home/desktop/.config /home/desktop/.mozilla /tmp/runtime-desktop`,
        ].join(" && "),
      ],
      context,
    );
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    let result: CreateOSExecResponse;
    try {
      result = await this.runCommand(computer, request, context, timeoutMs);
    } catch (error) {
      if (context.signal.aborted) {
        yield { type: "stderr", data: "command aborted\n" };
        yield { type: "exit", code: 130 };
        return;
      }
      if (!isTimeoutAbort(error)) throw error;
      yield { type: "stderr", data: `command timed out after ${timeoutMs} ms\n` };
      yield { type: "exit", code: 124 };
      return;
    }
    if (result.result?.stdout) yield { type: "stdout", data: result.result.stdout };
    if (result.result?.stderr) yield { type: "stderr", data: result.result.stderr };
    if (result.result?.error) yield { type: "stderr", data: `${result.result.error}\n` };
    yield { type: "exit", code: result.result?.exit_code ?? (result.result?.error ? 1 : 0) };
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.connectAssignedScreen(computer, request, context, 0);
  }

  async setScreenControl(
    _computer: ComputerRef,
    interactive: boolean,
    _context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    // Release, expiry, and demotion pass the lease id. CreateOS cannot flip an
    // existing noVNC socket; the screen proxy drops it once this lease is cleared.
    if (!interactive) return;
    if (!controlToken) throw new Error("interactive screen requires a control token");
    throw new Error("CreateOS screen control changes are unsupported");
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    await this.applyAction(computer, input, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const screenId = await this.resolveScreen(computer, context);
    const [image, size, cursor, window] = await Promise.all([
      this.getBytes(
        `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/computer/screenshot?screen_id=${encodeURIComponent(screenId)}`,
        context,
        "image/png",
      ),
      this.getJson<{ width: number; height: number }>(
        `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/computer/screen?screen_id=${encodeURIComponent(screenId)}`,
        context,
      ).catch(() => undefined),
      this.getJson<{ x: number; y: number }>(
        `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/computer/cursor?screen_id=${encodeURIComponent(screenId)}`,
        context,
      ).catch(() => undefined),
      this.getJson<{ id: string; title?: string }>(
        `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/computer/windows/current?screen_id=${encodeURIComponent(screenId)}`,
        context,
      ).catch(() => undefined),
    ]);
    return computerObservation(image, {
      mimeType: "image/png",
      width: size?.width ?? 1280,
      height: size?.height ?? 800,
      cursor,
      activeWindow: window,
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const actions = boundedComputerActions(request.actions);
    let completed = 0;
    for (const action of actions) {
      if (context.signal.aborted)
        throw context.signal.reason ?? new Error("computer action aborted");
      await this.applyAction(computer, action, context);
      completed += 1;
    }
    if (request.settleMs) await delay(clampRounded(request.settleMs, 0, 5_000));
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
    const target = workspacePath(CREATEOS_WORKSPACE, relative);
    const script = `
import json, os, stat, sys
root = sys.argv[1]
out = []
try:
    root_stat = os.lstat(root)
except OSError:
    print(json.dumps(out))
    raise SystemExit(0)
if not stat.S_ISDIR(root_stat.st_mode):
    print(json.dumps(out))
    raise SystemExit(0)
for name in os.listdir(root):
    path = os.path.join(root, name)
    try:
        st = os.lstat(path)
    except OSError:
        continue
    if stat.S_ISLNK(st.st_mode):
        continue
    out.append({"name": name, "kind": "dir" if stat.S_ISDIR(st.st_mode) else "file", "size": st.st_size, "executable": bool(st.st_mode & stat.S_IXUSR)})
print(json.dumps(out))
`;
    const result = await this.runCommand(
      computer,
      { argv: ["python3", "-c", script, target] },
      context,
      boundedSandboxCommandTimeoutMs(undefined),
    );
    if ((result.result?.exit_code ?? 1) !== 0)
      throw new Error(result.result?.stderr || "list files failed");
    const entries = JSON.parse(result.result?.stdout || "[]") as Array<{
      name: string;
      kind: "file" | "dir";
      size: number;
      executable?: boolean;
    }>;
    return entries.map((entry) => ({
      path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
      kind: entry.kind,
      size: entry.size,
      ...(entry.kind === "file" && entry.executable ? { executable: true } : {}),
    }));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const target = workspacePath(CREATEOS_WORKSPACE, filePath);
    if (options?.maxBytes !== undefined) {
      const stat = await this.runCommand(
        computer,
        { argv: ["stat", "-c", "%s", target] },
        context,
        boundedSandboxCommandTimeoutMs(undefined),
      );
      const size = Number((stat.result?.stdout ?? "").trim());
      if (Number.isFinite(size) && size > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    return this.getBytes(
      `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/files?path=${encodeURIComponent(target)}`,
      context,
      "application/octet-stream",
      options?.maxBytes ?? MAX_CREATEOS_SUCCESS_RESPONSE_BYTES,
    );
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.putFile(computer, file, context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    // Dirty state does not survive a process restart or a second provider
    // instance, and skipping the walk commits an empty checkpoint over the home.
    if (!(await this.hasExportableWorkspaceFiles(computer, "", context))) return;
    // Preferences and Local State stay in the export. Close Chromium first, the
    // same way other desktop providers quiesce a profile before copying it.
    await this.executeChecked(
      computer,
      ["bash", "-lc", stopBrowserProfileCommand(CREATEOS_CHROMIUM_PROFILE, CREATEOS_CHROMIUM_PID)],
      context,
    );
    yield* this.walkWorkspace(computer, "", context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    let batchBytes = 0;
    for await (const file of files) {
      if (batchBytes > PORTABLE_TRANSFER_BATCH_BYTES) batchBytes = 0;
      await this.putFile(computer, file, context);
      batchBytes += file.content.byteLength;
    }
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    // GET does not count as activity. An exec resets auto-pause, and callers do
    // not pass an AdapterContext through HostAwareSandbox.
    const context: AdapterContext = {
      operationId: "computer.keepAlive",
      traceId: "computer.keepAlive",
      spaceId: "createos",
      userId: "createos",
      signal: AbortSignal.timeout(15_000),
    };
    await this.runCommand(computer, { argv: ["true"] }, context, 10_000).catch(() => undefined);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const screenKey = screenSessionKey(context);
    const gateKey = this.screenGateKey(computer.providerRef, screenKey);
    const screenId = await this.withScreenGate(gateKey, async () => {
      // Visible before the map update returns, so a connect does not hand back this screen.
      this.retiringSessions.add(gateKey);
      try {
        return await this.runScreenMap(computer, "begin-release", screenKey, "", context);
      } catch (error) {
        this.retiringSessions.delete(gateKey);
        throw error;
      }
    });
    this.screenAssignments.get(computer.providerRef)?.delete(screenKey);
    if (!screenId) {
      this.retiringSessions.delete(gateKey);
      return;
    }
    try {
      // The assignment is draining, so a new connect will not adopt this id.
      // Wait until connects that already resolved it finish or rebind, then delete.
      if (screenId !== "screen-0") {
        await this.waitForScreenConnections(computer.providerRef, screenId);
        await this.deleteScreen(computer, screenId, context);
      }
    } catch (error) {
      await this.runScreenMap(computer, "abort-release", screenKey, screenId, context);
      throw error;
    } finally {
      this.retiringSessions.delete(gateKey);
    }
    await this.runScreenMap(computer, "commit-release", screenKey, screenId, context);
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    this.forget(computer.providerRef);
    await this.postJson(
      `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/pause`,
      undefined,
      context,
    ).catch(ignoreMissingCreateOSResource);
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    this.forget(computer.providerRef);
    await this.request(
      "DELETE",
      `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}`,
      undefined,
      context,
    ).catch(ignoreMissingCreateOSResource);
  }

  private forget(id: string): void {
    this.screenAssignments.delete(id);
  }

  /**
   * Bind a session to its current screen. A release marks that assignment draining
   * before the remote screen disappears; this either returns a live connection or
   * allocates a replacement instead of a null URL.
   */
  private async connectAssignedScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
    attempt: number,
  ): Promise<ScreenSession> {
    const screenKey = screenSessionKey(context);
    const gateKey = this.screenGateKey(computer.providerRef, screenKey);
    const screenId = await this.resolveScreen(computer, context);
    const endConnection = this.trackScreenConnection(computer.providerRef, screenId);
    let outcome: "keep" | "retry" | "empty" = "empty";
    let session: ScreenSession | undefined;
    try {
      let missed = false;
      const connection = await this.getJson<CreateOSScreenConnection>(
        `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/computer/screens/${encodeURIComponent(screenId)}/connect`,
        context,
      ).catch((error) => {
        if (!isUnrecoverableCreateOSError(error)) throw error;
        missed = true;
        return null;
      });
      const rawUrl = connection?.url ?? connection?.path;
      if (!missed && !rawUrl) {
        outcome = "empty";
      } else {
        outcome = await this.withScreenGate(gateKey, async () => {
          const recorded = await this.readScreenMap(computer, context);
          const current = liveScreenId(recorded[screenKey]);
          if (this.retiringSessions.has(gateKey) || missed || current !== screenId) {
            if (missed && recorded[screenKey] === screenId) {
              await this.runScreenMap(computer, "remove", screenKey, screenId, context);
              this.screenAssignments.get(computer.providerRef)?.delete(screenKey);
            }
            return attempt < 1 ? "retry" : "empty";
          }
          return "keep";
        });
        if (outcome === "keep" && connection && rawUrl) {
          // A release queued on this gate marks the session before its map update returns.
          await Promise.resolve();
          const current = liveScreenId((await this.readScreenMap(computer, context))[screenKey]);
          if (this.retiringSessions.has(gateKey) || current !== screenId) {
            outcome = attempt < 1 ? "retry" : "empty";
          } else {
            session = this.screenSession(rawUrl, connection.token, request);
          }
        }
      }
    } finally {
      endConnection();
    }
    if (outcome === "keep" && session) return session;
    if (outcome === "retry") {
      try {
        return await this.connectAssignedScreen(computer, request, context, attempt + 1);
      } catch (error) {
        if (isUnrecoverableCreateOSError(error)) return emptyScreenSession();
        throw error;
      }
    }
    return emptyScreenSession();
  }

  private screenSession(
    rawUrl: string,
    token: string | undefined,
    request: ScreenRequest,
  ): ScreenSession {
    const url = new URL(rawUrl, this.baseUrl);
    if (!isAllowedCreateOSScreenUrl(url, this.baseUrl)) {
      throw new Error("CreateOS screen URL host is not allowed");
    }
    url.searchParams.set("autoconnect", "true");
    url.searchParams.set("resize", "scale");
    if (token && !url.searchParams.has("token")) url.searchParams.set("token", token);
    if (!request.interactive) url.searchParams.set("view_only", "true");
    return { url: url.toString(), mimeType: "text/html", close: async () => undefined };
  }

  private screenGateKey(providerRef: string, screenKey: string): string {
    return `${providerRef}\0${screenKey}`;
  }

  private async withScreenGate<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.screenGates.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.screenGates.set(key, tail);
    await previous;
    try {
      return await run();
    } finally {
      releaseCurrent();
      if (this.screenGates.get(key) === tail) this.screenGates.delete(key);
    }
  }

  private trackScreenConnection(providerRef: string, screenId: string): () => void {
    const key = `${providerRef}\0${screenId}`;
    let connections = this.activeScreenConnections.get(key);
    if (!connections) {
      connections = new Set();
      this.activeScreenConnections.set(key, connections);
    }
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active = connections;
    active.add(pending);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      finish();
      active.delete(pending);
      if (active.size === 0 && this.activeScreenConnections.get(key) === active) {
        this.activeScreenConnections.delete(key);
      }
    };
  }

  private async waitForScreenConnections(providerRef: string, screenId: string): Promise<void> {
    const key = `${providerRef}\0${screenId}`;
    for (;;) {
      const pending = [...(this.activeScreenConnections.get(key) ?? [])];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  private ref(id: string, botId: string, fresh: boolean): ComputerRef {
    return { id, botId, kind: "createos", providerRef: id, fresh };
  }

  private async resolveScreen(computer: ComputerRef, context: AdapterContext): Promise<string> {
    const screenKey = screenSessionKey(context);
    // Another process can release and reassign this session. The shared map is
    // the assignment; the process-local cache is only a copy of the last read.
    const recorded = await this.readScreenMap(computer, context);
    const existing = liveScreenId(recorded[screenKey]);
    if (existing) {
      this.rememberScreen(computer.providerRef, screenKey, existing);
      return existing;
    }
    const screenId = Object.values(recorded).includes("screen-0")
      ? await this.createScreen(computer, context)
      : "screen-0";
    const stored = await this.claimScreen(computer, screenKey, screenId, context);
    this.rememberScreen(computer.providerRef, screenKey, stored);
    return stored;
  }

  private rememberScreen(providerRef: string, screenKey: string, screenId: string): void {
    let assignments = this.screenAssignments.get(providerRef);
    if (!assignments) {
      assignments = new Map();
      this.screenAssignments.set(providerRef, assignments);
    }
    assignments.set(screenKey, screenId);
  }

  private async claimScreen(
    computer: ComputerRef,
    screenKey: string,
    screenId: string,
    context: AdapterContext,
  ): Promise<string> {
    let stored = await this.runScreenMap(computer, "put", screenKey, screenId, context);
    if (stored !== CREATEOS_SCREEN_MAP_NEED_CREATE) return stored;
    const created = await this.createScreen(computer, context);
    stored = await this.runScreenMap(computer, "put", screenKey, created, context);
    if (stored !== created) await this.deleteScreen(computer, created, context);
    if (stored === CREATEOS_SCREEN_MAP_NEED_CREATE) {
      throw new Error("CreateOS screen assignment failed");
    }
    return stored;
  }

  private async createScreen(computer: ComputerRef, context: AdapterContext): Promise<string> {
    const created = await this.postJson<{ screen_id?: string }>(
      `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/computer/screens`,
      { width: 1280, height: 800 },
      context,
    );
    if (!created?.screen_id) throw new Error("CreateOS did not return a screen id");
    return created.screen_id;
  }

  private async deleteScreen(
    computer: ComputerRef,
    screenId: string,
    context: AdapterContext,
  ): Promise<void> {
    if (screenId === "screen-0") return;
    await this.request(
      "DELETE",
      `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/computer/screens/${encodeURIComponent(screenId)}`,
      undefined,
      context,
    ).catch(ignoreMissingCreateOSResource);
  }

  private async readScreenMap(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<Record<string, string>> {
    const stdout = await this.runScreenMap(computer, "read", "", "", context);
    if (!stdout) return {};
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) entries[key] = value;
    }
    return entries;
  }

  private async runScreenMap(
    computer: ComputerRef,
    op: "read" | "put" | "remove" | "begin-release" | "abort-release" | "commit-release",
    key: string,
    screenId: string,
    context: AdapterContext,
  ): Promise<string> {
    const result = await this.runCommand(
      computer,
      {
        argv: [
          "python3",
          "-c",
          CREATEOS_SCREEN_MAP_SCRIPT,
          CREATEOS_SCREEN_MAP_SENTINEL,
          op,
          key,
          screenId,
          CREATEOS_SCREEN_MAP_PATH,
        ],
      },
      context,
      boundedSandboxCommandTimeoutMs(undefined),
    );
    if ((result.result?.exit_code ?? 1) !== 0) {
      throw new Error(
        result.result?.stderr || result.result?.error || "CreateOS screen map failed",
      );
    }
    return (result.result?.stdout ?? "").trim();
  }

  private async abandonCreatedSandbox(id: string): Promise<void> {
    const context: AdapterContext = {
      operationId: "createos.abandon",
      traceId: "createos.abandon",
      spaceId: "createos",
      userId: "createos",
      signal: AbortSignal.timeout(10_000),
    };
    await this.request(
      "DELETE",
      `/v1/sandboxes/${encodeURIComponent(id)}`,
      undefined,
      context,
    ).catch(() => undefined);
  }

  private async applyAction(
    computer: ComputerRef,
    action: ComputerAction | ComputerInput,
    context: AdapterContext,
  ): Promise<void> {
    const screenId = await this.resolveScreen(computer, context);
    const root = `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/computer`;
    const query = `screen_id=${encodeURIComponent(screenId)}`;
    if (action.kind === "key") {
      await this.postJson(
        `${root}/keyboard/press?${query}`,
        { keys: [...(action.modifiers ?? []), action.key] },
        context,
      );
      return;
    }
    if (action.kind === "clipboard") {
      await this.putJson(`${root}/clipboard?${query}`, { text: action.text }, context);
      return;
    }
    if (action.kind === "pointer") {
      if (action.type === "move")
        await this.postJson(`${root}/mouse/move?${query}`, { x: action.x, y: action.y }, context);
      else if (action.type === "click") {
        await this.postJson(
          `${root}/mouse/click?${query}`,
          {
            x: action.x,
            y: action.y,
            button: action.button ?? "left",
          },
          context,
        );
      } else {
        await this.postJson(
          `${root}/mouse/${action.type}?${query}`,
          { button: action.button ?? "left" },
          context,
        );
      }
      return;
    }
    if (action.kind === "scroll") {
      await this.postJson(
        `${root}/mouse/scroll?${query}`,
        {
          direction: action.direction,
          amount: clampRounded(action.amount ?? 3, 1, 100),
        },
        context,
      );
      return;
    }
    if (action.kind === "wait") {
      await delay(clampRounded(action.ms, 0, 5_000));
      return;
    }
    if (action.kind === "open") {
      const target = /^https?:\/\//i.test(action.path)
        ? action.path
        : workspacePath(CREATEOS_WORKSPACE, action.path);
      if (/^https?:\/\//i.test(target)) {
        await this.launchBrowser(computer, target, context);
        return;
      }
      await this.postJson(`${root}/open?${query}`, { target }, context);
      return;
    }
    if (isBrowserApplication(action.application)) {
      await this.launchBrowser(computer, action.uri ?? "about:blank", context);
      return;
    }
    await this.postJson(
      `${root}/launch?${query}`,
      {
        application: action.application,
        ...(action.uri ? { uri: action.uri } : {}),
      },
      context,
    );
  }

  private async launchBrowser(
    computer: ComputerRef,
    uri: string,
    context: AdapterContext,
    options: { settleMs?: number } = {},
  ): Promise<void> {
    if (await this.openBrowserTab(computer, uri, context)) {
      const settleMs = clampRounded(options.settleMs ?? 1_000, 0, 5_000);
      if (settleMs > 0) await delay(settleMs, undefined, { signal: context.signal });
      return;
    }
    const profile = CREATEOS_CHROMIUM_PROFILE;
    const settleMs = clampRounded(options.settleMs ?? 1_000, 0, 5_000);
    await this.executeChecked(
      computer,
      [
        "bash",
        "-lc",
        [
          `mkdir -p ${shellQuote(profile)} /tmp/runtime-desktop`,
          `chown -R desktop:desktop ${shellQuote(profile)} /tmp/runtime-desktop`,
          "chmod 700 /tmp/runtime-desktop",
          [
            "if pgrep -u desktop -f 'chrome|chromium' >/dev/null; then",
            [
              "setsid",
              "runuser -u desktop --",
              "nohup",
              "env",
              "HOME=/home/desktop",
              "USER=desktop",
              "LOGNAME=desktop",
              "DISPLAY=:0",
              "XDG_RUNTIME_DIR=/tmp/runtime-desktop",
              "google-chrome",
              "--new-tab",
              shellQuote(uri),
              ">/tmp/rakazo-chrome.log 2>&1 </dev/null &",
            ].join(" "),
            "else",
            [
              "rm -f",
              shellQuote(`${profile}/SingletonLock`),
              shellQuote(`${profile}/SingletonSocket`),
              shellQuote(`${profile}/SingletonCookie`),
            ].join(" "),
            "&&",
            ["python3 -c", shellQuote(CHROME_CLEAN_EXIT_SCRIPT), shellQuote(profile)].join(" "),
            "&&",
            [
              "setsid",
              "runuser -u desktop --",
              "nohup",
              "env",
              "HOME=/home/desktop",
              "USER=desktop",
              "LOGNAME=desktop",
              "DISPLAY=:0",
              "XDG_RUNTIME_DIR=/tmp/runtime-desktop",
              "google-chrome",
              "--disable-dev-shm-usage",
              "--no-first-run",
              "--no-default-browser-check",
              "--disable-crash-reporter",
              "--disable-session-crashed-bubble",
              "--disable-infobars",
              "--disable-gpu",
              "--remote-debugging-address=127.0.0.1",
              "--remote-debugging-port=9222",
              `--user-data-dir=${shellQuote(profile)}`,
              shellQuote(uri),
              ">/tmp/rakazo-chrome.log 2>&1 </dev/null &",
            ].join(" "),
            "fi",
          ].join(" "),
          ...(settleMs > 0 ? [`sleep ${shellQuote(String(settleMs / 1_000))}`] : []),
        ].join(" && "),
      ],
      context,
      10_000 + settleMs,
    );
  }

  private async openBrowserTab(
    computer: ComputerRef,
    uri: string,
    context: AdapterContext,
  ): Promise<boolean> {
    const script = `
import sys, urllib.parse, urllib.request
uri = sys.argv[1]
target = "http://127.0.0.1:9222/json/new?" + urllib.parse.quote(uri, safe="")
for method in ("PUT", "GET"):
    try:
        req = urllib.request.Request(target, method=method)
        with urllib.request.urlopen(req, timeout=1):
            raise SystemExit(0)
    except Exception:
        pass
raise SystemExit(1)
`;
    const result = await this.runCommand(
      computer,
      { argv: ["python3", "-c", script, uri] },
      context,
      3_000,
    );
    return (result.result?.exit_code ?? 1) === 0;
  }

  private async putFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const target = workspacePath(CREATEOS_WORKSPACE, file.path);
    await this.request(
      "PUT",
      `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/files?path=${encodeURIComponent(target)}`,
      toArrayBuffer(file.content),
      context,
      "application/octet-stream",
    );
    if (file.executable) {
      await this.executeChecked(computer, ["chmod", "700", target], context);
    }
  }

  private async *walkWorkspace(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const entries = await this.listFiles(computer, directory, context);
    for (const entry of entries) {
      if (shouldSkipCreateOSWorkspaceFile(entry.path)) continue;
      if (entry.kind === "dir") {
        yield* this.walkWorkspace(computer, entry.path, context);
      } else {
        yield {
          path: entry.path,
          content: await this.readFile(computer, entry.path, context),
          executable: entry.executable,
        };
      }
    }
  }

  private async hasExportableWorkspaceFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<boolean> {
    const entries = await this.listFiles(computer, directory, context);
    for (const entry of entries) {
      if (shouldSkipCreateOSWorkspaceFile(entry.path)) continue;
      if (entry.kind === "file") return true;
      if (await this.hasExportableWorkspaceFiles(computer, entry.path, context)) return true;
    }
    return false;
  }

  private async executeChecked(
    computer: ComputerRef,
    argv: string[],
    context: AdapterContext,
    timeoutMs = boundedSandboxCommandTimeoutMs(undefined),
  ) {
    const result = await this.runCommand(computer, { argv }, context, timeoutMs);
    if ((result.result?.exit_code ?? 1) !== 0) {
      throw new Error(result.result?.stderr || result.result?.error || "CreateOS command failed");
    }
  }

  private async runCommand(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
    timeoutMs: number,
  ): Promise<CreateOSExecResponse> {
    const cwd = createosCwd(request.cwd);
    const env = request.env
      ? Object.entries(request.env)
          .map(([key, value]) => `${key}=${shellQuote(value)}`)
          .join(" ")
      : "";
    const command = [
      `mkdir -p ${shellQuote(cwd)}`,
      `cd ${shellQuote(cwd)}`,
      `${env ? `${env} ` : ""}${request.argv.map(shellQuote).join(" ")}`,
    ].join(" && ");
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
    return this.postJson<CreateOSExecResponse>(
      `/v1/sandboxes/${encodeURIComponent(computer.providerRef)}/exec`,
      { cmd: "timeout", args: [`${seconds}s`, "bash", "-lc", command] },
      context,
      timeoutMs + 5_000,
    );
  }

  private async getSandbox(id: string, context: AdapterContext): Promise<CreateOSView> {
    return this.getJson<CreateOSView>(`/v1/sandboxes/${encodeURIComponent(id)}`, context);
  }

  /**
   * stop() returns while the control plane still reports "pausing". Resume is only
   * valid once that transition finishes, so settle first and act on the final status.
   */
  private async waitUntilSettled(id: string, context: AdapterContext): Promise<CreateOSView> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const current = await this.pollSandbox(id, context);
      if (current && !TRANSITIONAL_CREATEOS_STATUSES.has(current.status)) return current;
      await delay(1_000, undefined, { signal: context.signal });
    }
    throw new Error("CreateOS sandbox did not settle");
  }

  private async waitUntilRunning(id: string, context: AdapterContext): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const current = await this.pollSandbox(id, context);
      if (current?.status === "running") return;
      if (current?.status === "destroyed" || current?.status === "failed") {
        throw new Error(`CreateOS sandbox is ${current.status}`);
      }
      await delay(1_000, undefined, { signal: context.signal });
    }
    throw new Error("CreateOS sandbox did not become running");
  }

  /** Returns undefined for a transient control-plane failure so the caller keeps polling. */
  private async pollSandbox(
    id: string,
    context: AdapterContext,
  ): Promise<CreateOSView | undefined> {
    try {
      return await this.getSandbox(id, context);
    } catch (error) {
      if (error instanceof CreateOSHttpError && isTransientCreateOSHttpStatus(error.status)) {
        return undefined;
      }
      throw error;
    }
  }

  private getJson<T>(path: string, context: AdapterContext): Promise<T> {
    return this.requestJson<T>("GET", path, undefined, context);
  }

  private postJson<T>(
    path: string,
    body: unknown,
    context: AdapterContext,
    timeoutMs?: number,
  ): Promise<T> {
    return this.requestJson<T>("POST", path, body, context, timeoutMs);
  }

  private putJson<T>(path: string, body: unknown, context: AdapterContext): Promise<T> {
    return this.requestJson<T>("PUT", path, body, context);
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body: unknown,
    context: AdapterContext,
    timeoutMs?: number,
  ): Promise<T> {
    const response = await this.request(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      context,
      body === undefined ? undefined : "application/json",
      timeoutMs,
    );
    const payload = await readCreateOSJson<{ status?: string; data?: T; message?: string }>(
      response,
      context.signal,
    );
    if (payload.status === "success") {
      if (payload.data === undefined) throw new Error("CreateOS response did not include data");
      return payload.data as T;
    }
    if (payload.status && payload.status !== "success") {
      throw new Error(
        payload.message ||
          (typeof payload.data === "string"
            ? payload.data
            : "CreateOS response was not successful"),
      );
    }
    if (payload.data !== undefined) return payload.data as T;
    throw new Error(payload.message || "CreateOS response was not successful");
  }

  private async getBytes(
    path: string,
    context: AdapterContext,
    accept: string,
    maxBytes = MAX_CREATEOS_SUCCESS_RESPONSE_BYTES,
  ): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.request(
          "GET",
          path,
          undefined,
          context,
          undefined,
          undefined,
          accept,
        );
        return await readCreateOSBody(response, maxBytes, context.signal);
      } catch (error) {
        if (
          attempt === 2 ||
          !(error instanceof CreateOSHttpError) ||
          !isTransientCreateOSHttpStatus(error.status)
        ) {
          throw error;
        }
        await delay(250 * (attempt + 1), undefined, { signal: context.signal });
      }
    }
    throw new Error("CreateOS byte request failed");
  }

  private async request(
    method: string,
    path: string,
    body: BodyInit | undefined,
    context: AdapterContext,
    contentType?: string,
    timeoutMs = 30_000,
    accept?: string,
  ): Promise<Response> {
    const url = new URL(path, `${this.baseUrl}/`);
    const headers = new Headers({
      "X-Api-Key": this.options.apiKey,
      ...(accept ? { Accept: accept } : {}),
      ...(contentType ? { "Content-Type": contentType } : {}),
    });
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([context.signal, timeout]);
    const response = await this.fetchImpl(url, { method, headers, body, signal });
    if (!response.ok) {
      const message = await readCreateOSErrorMessage(response, signal);
      throw new CreateOSHttpError(response.status, message || response.statusText);
    }
    return response;
  }
}

export function isUnrecoverableCreateOSError(error: unknown): boolean {
  if (error instanceof CreateOSHttpError && error.status === 404) return true;
  return (
    error instanceof Error &&
    /not found|does not exist|404|not_found|sandbox not found|sandbox is destroyed|sandbox is failed/i.test(
      error.message,
    )
  );
}

class CreateOSHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message || `CreateOS request failed (${status})`);
  }
}

function assertSecureCreateOSBaseUrl(baseUrl: string): void {
  const { protocol, hostname } = new URL(baseUrl);
  if (protocol === "https:") return;
  if (protocol === "http:" && LOOPBACK_HOSTS.has(hostname)) return;
  throw new Error("CreateOS base URL must use https unless it points at loopback");
}

async function readCreateOSJson<T>(response: Response, signal: AbortSignal): Promise<T> {
  const bytes = await readCreateOSBody(response, MAX_CREATEOS_SUCCESS_RESPONSE_BYTES, signal);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function readCreateOSBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelCreateOSResponseBody(response);
    throw new Error(`CreateOS response exceeds ${maxBytes} bytes`);
  }
  const readSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(CREATEOS_SUCCESS_RESPONSE_TIMEOUT_MS),
  ]);
  try {
    return await readBodyCapped(response, maxBytes, readSignal);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error(`CreateOS response exceeds ${maxBytes} bytes`, { cause: error });
    }
    throw error;
  }
}

async function readCreateOSErrorMessage(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_CREATEOS_ERROR_RESPONSE_BYTES) {
    cancelCreateOSResponseBody(response);
    return "";
  }
  try {
    const readSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(CREATEOS_ERROR_RESPONSE_TIMEOUT_MS),
    ]);
    const bytes = await readBodyCapped(response, MAX_CREATEOS_ERROR_RESPONSE_BYTES, readSignal);
    return new TextDecoder().decode(bytes).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return "";
  }
}

function cancelCreateOSResponseBody(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Error diagnostics are best-effort and must not delay the operation failure.
  }
}

function isMissingCreateOSResource(error: unknown): boolean {
  return error instanceof CreateOSHttpError && error.status === 404;
}

function ignoreMissingCreateOSResource(error: unknown): void {
  if (!isMissingCreateOSResource(error)) throw error;
}

function isTimeoutAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function isTransientCreateOSHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function shouldSkipCreateOSWorkspaceFile(relative: string): boolean {
  if (relative === ".rakazo" || relative.startsWith(".rakazo/")) return true;
  if (
    relative.startsWith(`${BROWSER_PROFILE_DIR}/`) &&
    relative.split("/").some((segment) => BROWSER_PROFILE_CACHE_DIRS.has(segment))
  ) {
    return true;
  }
  return shouldSkipPortableWorkspaceFile(relative);
}

export function isAllowedCreateOSScreenUrl(resolved: URL, baseUrl: string): boolean {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (resolved.username || resolved.password) return false;
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return false;
  if (
    resolved.protocol === "http:" &&
    (!LOOPBACK_HOSTS.has(resolved.hostname) || !LOOPBACK_HOSTS.has(base.hostname))
  ) {
    return false;
  }
  if (!isAllowedCreateOSScreenHost(resolved.hostname, base.hostname)) return false;
  if (LOOPBACK_HOSTS.has(resolved.hostname)) return true;
  if (resolved.protocol !== "https:") return false;
  if (resolved.port === "" || resolved.port === "443") return true;
  return resolved.hostname === base.hostname && resolved.port === base.port;
}

function isAllowedCreateOSScreenHost(hostname: string, baseHost: string): boolean {
  const host = hostname.toLowerCase();
  const base = baseHost.toLowerCase();
  if (host === base || host.endsWith(`.${base}`)) return true;
  if (base === "api.sb.createos.sh" || base.endsWith(`.${CREATEOS_INGRESS_ZONE}`)) {
    return host === CREATEOS_INGRESS_ZONE || host.endsWith(`.${CREATEOS_INGRESS_ZONE}`);
  }
  return false;
}

function createosCwd(cwd: string | undefined): string {
  if (!cwd || cwd === "." || cwd === "/" || cwd === "/home/rakazo" || cwd === "/home/desktop") {
    return CREATEOS_WORKSPACE;
  }
  if (cwd === CREATEOS_WORKSPACE || cwd.startsWith(`${CREATEOS_WORKSPACE}/`)) return cwd;
  return workspacePath(CREATEOS_WORKSPACE, cwd);
}

function emptyScreenSession(): ScreenSession {
  return { url: null, mimeType: "text/html", close: async () => undefined };
}

function liveScreenId(value: string | undefined): string | undefined {
  if (!value || value.startsWith(CREATEOS_DRAINING_SCREEN)) return undefined;
  return value;
}

function isBrowserApplication(application: string): boolean {
  return /^(browser|chrome|google-chrome|google-chrome-stable|chromium|chromium-browser)$/i.test(
    application,
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
