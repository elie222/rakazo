import type { DurableMemoryScope, SecretStore, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  createHonchoProvider,
  HONCHO_PROVIDER_ID,
  honchoRequiresPrivateEndpoint,
  prepareHonchoConnection,
} from "./honcho-memory-provider.js";
import { revalidateLocalServiceSettings } from "./local-service-endpoint.js";

export { MemoryProviderPrivateEndpointRequiredError } from "./local-service-endpoint.js";

export interface MemoryProviderConnectionInput {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
  /** When false, providers must not probe endpoints that classify as private. */
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
  requiresPrivateEndpoint(settings: Record<string, string>): boolean;
  /** Recheck persisted endpoint settings before their credentials are decrypted. */
  revalidate?(settings: Record<string, string>): Promise<void>;
  prepare(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    options?: { allowPrivateEndpoint?: boolean },
  ): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }>;
  create(
    settings: Record<string, string>,
    credentials: Record<string, string>,
  ): SemanticMemoryProvider;
}

const MEMORY_PROVIDER_ADAPTERS: ReadonlyMap<string, MemoryProviderAdapter> = new Map([
  [
    HONCHO_PROVIDER_ID,
    {
      requiresPrivateEndpoint: honchoRequiresPrivateEndpoint,
      revalidate: revalidateLocalServiceSettings,
      prepare: prepareHonchoConnection,
      create: createHonchoProvider,
    },
  ],
]);

function memoryProviderAdapter(provider: string): MemoryProviderAdapter {
  const adapter = MEMORY_PROVIDER_ADAPTERS.get(provider);
  if (!adapter) throw new Error(`Unknown memory provider "${provider}".`);
  return adapter;
}

/** Adapters classify their settings; callers enforce the deployment trust boundary. */
export function memoryProviderRequiresPrivateEndpoint(
  provider: string,
  settings: Record<string, string>,
): boolean {
  return memoryProviderAdapter(provider).requiresPrivateEndpoint(settings);
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
    // Fall through to the invalid-credentials error below.
  }
  throw new Error(`Stored credentials for memory provider "${provider}" are invalid.`);
}

export class SpaceMemoryProviderResolver implements MemoryProviderResolver {
  constructor(
    private readonly prisma: Pick<PrismaClient, "spaceMemoryConfig">,
    private readonly secrets: SecretStore,
  ) {}

  async resolve(spaceId: string): Promise<ConfiguredMemoryProvider | null> {
    const config = await this.prisma.spaceMemoryConfig.findUnique({
      where: { spaceId },
      include: { secret: true },
    });
    if (!config) return null;
    const adapter = MEMORY_PROVIDER_ADAPTERS.get(config.provider);
    if (!adapter) {
      // A provider removed from this build leaves its saved row behind; treat it as unconfigured.
      getLogger().warn("Semantic memory disabled: stored provider is not available in this build");
      return null;
    }
    const settings = toStringRecord(config.settings);
    if (adapter.requiresPrivateEndpoint(settings)) {
      // Saved configurations cannot bypass an operator's current network policy.
      if (process.env.MCP_ALLOW_PRIVATE_ENDPOINT !== "true") return null;
    }
    try {
      await adapter.revalidate?.(settings);
    } catch {
      getLogger().warn("Semantic memory disabled: endpoint revalidation failed");
      return null;
    }
    const credentials = decodeCredentials(
      config.provider,
      await this.secrets.load(config.secret.ciphertext, config.secret.id),
    );
    return {
      provider: adapter.create(settings, credentials),
      defaultScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
    };
  }
}
