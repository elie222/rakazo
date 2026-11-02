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
import { cancelComputerRunWork, probeBackgroundWork } from "./computer-idle.js";
import {
  computerProviderDescriptor,
  computerProviderRegistry,
} from "./computer-provider-registry.js";
import { manageComputerWorkspaceDirectories } from "./computer-workspace.js";
import { credentialDigest } from "./credential-digest.js";
import { createSandboxProvider } from "./sandbox-factory.js";

export const COMPUTER_PROVIDER_SECRET_KIND = "computer-provider";
export interface StoredComputerSettings {
  provider: string;
  values: Record<string, string>;
  /** Retain other deployment connections for computers already running there. */
  connections?: Record<string, Record<string, string>>;
  /** Ciphertext identifies a credential version without retaining another plaintext copy. */
  ciphertext?: string;
}
export interface ComputerProviderSelection {
  provider: string;
  settings: StoredComputerSettings | null;
}
export function parseStoredComputerSettings(plaintext: string): StoredComputerSettings | null {
  try {
    const value = JSON.parse(plaintext);
    if (
      typeof value.provider !== "string" ||
      !value.values ||
      typeof value.values !== "object" ||
      Array.isArray(value.values) ||
      Object.values(value.values).some((v) => typeof v !== "string")
    )
      return null;
    computerProviderDescriptor(value.provider).verify(value.values);
    const connections: Record<string, Record<string, string>> = {};
    if (value.connections) {
      for (const [id, values] of Object.entries(value.connections)) {
        if (
          !values ||
          typeof values !== "object" ||
          Array.isArray(values) ||
          Object.values(values).some((entry) => typeof entry !== "string")
        )
          return null;
        computerProviderDescriptor(id).verify(values as Record<string, string>);
        connections[id] = values as Record<string, string>;
      }
    }
    return {
      provider: value.provider,
      values: value.values,
      ...(Object.keys(connections).length ? { connections } : {}),
    };
  } catch {
    return null;
  }
}
async function decryptSettings(
  secrets: Pick<SecretStore, "load">,
  secret: { id: string; ciphertext: string },
) {
  try {
    const settings = parseStoredComputerSettings(await secrets.load(secret.ciphertext, secret.id));
    return settings ? { ...settings, ciphertext: secret.ciphertext } : null;
  } catch {
    return null;
  }
}
export function computerSettingsForProvider(
  settings: StoredComputerSettings | null,
  provider: string,
): StoredComputerSettings | null {
  if (!settings) return null;
  const values =
    settings.provider === provider ? settings.values : settings.connections?.[provider];
  return values ? { provider, values, ciphertext: settings.ciphertext } : null;
}
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
    return { provider: settings?.computerProvider ?? "default", secret };
  });
  const settings = row.secret ? await decryptSettings(secrets, row.secret) : null;
  return {
    provider: settings && settings.provider === row.provider ? row.provider : "default",
    settings,
  };
}
export async function loadAccountComputerSettings(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  userId: string,
) {
  const secret = await runAsSystem("read account computer settings", () =>
    prisma.secret.findFirst({
      where: { userId, spaceId: null, kind: COMPUTER_PROVIDER_SECRET_KIND },
      orderBy: { createdAt: "desc" },
      select: { id: true, ciphertext: true },
    }),
  );
  const settings = secret ? await decryptSettings(secrets, secret) : null;
  return settings && computerProviderDescriptor(settings.provider).capabilities.perAccount
    ? settings
    : null;
}
export async function loadComputerOwnerSettings(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  homeKey: string,
) {
  const computer = await runAsSystem("read computer owner", () =>
    prisma.computer.findUnique({ where: { homeKey }, select: { userId: true, scope: true } }),
  );
  return computer?.scope === "team"
    ? loadAccountComputerSettings(prisma, secrets, computer.userId)
    : null;
}
export async function refreshComputerProvider(sandbox: SandboxProvider) {
  if (sandbox instanceof ConfiguredSandbox) await sandbox.refresh();
}

