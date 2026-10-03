import type { DurableMemoryScope, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { EncryptedSecretStore } from "./secrets.js";
import {
  classifySerenityConnectionSettings,
  createSerenityProvider,
  prepareSerenityConnection,
  SERENITY_PROVIDER_ID,
  serenityRequiresDeploymentOwner,
} from "./serenity-memory-provider.js";

export { MemoryProviderDeploymentOwnerRequiredError } from "./serenity-memory-provider.js";

import {
  assertSupermemoryLocalBaseUrl,
  createSupermemoryProvider,
  decodeLegacySupermemoryCredentials,
  prepareSupermemoryConnection,
  SUPERMEMORY_PROVIDER_ID,
  supermemoryRequiresDeploymentOwner,
} from "./supermemory-memory-provider.js";

export interface MemoryProviderConnectionInput {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
  /** When false, Serenity must not probe endpoints that classify as private. */
  allowPrivateEndpoint?: boolean;
}

export interface PreparedMemoryProviderConnection {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
}

export interface ConfiguredMemoryProvider {
  provider: SemanticMemoryProvider;
  defaultScope: DurableMemoryScope;
}

export interface MemoryProviderResolver {
  resolve(spaceId: string): Promise<ConfiguredMemoryProvider | null>;
}

interface MemoryProviderAdapter {
  requiresDeploymentOwner(settings: Record<string, string>): boolean;
  /** Async trust classification (e.g. DNS) without probing credentials. */
  classifySettings?(settings: Record<string, string>): Promise<Record<string, string>>;
  prepare(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    options?: { allowPrivateEndpoint?: boolean },
  ): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }>;
  create(
    settings: Record<string, string>,
    credentials: Record<string, string>,
  ): SemanticMemoryProvider;
  decodeLegacyCredentials?(plaintext: string): Record<string, string> | null;
}

const MEMORY_PROVIDER_ADAPTERS: ReadonlyMap<string, MemoryProviderAdapter> = new Map([
  [
    SUPERMEMORY_PROVIDER_ID,
    {
      requiresDeploymentOwner: supermemoryRequiresDeploymentOwner,
      prepare: prepareSupermemoryConnection,
      create: createSupermemoryProvider,
      decodeLegacyCredentials: decodeLegacySupermemoryCredentials,
    },
  ],
  [
    SERENITY_PROVIDER_ID,
    {
      requiresDeploymentOwner: serenityRequiresDeploymentOwner,
      classifySettings: classifySerenityConnectionSettings,
      prepare: (
        settings: Record<string, string>,
        credentials: Record<string, string>,
        options?: { allowPrivateEndpoint?: boolean },
      ) => prepareSerenityConnection(settings, credentials, undefined, options),
      create: createSerenityProvider,
    },
  ],
]);

function memoryProviderAdapter(provider: string): MemoryProviderAdapter {
  const adapter = MEMORY_PROVIDER_ADAPTERS.get(provider);
  if (!adapter) throw new Error(`Unknown memory provider "${provider}".`);
  return adapter;
}

/** Adapters classify their settings; callers enforce the deployment trust boundary. */
export function memoryProviderRequiresDeploymentOwner(
  provider: string,
  settings: Record<string, string>,
): boolean {
  return memoryProviderAdapter(provider).requiresDeploymentOwner(settings);
}

/**
 * Run provider-specific trust classification (DNS, etc.) without credentialed probes.
 * Callers must authorize deployment-owner endpoints before prepare/probe.
 */
export async function classifyMemoryProviderSettings(
  provider: string,
  settings: Record<string, string>,
): Promise<Record<string, string>> {
  const adapter = memoryProviderAdapter(provider);
  return adapter.classifySettings ? adapter.classifySettings(settings) : settings;
}

export async function prepareMemoryProviderConnection(
  input: MemoryProviderConnectionInput,
): Promise<PreparedMemoryProviderConnection> {
  const prepared = await memoryProviderAdapter(input.provider).prepare(
    input.settings,
    input.credentials,
    { allowPrivateEndpoint: input.allowPrivateEndpoint },
  );
  return { provider: input.provider, ...prepared };
}

export function createMemoryProvider(
  provider: string,
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  return memoryProviderAdapter(provider).create(settings, credentials);
}

export function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function decodeCredentials(provider: string, plaintext: string): Record<string, string> {
  try {
    const credentials = toStringRecord(JSON.parse(plaintext));
    if (Object.keys(credentials).length > 0) return credentials;
  } catch {
    // Configurations created before the generic provider boundary stored the API key directly.
  }
  const legacyCredentials = memoryProviderAdapter(provider).decodeLegacyCredentials?.(plaintext);
  if (legacyCredentials) return legacyCredentials;
  throw new Error(`Stored credentials for memory provider "${provider}" are invalid.`);
}

export class SpaceMemoryProviderResolver implements MemoryProviderResolver {
  constructor(
    private readonly prisma: Pick<PrismaClient, "spaceMemoryConfig" | "deploymentSettings">,
    private readonly secrets: EncryptedSecretStore,
  ) {}

  async resolve(spaceId: string): Promise<ConfiguredMemoryProvider | null> {
    const config = await this.prisma.spaceMemoryConfig.findUnique({
      where: { spaceId },
      include: { secret: true },
    });
    if (!config) return null;
    const settings = toStringRecord(config.settings);
    if (memoryProviderRequiresDeploymentOwner(config.provider, settings)) {
      const deployment = await this.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { ownerUserId: true },
      });
      // Also disable pre-existing local configurations authored outside the deployment boundary.
      if (!deployment?.ownerUserId || deployment.ownerUserId !== config.userId) return null;
    }
    if (
      config.provider === SUPERMEMORY_PROVIDER_ID &&
      settings.mode === "local" &&
      settings.baseUrl
    ) {
      await assertSupermemoryLocalBaseUrl(settings.baseUrl, { allowPrivateEndpoint: true });
    }
    const credentials = decodeCredentials(
      config.provider,
      this.secrets.load(config.secret.ciphertext, config.secret.id),
    );
    return {
      provider: createMemoryProvider(config.provider, settings, credentials),
      defaultScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
    };
  }
}
