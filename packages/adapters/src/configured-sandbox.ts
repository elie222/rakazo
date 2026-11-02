import { createHash } from "node:crypto";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  SecretStore,
  TerminalRequest,
  WorkspaceDirectoryRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork, probeBackgroundWork } from "./computer-idle.js";
import { manageComputerWorkspaceDirectories } from "./computer-workspace.js";
import type { WuyingSandboxOptions } from "./wuying-sandbox.js";

// Wuying and its Alibaba Cloud SDK load only once Settings holds a Wuying connection.
async function createWuyingProvider(settings: StoredWuyingSettings): Promise<SandboxProvider> {
  const { WuyingSandboxProvider } = await import("./wuying-sandbox.js");
  return WuyingSandboxProvider.fromOptions(settings);
}

/**
 * The desktop's power state and a screen login through ECD, and a harmless read through its MCP
 * gateway when the desktop is on.
 */
export async function verifyWuyingConnection(settings: StoredWuyingSettings, signal: AbortSignal) {
  const [{ WuyingOpenApi }, { WuyingMcpTools }] = await Promise.all([
    import("./wuying-openapi.js"),
    import("./wuying-sandbox.js"),
  ]);
  const control = new WuyingOpenApi(settings);
  const status = await control.desktopStatus(settings.desktopId, signal);
  if (status === null)
    throw new Error(`Wuying does not list this desktop in ${settings.regionId} for the AccessKey`);
  await control.authCode(settings.endUserId, signal);
  if (status !== "Running") return;
  const tools = new WuyingMcpTools({ url: settings.mcpUrl, token: settings.mcpToken });
  await tools.call("env_get", { name: "USERPROFILE" }, signal);
}

/** Reads the Settings choice again in this process, as right after an admin saved it. */
export async function refreshComputerProvider(sandbox: SandboxProvider) {
  if (sandbox instanceof ConfiguredSandbox) await sandbox.refresh();
}

/** How long a read of the Settings choice is reused before the next call reads it again. */
const SETTINGS_TTL_MS = 10_000;

/** Cached reads of computers' own desktops, and live Wuying providers, kept at most. */
const CACHE_LIMIT = 1_000;

/** Secret kind holding the Wuying desktop an account saved for its own Team Computers. */
export const ACCOUNT_WUYING_SECRET_KIND = "wuying-computer";

/** The Wuying connection saved in Settings, as stored inside its secret. */
export type StoredWuyingSettings = Omit<WuyingSandboxOptions, "regionId"> & { regionId: string };

export interface ComputerProviderSelection {
  /** True when Settings sends new computers to Wuying. */
  wuying: boolean;
  /** The saved connection, kept after switching back so existing Wuying computers still work. */
  settings: StoredWuyingSettings | null;
}

export function parseStoredWuyingSettings(plaintext: string): StoredWuyingSettings | null {
  try {
    const value = JSON.parse(plaintext) as Record<string, unknown>;
    const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
    const settings = {
      accessKeyId: text("accessKeyId"),
      accessKeySecret: text("accessKeySecret"),
      regionId: text("regionId") || "cn-hangzhou",
      desktopId: text("desktopId"),
      endUserId: text("endUserId"),
      mcpUrl: text("mcpUrl"),
      mcpToken: text("mcpToken"),
    };
    return Object.values(settings).every(Boolean) ? settings : null;
  } catch {
    return null;
  }
}

/** Reads the Settings choice and its decrypted Wuying connection. */
export async function loadComputerProviderSelection(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
): Promise<ComputerProviderSelection> {
  const row = await runAsSystem("read the deployment's computer provider", async () => {
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { computerProvider: true, computerProviderSecretId: true },
    });
    const secret = settings?.computerProviderSecretId
      ? await prisma.secret.findUnique({
          where: { id: settings.computerProviderSecretId },
          select: { id: true, ciphertext: true },
        })
      : null;
    return { provider: settings?.computerProvider ?? null, secret };
  });
  const settings = row.secret ? await decryptWuyingSettings(secrets, row.secret) : null;
  return { wuying: row.provider === "wuying" && settings !== null, settings };
}

async function decryptWuyingSettings(
  secrets: Pick<SecretStore, "load">,
  secret: { id: string; ciphertext: string },
) {
  try {
    return parseStoredWuyingSettings(await secrets.load(secret.ciphertext, secret.id));
  } catch (error) {
    // A connection that no longer decrypts, as after a key change, waits to be saved again
    // rather than fail every computer.
    getLogger().warn("computer_provider.settings_unreadable", { error });
    return null;
  }
}

