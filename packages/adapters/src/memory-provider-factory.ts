import type { DurableMemoryScope, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { EncryptedSecretStore } from "./secrets.js";
import {
  createSupermemoryProvider,
  decodeLegacySupermemoryCredentials,
  prepareSupermemoryConnection,
  SUPERMEMORY_PROVIDER_ID,
} from "./supermemory-memory-provider.js";

export interface MemoryProviderConnectionInput {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
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
  resolve(workspaceId: string): Promise<ConfiguredMemoryProvider | null>;
}

interface MemoryProviderAdapter {
  prepare(
    settings: Record<string, string>,
    credentials: Record<string, string>,
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
      prepare: prepareSupermemoryConnection,
      create: createSupermemoryProvider,
      decodeLegacyCredentials: decodeLegacySupermemoryCredentials,
    },
  ],
]);

function memoryProviderAdapter(provider: string): MemoryProviderAdapter {
  const adapter = MEMORY_PROVIDER_ADAPTERS.get(provider);
  if (!adapter) throw new Error(`Unknown memory provider "${provider}".`);
  return adapter;
}

export async function prepareMemoryProviderConnection(
  input: MemoryProviderConnectionInput,
): Promise<PreparedMemoryProviderConnection> {
  const prepared = await memoryProviderAdapter(input.provider).prepare(
    input.settings,
    input.credentials,
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

export class WorkspaceMemoryProviderResolver implements MemoryProviderResolver {
  constructor(
    private readonly prisma: Pick<PrismaClient, "workspaceMemoryConfig">,
    private readonly secrets: EncryptedSecretStore,
  ) {}

  async resolve(workspaceId: string): Promise<ConfiguredMemoryProvider | null> {
    const config = await this.prisma.workspaceMemoryConfig.findUnique({
      where: { workspaceId },
      include: { secret: true },
    });
    if (!config) return null;
    const credentials = decodeCredentials(
      config.provider,
      this.secrets.load(config.secret.ciphertext, config.secret.id),
    );
    return {
      provider: createMemoryProvider(config.provider, toStringRecord(config.settings), credentials),
      defaultScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
    };
  }
}
