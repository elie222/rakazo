import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type CommandResult, Sandbox, TimeoutError } from "@e2b/desktop";
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
import { CANCEL_PRIMARY_BROWSER_WORK, sandboxIdleMs } from "./computer-idle.js";
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
  noVncProxyProcessPattern,
  observeExtraDisplayCommand,
  parseAllocatedExtraDisplay,
  parseExtraDisplayObservation,
  parseExtraDisplayViewPassword,
  parseReleasedExtraDisplay,
  releaseExtraDisplayCommand,
  screenControlKey,
  websockifyProcessPattern,
} from "./extra-displays.js";

const E2B_WORKSPACE = "/home/user/rakazo-home";
const E2B_BROWSER_PROFILES = `${E2B_WORKSPACE}/.browser-profiles`;

export interface E2BSandboxSdk {
  create(options: ReturnType<typeof e2bCreateOptions>): Promise<Sandbox>;
  connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<Sandbox>;
  pause(id: string, options: { apiKey: string }): Promise<void>;
}

export function e2bCreateOptions(botId: string, apiKey: string) {
  return {
    apiKey,
    timeoutMs: sandboxIdleMs(),
    metadata: { botId, rakazo: "computer" },
    resolution: [1280, 800] as [number, number],
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
  };
}

// A sandbox that has expired stops resolving as a host, so reaching it fails at the socket
// rather than with a 404. undici reports every one of those as a bare "fetch failed" and
// hides the errno on the cause chain. Used only by provision reconnect: replaceComputer must
// not treat these as permanent, or an update-mode checkpoint blip destroys the old box
// without committing workspace changes that exist only there.
const SANDBOX_UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isUnreachableTransportError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && SANDBOX_UNREACHABLE_CODES.has(code)) return true;
    if (current.message === "fetch failed") return true;
  }
  return false;
}

/**
 * True when the sandbox is permanently gone (404 / killed / not found). Used by
 * replaceComputer to decide whether to swallow checkpoint/destroy failures.
 * Transient transport errors stay recoverable so update/reset can abort without
 * discarding an uncommitted workspace on a still-reachable box.
 */
export function isUnrecoverableSandboxError(error: unknown): boolean {
  if (LEGACY_GONE_MESSAGE.test(errorMessage(error))) return true;
  return isSandboxGoneError(error);
}

// How the E2B SDK words a sandbox that no longer exists. It does not always say "not found":
// an expired sandbox surfaces as a TimeoutError about the *sandbox* timeout (502 / Unavailable
// from envd), which used to read as a live sandbox and left every later call throwing forever.
const SANDBOX_GONE_MESSAGE =
  /probably not running anymore|likely due to sandbox timeout|killed or reached its end of life|sandbox [^:]{0,60}not found|sandbox [^:]{0,60}does not exist/i;
// The same words from a live sandbox: a missing binary or a missing file inside it.
const SHELL_MISSING_TARGET = /command not found|no such file|^path .* not found/i;
const LEGACY_GONE_MESSAGE =
  /not found|does not exist|404|not_found|killed|doesn't exist|sandbox not found/i;

/**
 * Narrower than isUnrecoverableSandboxError: the provider itself said this sandbox is gone.
 * A missing binary or a missing file inside a live sandbox is not proof of death, so callers
 * that persist "the sandbox is gone" must use this one.
 */
export function isSandboxGoneError(error: unknown): boolean {
  const message = errorMessage(error);
  if (SHELL_MISSING_TARGET.test(message)) return false;
  if (SANDBOX_GONE_MESSAGE.test(message)) return true;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "SandboxNotFoundError") return true;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const E2B_BROWSER_APPS = ["google-chrome", "firefox", "chromium"] as const;

type E2BDesktopBrowser = {
  launch: (application: string, uri?: string) => Promise<void>;
  open: (fileOrUrl: string) => Promise<void>;
};

type E2BDesktopCommands = {
  run: (cmd: string) => Promise<{ exitCode?: number }>;
};