/** The Wuying desktop an account saved for itself, or null when it uses the deployment's. */
export async function loadAccountWuyingSettings(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  userId: string,
): Promise<StoredWuyingSettings | null> {
  const secret = await runAsSystem("read an account's own Wuying desktop", () =>
    prisma.secret.findFirst({
      where: { userId, spaceId: null, kind: ACCOUNT_WUYING_SECRET_KIND },
      orderBy: { createdAt: "desc" },
      select: { id: true, ciphertext: true },
    }),
  );
  return secret ? decryptWuyingSettings(secrets, secret) : null;
}

/** The Wuying desktop a Team Computer's owner saved for it, by the computer's home key. */
export async function loadComputerOwnerWuyingSettings(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  homeKey: string,
): Promise<StoredWuyingSettings | null> {
  const computer = await runAsSystem("read whose computer runs on which desktop", () =>
    prisma.computer.findUnique({ where: { homeKey }, select: { userId: true, scope: true } }),
  );
  // Private Computers stay on the deployment's provider; Wuying runs Team Computers only.
  return computer?.scope === "team"
    ? loadAccountWuyingSettings(prisma, secrets, computer.userId)
    : null;
}

/** An account's own desktop and the provider that reaches it. */
type OwnDesktop = { desktopId: string; provider: SandboxProvider };

