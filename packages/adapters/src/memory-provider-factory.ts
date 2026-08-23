import type { DurableMemoryScope, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { EncryptedSecretStore } from "./secrets.js";
import {
  SUPERMEMORY_CLOUD_BASE_URL,
  SUPERMEMORY_PROVIDER_ID,
  SupermemoryMemoryProvider,
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

function isLoopbackBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function requiredValue(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export async function prepareMemoryProviderConnection(
  input: MemoryProviderConnectionInput,
): Promise<PreparedMemoryProviderConnection> {
  if (input.provider !== SUPERMEMORY_PROVIDER_ID) {
    throw new Error(`Unknown memory provider "${input.provider}".`);
  }
  if (input.settings.mode !== "cloud" && input.settings.mode !== "local") {
    throw new Error("mode must be cloud or local");
  }
  const mode = input.settings.mode;
  const apiKey = requiredValue(input.credentials, "apiKey");
  if (apiKey.length < 8) throw new Error("apiKey must contain at least 8 characters");
  const baseUrl =
    mode === "cloud" ? SUPERMEMORY_CLOUD_BASE_URL : requiredValue(input.settings, "baseUrl");
  if (mode === "local" && !isLoopbackBaseUrl(baseUrl)) {
    throw new Error("Local mode requires a loopback address (localhost, 127.0.0.1, or ::1).");
  }
  const probe = await SupermemoryMemoryProvider.probe({ baseUrl, apiKey });
  if (!probe.ok) throw new Error(probe.error);
  return { provider: input.provider, settings: { mode, baseUrl }, credentials: { apiKey } };
}

export function createMemoryProvider(
  provider: string,
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  if (provider === SUPERMEMORY_PROVIDER_ID) {
    return new SupermemoryMemoryProvider({
      baseUrl: requiredValue(settings, "baseUrl"),
      apiKey: requiredValue(credentials, "apiKey"),
    });
  }
  throw new Error(`Unknown memory provider "${provider}".`);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function decodeCredentials(provider: string, plaintext: string): Record<string, string> {
  try {
    const credentials = stringRecord(JSON.parse(plaintext));
    if (Object.keys(credentials).length > 0) return credentials;
  } catch {
    // Configurations created before the generic provider boundary stored the API key directly.
  }
  if (provider === SUPERMEMORY_PROVIDER_ID && plaintext.trim()) {
    return { apiKey: plaintext };
  }
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
      this.secrets.load(config.secret.ciphertext),
    );
    return {
      provider: createMemoryProvider(config.provider, stringRecord(config.settings), credentials),
      defaultScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
    };
  }
}