export async function openDesktopBrowser(desktop: E2BDesktopBrowser): Promise<void> {
  for (const app of E2B_BROWSER_APPS) {
    try {
      await desktop.launch(app);
      return;
    } catch {
      // try the next installed browser
    }
  }
  await desktop.open("https://www.google.com").catch(() => undefined);
}

/** Open an http(s) URL via a named browser — avoids the broken default-browser association. */
export async function openDesktopUrl(
  desktop: E2BDesktopBrowser & { commands: E2BDesktopCommands },
  url: string,
): Promise<void> {
  for (const app of E2B_BROWSER_APPS) {
    // Prefer a foreground gtk-launch so missing desktop entries / launch failures reject
    // and we can try the next browser. desktop.launch backgrounds and always resolves.
    const launched = await desktop.commands
      .run(`gtk-launch ${shellQuote(app)} ${shellQuote(url)}`)
      .then(
        (result) => (result.exitCode ?? 0) === 0,
        () => false,
      );
    if (launched) return;
  }
  await desktop.open(url);
}

export class E2BSandboxProvider implements SandboxProvider {
  private readonly boxes = new Map<string, Sandbox>();
  private readonly connections = new Map<string, Promise<Sandbox>>();
  private readonly lastTouchedAt = new Map<string, number>();
  private readonly streamStarts = new Map<string, Promise<string>>();
  private readonly controlStreams = new Map<string, { password: string; controlToken: string }>();
  private readonly controlStarts = new Map<string, Promise<string>>();

  constructor(
    private readonly apiKey: string,
    private readonly sdk: E2BSandboxSdk = Sandbox as unknown as E2BSandboxSdk,
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

  private async box(computer: ComputerRef): Promise<Sandbox> {
    const id = computer.providerRef || computer.id;
    const existing = this.boxes.get(id);
    if (existing) {
      const lastTouched = this.lastTouchedAt.get(id) ?? 0;
      if (Date.now() - lastTouched < 60_000) return existing;
      // A cached handle to a sandbox E2B already killed keeps throwing on every call, and the
      // process never reconnects. The keepalive is the cheapest place to notice and drop it.
      const gone = await existing.setTimeout(sandboxIdleMs()).then(
        () => false,
        (error: unknown) => isSandboxGoneError(error),
      );
      if (!gone) {
        this.lastTouchedAt.set(id, Date.now());
        return existing;
      }
      if (this.boxes.get(id) === existing) this.forget(id);
    }
    const pending = this.connections.get(id);
    if (pending) return pending;
    let connection!: Promise<Sandbox>;
    connection = this.sdk
      .connect(id, { apiKey: this.apiKey, timeoutMs: sandboxIdleMs() })
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

  private async startStream(desktop: Sandbox) {
    if (this.boxes.get(desktop.sandboxId) !== desktop) {
      throw new Error("screen stream stopped during computer teardown");
    }
    const pending = this.streamStarts.get(desktop.sandboxId);
    if (pending) return pending;
    let start!: Promise<string>;
    start = this.initializeStream(desktop).finally(() => {
      if (this.streamStarts.get(desktop.sandboxId) === start) {
        this.streamStarts.delete(desktop.sandboxId);
      }
    });
    this.streamStarts.set(desktop.sandboxId, start);
    return start;
  }

  private async initializeStream(desktop: Sandbox): Promise<string> {
    const result = await this.runSetupCommand(
      desktop,
      ensureE2BPrimaryViewCommand(desktop.display ?? ":0", randomBytes(6).toString("base64url")),
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `screen stream failed to start (exit ${result.exitCode})${result.stderr ? `: ${result.stderr}` : ""}`,
      );
    }
    if (this.boxes.get(desktop.sandboxId) !== desktop) {
      throw new Error("screen stream stopped during computer teardown");
    }
    return parseExtraDisplayViewPassword(result.stdout);
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
        // Permanent gone (404/killed) or unreachable transport: boot fresh. Other errors rethrow.
        if (!isUnrecoverableSandboxError(error) && !isUnreachableTransportError(error)) {
          throw error;
        }
      }
    }
    const desktop = await this.sdk.create(e2bCreateOptions(request.botId, this.apiKey));
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