function connectionKey(settings: StoredWuyingSettings) {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

/** Adds to a bounded cache, dropping the oldest entry once it is full. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as K);
}

/**
 * Sends new computers to the provider chosen in Settings, or to the Wuying desktop their owner
 * saved for themselves, and every existing computer to the provider it already runs on, so
 * switching never strands a computer that is already running.
 */
export class ConfiguredSandbox implements SandboxProvider {
  readonly pageBrowser?: SandboxProvider["pageBrowser"];
  private selection: ComputerProviderSelection = { wuying: false, settings: null };
  private loadedAt = 0;
  private loading?: Promise<void>;
  private wuying?: { key: string; provider: SandboxProvider };
  /** Wuying providers by connection, shared by every computer on the same desktop. */
  private readonly providers = new Map<string, Promise<SandboxProvider>>();
  /** Each computer's owner's own desktop, by home key, read at most every SETTINGS_TTL_MS. */
  private readonly own = new Map<string, { at: number; desktop: Promise<OwnDesktop | null> }>();
  private readonly loadOwn: (homeKey: string) => Promise<StoredWuyingSettings | null>;
  private readonly createWuying: (settings: StoredWuyingSettings) => Promise<SandboxProvider>;

  constructor(
    private readonly primary: SandboxProvider,
    private readonly load: () => Promise<ComputerProviderSelection>,
    options: {
      /** The Wuying desktop a computer's owner saved for it, by its home key. */
      loadOwn?: (homeKey: string) => Promise<StoredWuyingSettings | null>;
      createWuying?: (settings: StoredWuyingSettings) => Promise<SandboxProvider>;
    } = {},
  ) {
    this.loadOwn = options.loadOwn ?? (async () => null);
    this.createWuying = options.createWuying ?? createWuyingProvider;
    if (primary.pageBrowser) {
      this.pageBrowser = (computer, request, context) =>
        computer.kind === "wuying"
          ? Promise.resolve({
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            })
          : primary.pageBrowser!(computer, request, context);
    }
    void this.refresh().catch(() => undefined);
  }

  /** Reads the Settings choices again now, as after one was saved. */
  async refresh() {
    this.own.clear();
    this.loading ??= this.load()
      .then(async (selection) => {
        // Ready before the selection is, so every synchronous read sees a loaded provider.
        await this.loadWuying(selection.settings);
        this.selection = selection;
        this.loadedAt = Date.now();
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  private async current() {
    if (Date.now() - this.loadedAt >= SETTINGS_TTL_MS) await this.refresh();
    return this.selection;
  }

  private async loadWuying(settings: StoredWuyingSettings | null) {
    if (!settings) return;
    const key = connectionKey(settings);
    if (this.wuying?.key !== key) this.wuying = { key, provider: await this.providerFor(settings) };
  }

  private providerFor(settings: StoredWuyingSettings) {
    const key = connectionKey(settings);
    const cached = this.providers.get(key);
    if (cached) return cached;
    const provider = this.createWuying(settings);
    remember(this.providers, key, provider);
    provider.catch(() => {
      if (this.providers.get(key) === provider) this.providers.delete(key);
    });
    return provider;
  }

  private ownDesktop(homeKey: string) {
    const cached = this.own.get(homeKey);
    if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.desktop;
    const desktop = this.loadOwn(homeKey).then(async (settings) =>
      settings
        ? { desktopId: settings.desktopId, provider: await this.providerFor(settings) }
        : null,
    );
    remember(this.own, homeKey, { at: Date.now(), desktop });
    desktop.catch(() => {
      if (this.own.get(homeKey)?.desktop === desktop) this.own.delete(homeKey);
    });
    return desktop;
  }

  private wuyingProvider(settings: StoredWuyingSettings | null) {
    return settings ? this.wuying?.provider : undefined;
  }

  /** The provider that owns an existing computer. */
  private async route(computer: Pick<ComputerRef, "kind" | "botId" | "providerRef">) {
    if (computer.kind !== "wuying") return this.primary;
    // A computer stays on the desktop it runs on until it starts again.
    const own = await this.ownDesktop(computer.botId);
    if (own?.desktopId === computer.providerRef) return own.provider;
    return this.wuyingProvider((await this.current()).settings) ?? this.primary;
  }

  /** The provider a computer goes to when it starts. */
  private async target(homeKey?: string) {
    const own = homeKey ? await this.ownDesktop(homeKey) : null;
    if (own) return own.provider;
    const selection = await this.current();
    return (selection.wuying && this.wuyingProvider(selection.settings)) || this.primary;
  }

  describe() {
    const selection = this.selection;
    return (
      (selection.wuying && this.wuyingProvider(selection.settings)) ||
      this.primary
    ).describe();
  }

  async provisionKind(homeKey?: string): Promise<ComputerRef["kind"]> {
    const target = await this.target(homeKey);
    if (target !== this.primary) return target.describe().id as ComputerRef["kind"];
    return (
      (await this.primary.provisionKind?.(homeKey)) ??
      (this.primary.describe().id as ComputerRef["kind"])
    );
  }

  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const target = await this.target(request.botId);
    const kind = target.describe().id;
    // A reference from the other provider means nothing to this one.
    const providerRef =
      target === this.primary
        ? request.providerKind === "wuying"
          ? undefined
          : request.providerRef
        : request.providerKind === kind
          ? request.providerRef
          : undefined;
    return target.provision({ ...request, providerRef }, context);
  }

  async isRunning(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).isRunning?.(computer, context) ?? false;
  }

  async isStopped(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).isStopped?.(computer, context) ?? false;
  }

  async hasMountedHome(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).hasMountedHome?.(computer, context) ?? false;
  }

  async environment(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).environment?.(computer, context);
  }

  async workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    return manageComputerWorkspaceDirectories(
      await this.route(computer),
      computer,
      request,
      context,
    );
  }

  async prepare(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* (await this.route(computer)).execute(computer, request, context);
  }

  async cancelRunWork(
    computer: ComputerRef,
    computerId: string,
    runId: string,
    context: AdapterContext,
  ) {
    return cancelComputerRunWork(await this.route(computer), computer, computerId, runId, context);
  }

  async inspectBackgroundWork(computer: ComputerRef, markerId: string, context: AdapterContext) {
    const provider = await this.route(computer);
    return provider.inspectBackgroundWork
      ? provider.inspectBackgroundWork(computer, markerId, context)
      : probeBackgroundWork(provider, computer, markerId, context);
  }

  async connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return (await this.route(computer)).connectScreen(computer, request, context);
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const provider = await this.route(computer);
    if (!provider.connectTerminal) throw new Error("terminal is unavailable on this computer");
    return provider.connectTerminal(computer, request, context);
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    await (await this.route(computer)).setScreenControl?.(
      computer,
      interactive,
      context,
      controlToken,
    );
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return (await this.route(computer)).sendInput(computer, input, lease, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).observe(computer, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return (await this.route(computer)).act(computer, request, context);
  }

  async listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return (await this.route(computer)).listFiles(computer, path, context);
  }

  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return (await this.route(computer)).readFile(computer, path, context, options);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return (await this.route(computer)).writeFile(computer, file, context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ) {
    yield* (await this.route(computer)).exportWorkspace(computer, context, limits);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return (await this.route(computer)).importWorkspace(computer, files, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).snapshot(computer, context);
  }

  billsWhileRunning(computer: ComputerRef): boolean {
    if (computer.kind === "wuying") return true;
    return this.primary.billsWhileRunning?.(computer) ?? false;
  }

  async keepAlive(computer: ComputerRef) {
    await (await this.route(computer)).keepAlive?.(computer);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    await (await this.route(computer)).releaseScreen?.(computer, context);
  }

  async stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { discardUnsaved?: boolean },
  ) {
    return (await this.route(computer)).stop(computer, context, options);
  }

  async destroy(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).destroy(computer, context);
  }
}