/** Resolve settings per operation; retain only the adapter for each current ciphertext. */
export class ConfiguredSandbox implements SandboxProvider {
  readonly pageBrowser: NonNullable<SandboxProvider["pageBrowser"]>;
  private selection: ComputerProviderSelection = { provider: "default", settings: null };
  private selected?: SandboxProvider;
  private readonly providers = new Map<
    string,
    {
      ciphertext: string;
      digest: string;
      provider: Promise<SandboxProvider>;
      resolved?: SandboxProvider;
    }
  >();
  constructor(
    private readonly primary: SandboxProvider,
    private readonly load: () => Promise<ComputerProviderSelection>,
    private readonly options: {
      loadOwn?: (homeKey: string) => Promise<StoredComputerSettings | null>;
      onSecretChange?: SecretStore["onChange"];
      createProvider?: (settings: StoredComputerSettings) => Promise<SandboxProvider>;
    } = {},
  ) {
    options.onSecretChange?.((ref) => {
      for (const [key, entry] of this.providers)
        if (entry.ciphertext === ref) this.providers.delete(key);
    });
    this.pageBrowser = async (computer, request, context) => {
      const provider = await this.route(computer);
      return provider.pageBrowser
        ? provider.pageBrowser(computer, request, context)
        : {
            ok: false,
            uncertain: false,
            fallback: "computer_act",
            error: "Page browser is unavailable on this computer.",
          };
    };
  }
  async refresh() {
    const selection = await this.load();
    this.selected = selection.settings
      ? await this.providerFor(selection.settings, "deployment")
      : undefined;
    if (!selection.settings) this.forgetOwner("deployment");
    this.selection = selection;
  }
  private forgetOwner(owner: string) {
    for (const key of this.providers.keys())
      if (key.startsWith(`${owner}:`)) this.providers.delete(key);
  }
  private providerFor(settings: StoredComputerSettings, owner: string) {
    const ciphertext = settings.ciphertext ?? credentialDigest(JSON.stringify(settings));
    const digest = credentialDigest(JSON.stringify(settings.values));
    const cached = this.providers.get(`${owner}:${settings.provider}`);
    if (cached?.ciphertext === ciphertext && cached.digest === digest) return cached.provider;
    const provider = this.options.createProvider
      ? this.options.createProvider(settings)
      : createSandboxProvider(
          settings.provider,
          computerProviderDescriptor(settings.provider).verify(settings.values),
        );
    this.providers.delete(`${owner}:${settings.provider}`);
    this.providers.set(`${owner}:${settings.provider}`, { ciphertext, digest, provider });
    if (this.providers.size > 1000) this.providers.delete(this.providers.keys().next().value!);
    provider.catch(() => {
      if (this.providers.get(`${owner}:${settings.provider}`)?.provider === provider)
        this.providers.delete(`${owner}:${settings.provider}`);
    });
    void provider.then(
      (resolved) => {
        const entry = this.providers.get(`${owner}:${settings.provider}`);
        if (entry?.provider === provider) Object.assign(entry, { resolved });
      },
      () => {},
    );
    return provider;
  }
  private async ownSettings(homeKey: string) {
    const settings = (await this.options.loadOwn?.(homeKey)) ?? null;
    if (!settings) this.forgetOwner(homeKey);
    return settings;
  }
  private async route(computer: Pick<ComputerRef, "kind" | "botId" | "providerRef">) {
    const own = await this.ownSettings(computer.botId);
    if (own?.provider === computer.kind) {
      const provider = await this.providerFor(own, computer.botId);
      if (provider.ownsReference?.(computer) ?? true) return provider;
    }
    await this.refresh();
    const saved = computerSettingsForProvider(this.selection.settings, computer.kind);
    if (saved) {
      const provider = await this.providerFor(saved, "deployment");
      if (provider.ownsReference?.(computer) ?? true) return provider;
    }
    // Kinds Settings never selects (a local host computer, say) can only belong to the primary.
    const settingsKind = computerProviderRegistry.some((entry) => entry.id === computer.kind);
    const primaryKind =
      (await this.primary.provisionKind?.(computer.botId)) ?? this.primary.describe().id;
    if (
      (!settingsKind || computer.kind === primaryKind) &&
      (this.primary.ownsReference?.(computer) ?? true)
    )
      return this.primary;
    throw new Error("The computer's provider connection is no longer configured");
  }
  private async target(homeKey?: string) {
    const own = homeKey ? await this.ownSettings(homeKey) : null;
    if (own) return this.providerFor(own, homeKey!);
    await this.refresh();
    return this.selection.provider !== "default" && this.selected ? this.selected : this.primary;
  }
  describe() {
    return (
      this.selection.provider !== "default" && this.selected ? this.selected : this.primary
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
    const expectedKind = (await target.provisionKind?.(request.botId)) ?? kind;
    const providerRef = request.providerKind === expectedKind ? request.providerRef : undefined;
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
    if (computer.kind === this.primary.describe().id)
      return this.primary.billsWhileRunning?.(computer) ?? false;
    for (const entry of this.providers.values()) {
      if (entry.resolved?.describe().id === computer.kind)
        return entry.resolved.billsWhileRunning?.(computer) ?? false;
    }
    // An unresolved or invalidated remote connection must not disable idle shutdown.
    return true;
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