  async prepare(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const desktop = await this.box(computer);
    if (computer.fresh) await desktop.files.makeDir(E2B_WORKSPACE);
    const profilesChanged = await configurePortableBrowserProfiles(desktop);
    await configureDefaultWebBrowser(desktop);
    if (!computer.fresh && profilesChanged) await openDesktopBrowser(desktop);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const desktop = await this.box(computer);
    const cmd = request.argv.map(shellQuote).join(" ");
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    try {
      const result = await desktop.commands.run(cmd, {
        cwd: e2bCwd(request.cwd),
        envs: request.env,
        signal: context.signal,
        timeoutMs,
      });
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.exitCode ?? 0 };
    } catch (error) {
      if (error instanceof TimeoutError) {
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
    const desktop = await this.box(computer);
    const screenKey = screenSessionKey(context);
    const layout = await this.resolveLayout(desktop, screenKey, context.screenLeaseId);
    if (layout.isPrimary) {
      if (request.interactive) {
        if (!request.controlToken) throw new Error("interactive screen requires a control token");
        const password = await this.startControlStream(desktop, request.controlToken, screenKey);
        const url = new URL(`https://${desktop.getHost(layout.controlPort)}/vnc.html`);
        url.searchParams.set("autoconnect", "true");
        url.searchParams.set("resize", "scale");
        url.searchParams.set("password", password);
        return {
          url: url.toString(),
          mimeType: "text/html",
          close: async () => undefined,
        };
      }
      const password = await this.startStream(desktop);
      const url = new URL(`https://${desktop.getHost(layout.viewPort)}/vnc.html`);
      url.searchParams.set("autoconnect", "true");
      url.searchParams.set("resize", "scale");
      url.searchParams.set("view_only", "true");
      url.searchParams.set("password", password);
      return {
        url: url.toString(),
        mimeType: "text/html",
        close: async () => undefined,
      };
    }
    const viewPassword = await this.ensureExtraDisplay(desktop, layout, context);
    if (request.interactive) {
      if (!request.controlToken) throw new Error("interactive screen requires a control token");
      const password = await this.startControlStream(
        desktop,
        request.controlToken,
        screenKey,
        layout,
      );
      const url = new URL(`https://${desktop.getHost(layout.controlPort)}/vnc.html`);
      url.searchParams.set("autoconnect", "true");
      url.searchParams.set("resize", "scale");
      url.searchParams.set("password", password);
      return {
        url: url.toString(),
        mimeType: "text/html",
        close: async () => undefined,
      };
    }
    const url = new URL(`https://${desktop.getHost(layout.viewPort)}/vnc.html`);
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
    const desktop = await this.box(computer);
    const screenKey = screenSessionKey(context);
    const layout = await this.resolveLayout(desktop, screenKey, context.screenLeaseId);
    if (layout.isPrimary) {
      if (interactive) {
        if (!controlToken) throw new Error("interactive screen requires a control token");
        await this.startControlStream(desktop, controlToken, screenKey);
      } else {
        await this.stopControlStream(desktop, controlToken, screenKey);
      }
      return;
    }
    if (interactive) {
      if (!controlToken) throw new Error("interactive screen requires a control token");
      await this.ensureExtraDisplay(desktop, layout, context);
      await this.startControlStream(desktop, controlToken, screenKey, layout);
    } else {
      await this.stopControlStream(desktop, controlToken, screenKey, layout);
    }
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const desktop = await this.box(computer);
    const layout = await this.resolveLayout(
      desktop,
      screenSessionKey(context),
      context.screenLeaseId,
    );
    if (layout.isPrimary) {
      await applyE2BAction(desktop, input);
      return;
    }
    await this.ensureExtraDisplay(desktop, layout, context);
    const result = await desktop.commands.run(extraDisplayInputCommand(layout, input), {
      signal: context.signal,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "extra display input failed");
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const desktop = await this.box(computer);
    const layout = await this.resolveLayout(
      desktop,
      screenSessionKey(context),
      context.screenLeaseId,
    );
    if (layout.isPrimary) return observeE2BDesktop(desktop, context);
    await this.ensureExtraDisplay(desktop, layout, context);
    const result = await desktop.commands.run(observeExtraDisplayCommand(layout), {
      signal: context.signal,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "extra display observation failed");
    const parsed = parseExtraDisplayObservation(result.stdout);
    return computerObservation(parsed.image, {
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: parsed.cursor,
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const desktop = await this.box(computer);
    const layout = await this.resolveLayout(
      desktop,
      screenSessionKey(context),
      context.screenLeaseId,
    );
    const actions = boundedComputerActions(request.actions);
    let completed = 0;
    if (!layout.isPrimary) await this.ensureExtraDisplay(desktop, layout, context);
    for (const action of actions) {
      if (context.signal.aborted)
        throw context.signal.reason ?? new Error("computer action aborted");
      if (layout.isPrimary) await applyE2BAction(desktop, action);
      else {
        const result = await desktop.commands.run(extraDisplayActionCommand(layout, action), {
          signal: context.signal,
        });
        if (result.exitCode !== 0) throw new Error(result.stderr || "extra display action failed");
      }
      completed += 1;
    }
    if (request.settleMs) await desktop.wait(clampRounded(request.settleMs, 0, 5_000));
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
    const desktop = await this.box(computer);
    const relative = normalizeWorkspacePath(directory);
    const entries = await desktop.files.list(workspacePath(E2B_WORKSPACE, relative), {
      signal: context.signal,
    });
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
    const desktop = await this.box(computer);
    const target = workspacePath(E2B_WORKSPACE, filePath);
    if (options?.maxBytes !== undefined) {
      const info = await desktop.files.getInfo(target, {
        signal: context.signal,
      });
      if (info.size > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    return desktop.files.read(target, {
      format: "bytes",
      signal: context.signal,
    });
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const desktop = await this.box(computer);
    await writeE2BFiles(desktop, [file], context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const desktop = await this.box(computer);
    await stopDesktopBrowsers(desktop);
    try {
      yield* walkE2BWorkspace(desktop, "", context);
    } finally {
      if (context.operationId !== "stop" && context.operationId !== "computer.sleep") {
        await openDesktopBrowser(desktop);
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const desktop = await this.box(computer);
    await stopDesktopBrowsers(desktop);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await writeE2BFiles(desktop, batch, context);
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
    await openDesktopBrowser(desktop);
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    const observation = await this.observe(computer, _context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    const desktop = await this.box(computer);
    try {
      await desktop.setTimeout(sandboxIdleMs());
    } catch (error) {
      // Heartbeats refresh lastTouchedAt; if we swallow a gone error here, box() never
      // reaches its 60s probe and keeps handing back the dead cached handle.
      if (isSandboxGoneError(error)) {
        this.forget(desktop.sandboxId);
        return;
      }
    }
    this.lastTouchedAt.set(desktop.sandboxId, Date.now());
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const screenKey = screenSessionKey(context);
    const desktop = this.boxes.get(id) ?? (await this.box(computer).catch(() => undefined));
    if (!desktop) return;
    const released = await desktop.commands
      .run(releaseExtraDisplayCommand(screenKey, context.screenLeaseId))
      .catch(() => undefined);
    const index = released ? parseReleasedExtraDisplay(released.stdout) : undefined;
    if (index === undefined) return;
    const controlKey = screenControlKey(id, screenKey);
    this.controlStreams.delete(controlKey);
    if (index === 0) {
      if (context.cancelRunWork) {
        await desktop.commands.run(CANCEL_PRIMARY_BROWSER_WORK).catch(() => undefined);
      }
      return;
    }
    // Non-primary teardown runs inside the registry lock before the slot is reusable.
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const pending = Promise.all([
      this.streamStarts.get(id),
      ...[...this.controlStarts]
        .filter(([key]) => key.startsWith(`${id}:`))
        .map(([, start]) => start),
    ]);
    const desktop = this.boxes.get(id);
    this.forget(id);
    await settleForTeardown(pending);
    if (desktop) {
      await desktop.pause().catch(() => undefined);
      return;
    }
    await this.sdk.pause(id, { apiKey: this.apiKey }).catch(() => undefined);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const desktop = this.boxes.get(id) ?? (await this.box(computer).catch(() => undefined));
    const pending = Promise.all([
      this.streamStarts.get(id),
      ...[...this.controlStarts]
        .filter(([key]) => key.startsWith(`${id}:`))
        .map(([, start]) => start),
    ]);
    this.forget(id);
    await settleForTeardown(pending);
    await desktop?.kill();
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.connections.delete(id);
    this.lastTouchedAt.delete(id);
    this.streamStarts.delete(id);
    for (const key of [...this.controlStreams.keys()]) {
      if (key.startsWith(`${id}:`)) this.controlStreams.delete(key);
    }
    for (const key of [...this.controlStarts.keys()]) {
      if (key.startsWith(`${id}:`)) this.controlStarts.delete(key);
    }
  }

  /** Apply the deployment timeout (SDK default is 60s) and return failed results instead of throwing. */
  private async runSetupCommand(
    desktop: Sandbox,
    command: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    try {
      // E2B's outer login shell can fail its logout hook under `set -e`, even after `exit 0`.
      return await desktop.commands.run(`bash -c ${shellQuote(command)}`, {
        ...(signal ? { signal } : {}),
        timeoutMs: boundedSandboxCommandTimeoutMs(undefined),
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        return {
          exitCode: 124,
          stdout: "",
          stderr: error.message,
          error: error.message,
        };
      }
      const result = (error as { result?: CommandResult }).result;
      if (result) return result;
      throw error;
    }
  }

  private async resolveLayout(desktop: Sandbox, screenKey: string, leaseId?: string) {
    const allocation = await this.runSetupCommand(
      desktop,
      allocateExtraDisplayCommand(screenKey, leaseId),
    );
    if (allocation.exitCode !== 0) throw new ComputerScreenUnavailableError();
    const index = parseAllocatedExtraDisplay(allocation.stdout);
    return extraDisplayLayout(index, desktop.display ?? ":0");
  }

  private async ensureExtraDisplay(
    desktop: Sandbox,
    layout: ReturnType<typeof extraDisplayLayout>,
    context: AdapterContext,
  ): Promise<string> {
    if (layout.isPrimary) throw new Error("primary display does not use an extra view password");
    const result = await this.runSetupCommand(
      desktop,
      ensureExtraDisplayCommand(
        layout,
        {
          homeDir: "/home/user",
          browserProfilesDir: E2B_BROWSER_PROFILES,
        },
        randomBytes(9).toString("base64url"),
      ),
      context.signal,
    );
    if (result.exitCode !== 0) throw new ComputerScreenUnavailableError();
    return parseExtraDisplayViewPassword(result.stdout);
  }

  private async startControlStream(
    desktop: Sandbox,
    controlToken: string,
    screenKey: string,
    layout = extraDisplayLayout(0, desktop.display ?? ":0"),
  ): Promise<string> {
    const controlKey = screenControlKey(desktop.sandboxId, screenKey);
    const pending = this.controlStarts.get(controlKey);
    if (pending) {
      await pending;
      return this.startControlStream(desktop, controlToken, screenKey, layout);
    }
    const existing = this.controlStreams.get(controlKey);
    if (existing?.controlToken === controlToken) return existing.password;
    let start!: Promise<string>;
    start = this.initializeControlStream(desktop, controlToken, controlKey, layout).finally(() => {
      if (this.controlStarts.get(controlKey) === start) this.controlStarts.delete(controlKey);
    });
    this.controlStarts.set(controlKey, start);
    return start;
  }

  private async initializeControlStream(
    desktop: Sandbox,
    controlToken: string,
    controlKey: string,
    layout: ReturnType<typeof extraDisplayLayout>,
  ): Promise<string> {
    const password = randomBytes(6).toString("base64url");
    if (layout.isPrimary) {
      const passwordFile = "/tmp/rakazo-control.vncpass";
      const tokenFile = "/tmp/rakazo-control.token";
      const vncPort = layout.controlVncPort;
      const proxyPort = layout.controlPort;
      const command = [
        controlStreamStopCommand(),
        // Old x11vnc may outlive pkill briefly; do not store a new password until the VNC port is free.
        `for i in $(seq 1 50); do netstat -tuln | grep -q ':${vncPort} ' || break; sleep 0.1; done`,
        `if netstat -tuln | grep -q ':${vncPort} '; then exit 1; fi`,
        `printf %s ${shellQuote(controlToken)} > ${tokenFile}`,
        `x11vnc -storepasswd ${shellQuote(password)} ${passwordFile} >/dev/null`,
        `x11vnc -bg -display ${shellQuote(desktop.display)} -forever -wait 50 -shared -rfbport ${vncPort} -rfbauth ${passwordFile} 2>/tmp/rakazo-control-x11vnc.log`,
        // Require the new x11vnc itself — proxy listen alone can pass with a leftover server.
        `for i in $(seq 1 50); do netstat -tuln | grep -q ':${vncPort} ' && break; sleep 0.1; done`,
        `if ! netstat -tuln | grep -q ':${vncPort} '; then exit 1; fi`,
        "cd /opt/noVNC/utils",
        `(nohup ./novnc_proxy --vnc localhost:${vncPort} --listen ${proxyPort} --web /opt/noVNC &) 8>&- >/tmp/rakazo-control-novnc.log 2>&1`,
        `for i in $(seq 1 50); do netstat -tuln | grep -q ':${proxyPort} ' && exit 0; sleep 0.1; done`,
        "exit 1",
      ].join(" && ");
      const result = await this.runSetupCommand(desktop, command);
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr || `control stream failed to start (exit ${result.exitCode})`,
        );
      }
    } else {
      const result = await this.runSetupCommand(
        desktop,
        extraDisplayControlStartCommand(layout, controlToken, password),
      );
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr || `control stream failed to start (exit ${result.exitCode})`,
        );
      }
    }
    if (this.boxes.get(desktop.sandboxId) !== desktop) {
      throw new Error("control stream stopped during computer teardown");
    }
    this.controlStreams.set(controlKey, { password, controlToken });
    return password;
  }

  private async stopControlStream(
    desktop: Sandbox,
    controlToken: string | undefined,
    screenKey: string,
    layout = extraDisplayLayout(0, desktop.display ?? ":0"),
  ): Promise<void> {
    const controlKey = screenControlKey(desktop.sandboxId, screenKey);
    await this.controlStarts.get(controlKey)?.catch(() => undefined);
    if (layout.isPrimary) {
      await desktop.commands.run(controlStreamStopCommand(controlToken));
    } else {
      await desktop.commands.run(extraDisplayControlStopCommand(layout, controlToken));
    }
    const existing = this.controlStreams.get(controlKey);
    if (!controlToken || existing?.controlToken === controlToken) {
      this.controlStreams.delete(controlKey);
    }
  }
}

/** Reuse primary view credentials across API restarts without touching other VNC servers. */
export function ensureE2BPrimaryViewCommand(display: string, password: string): string {
  const passwordFile = "/tmp/rakazo/primary-view.password";
  const authFile = "/tmp/rakazo-primary-view.vncpass";
  return [
    "set -eu",
    "umask 077",
    "mkdir -p /tmp/rakazo",
    "exec 8>/tmp/rakazo/primary-view.lock",
    "flock 8",
    `if [ -s ${passwordFile} ] && [ -s ${authFile} ] && pgrep -f '(^|/)x11vnc .* -viewonly .* -rfbport 5900 -rfbauth ${authFile}( |$)' >/dev/null && (echo >/dev/tcp/127.0.0.1/5900) >/dev/null 2>&1 && (echo >/dev/tcp/127.0.0.1/6080) >/dev/null 2>&1; then printf 'RAKAZO_SCREEN_PASSWORD=%s\\n' "$(cat ${passwordFile})"; exit 0; fi`,
    "pkill -f '(^|/)x11vnc .* -rfbport 5900( |$)' || true",
    `pkill -f '${noVncProxyProcessPattern(6080)}' || true`,
    `pkill -f '${websockifyProcessPattern(6080)}' || true`,
    "for i in $(seq 1 50); do if ! (echo >/dev/tcp/127.0.0.1/5900) >/dev/null 2>&1 && ! (echo >/dev/tcp/127.0.0.1/6080) >/dev/null 2>&1; then break; fi; sleep 0.1; done",
    "if (echo >/dev/tcp/127.0.0.1/5900) >/dev/null 2>&1 || (echo >/dev/tcp/127.0.0.1/6080) >/dev/null 2>&1; then exit 1; fi",
    `if [ -s ${passwordFile} ]; then password=$(cat ${passwordFile}); else password=${shellQuote(password)}; printf %s "$password" >${passwordFile}; fi`,
    `x11vnc -storepasswd "$password" ${authFile} >/dev/null 2>&1`,
    `x11vnc -bg -display ${shellQuote(display)} -forever -wait 50 -shared -viewonly -listen 127.0.0.1 -rfbport 5900 -rfbauth ${authFile} 8>&- >/tmp/rakazo-primary-view-x11vnc.log 2>&1`,
    "cd /opt/noVNC/utils",
    "(nohup ./novnc_proxy --vnc localhost:5900 --listen 6080 --web /opt/noVNC &) 8>&- >/tmp/rakazo-primary-view-novnc.log 2>&1",
    `for i in $(seq 1 50); do if (echo >/dev/tcp/127.0.0.1/5900) >/dev/null 2>&1 && (echo >/dev/tcp/127.0.0.1/6080) >/dev/null 2>&1; then printf 'RAKAZO_SCREEN_PASSWORD=%s\\n' "$password"; exit 0; fi; sleep 0.1; done`,
    "exit 1",
  ].join("\n");
}

async function settleForTeardown(pending: Promise<unknown> | undefined): Promise<void> {
  if (!pending) return;
  await Promise.race([pending.catch(() => undefined), delay(5_000, undefined, { ref: false })]);
}

function controlStreamStopCommand(controlToken?: string) {
  // Anchor to the x11vnc binary (path-prefixed OK). Do not use an unanchored
  // `x11vnc.*` pattern — E2B embeds the full script in the runner argv, so that
  // would pkill the runner itself.
  const stop = [
    "pkill -f '(^|/)x11vnc .* -rfbport 5901' || true",
    `pkill -f '${websockifyProcessPattern(6081)}' || true`,
    `pkill -f '${noVncProxyProcessPattern(6081)}' || true`,
    "rm -f /tmp/rakazo-control.vncpass",
    "rm -f /tmp/rakazo-control.token",
  ].join("; ");
  if (!controlToken) return stop;
  return `[ -f /tmp/rakazo-control.token ] && [ "$(cat /tmp/rakazo-control.token)" != ${shellQuote(controlToken)} ] || { ${stop}; }`;
}

async function observeE2BDesktop(
  desktop: Sandbox,
  context: AdapterContext,
): Promise<ComputerObservation> {
  const [image, size, cursor, windowId] = await Promise.all([
    desktop.screenshot("bytes"),
    desktop.getScreenSize().catch(() => ({ width: 1280, height: 800 })),
    desktop.getCursorPosition().catch(() => undefined),
    desktop.getCurrentWindowId().catch(() => undefined),
  ]);
  if (context.signal.aborted)
    throw context.signal.reason ?? new Error("computer observation aborted");
  const title = windowId
    ? await desktop.getWindowTitle(windowId).catch(() => undefined)
    : undefined;
  return computerObservation(image, {
    mimeType: "image/png",
    width: size.width,
    height: size.height,
    cursor,
    activeWindow: windowId ? { id: windowId, title } : undefined,
  });
}

async function writeE2BFiles(
  desktop: Sandbox,
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

async function configurePortableBrowserProfiles(desktop: Sandbox): Promise<boolean> {
  const chromium = `${E2B_BROWSER_PROFILES}/chromium`;
  const chrome = chromium;
  const firefox = `${E2B_BROWSER_PROFILES}/firefox`;
  const configured = await desktop.commands
    .run(
      [
        `test "$(readlink -f /home/user/.config/google-chrome 2>/dev/null)" = ${shellQuote(chrome)}`,
        `test "$(readlink -f /home/user/.config/chromium 2>/dev/null)" = ${shellQuote(chromium)}`,
        `test "$(readlink -f /home/user/.mozilla 2>/dev/null)" = ${shellQuote(firefox)}`,
      ].join(" && "),
    )
    .then(
      () => true,
      () => false,
    );
  if (configured) return false;
  await stopDesktopBrowsers(desktop);
  await desktop.commands.run(
    [
      `mkdir -p ${shellQuote(chrome)} ${shellQuote(chromium)} ${shellQuote(firefox)} /home/user/.config`,
      "rm -rf /home/user/.config/google-chrome /home/user/.config/chromium /home/user/.mozilla",
      `ln -s ${shellQuote(chrome)} /home/user/.config/google-chrome`,
      `ln -s ${shellQuote(chromium)} /home/user/.config/chromium`,
      `ln -s ${shellQuote(firefox)} /home/user/.mozilla`,
    ].join(" && "),
  );
  return true;
}

/** Point xdg-open / XFCE exo-open at Chrome. Lives outside the checkpointed workspace. */
async function configureDefaultWebBrowser(desktop: Sandbox): Promise<void> {
  await desktop.commands
    .run(
      [
        "command -v google-chrome >/dev/null 2>&1 || exit 0",
        'mkdir -p "$HOME/.config/xfce4"',
        "printf 'WebBrowser=google-chrome\\n' > \"$HOME/.config/xfce4/helpers.rc\"",
        "xdg-settings set default-web-browser google-chrome.desktop",
      ].join(" && "),
    )
    .catch(() => undefined);
}

async function stopDesktopBrowsers(desktop: Sandbox): Promise<void> {
  await desktop.commands.run(PORTABLE_BROWSER_STOP_COMMAND).catch(() => undefined);
}

async function applyE2BAction(desktop: Sandbox, action: ComputerAction): Promise<void> {
  if (action.kind === "key") {
    await desktop.press([...(action.modifiers ?? []), action.key]);
    return;
  }
  if (action.kind === "pointer") {
    if (action.type === "move") await desktop.moveMouse(action.x, action.y);
    else if (action.type === "down") {
      await desktop.moveMouse(action.x, action.y);
      await desktop.mousePress(action.button ?? "left");
    } else if (action.type === "up") {
      await desktop.moveMouse(action.x, action.y);
      await desktop.mouseRelease(action.button ?? "left");
    } else {
      await desktop.moveMouse(action.x, action.y);
      if (action.button === "right") await desktop.rightClick();
      else await desktop.leftClick();
    }
    return;
  }
  if (action.kind === "clipboard") {
    await desktop.write(action.text);
    return;
  }
  if (action.kind === "scroll") {
    await desktop.scroll(action.direction, clampRounded(action.amount ?? 3, 1, 20));
    return;
  }
  if (action.kind === "wait") {
    await desktop.wait(clampRounded(action.ms, 0, 5_000));
    return;
  }
  if (action.kind === "open") {
    if (/^https?:\/\//i.test(action.path)) {
      await openDesktopUrl(desktop, action.path);
      return;
    }
    await desktop.open(workspacePath(E2B_WORKSPACE, action.path));
    return;
  }
  await desktop.launch(action.application, action.uri);
}

async function* walkE2BWorkspace(
  desktop: Sandbox,
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
