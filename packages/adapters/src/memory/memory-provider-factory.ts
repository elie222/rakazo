import type { DurableMemoryScope, SecretStore, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { MemoryProviderDescriptor } from "@rakazo/contracts";
import { settingsFieldProblem, visibleSettingsFields } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MemoryProviderDefinition } from "./memory-provider-descriptor.js";
import { knownMemoryProvider, memoryProviders } from "./memory-providers.js";

export { MemoryProviderPrivateEndpointRequiredError } from "../providers/memory/serenity/serenity-memory-provider.js";

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

function memoryProviderAdapter(provider: string): MemoryProviderDefinition {
  const adapter = knownMemoryProvider(provider);
  if (!adapter) throw new Error(`Unknown memory provider "${provider}".`);
  return adapter;
}

/** Every provider's settings form, in the order a Space picks from; the first is offered first. */
export function memoryProviderDescriptors(): MemoryProviderDescriptor[] {
  return Object.entries(memoryProviders).map(
    ([
      id,
      {
        settings: { displayName, fields },
      },
    ]) => ({
      id,
      displayName,
      fields,
    }),
  );
}

/** One line naming a saved connection, or nothing for a provider this build does not have. */
export function memoryProviderConnectionLabel(
  provider: string,
  settings: Record<string, string>,
): string | undefined {
  return knownMemoryProvider(provider)?.settings.connectionLabel(settings);
}

/**
 * Refuses settings the provider's form would not send. Settings no field names are left to the
 * provider, and so are secrets: only it knows whether a key is needed where it connects.
 */
export function assertMemoryProviderSettings(
  provider: string,
  settings: Record<string, string>,
): void {
  const { fields } = memoryProviderAdapter(provider).settings;
  for (const field of visibleSettingsFields(fields, settings)) {
    if (field.kind === "secret") continue;
    const problem = settingsFieldProblem(field, settings);
    if (!problem) continue;
    if (problem.message) throw new Error(problem.message);
    if (problem.rule === "required") throw new Error(`${field.key} is required`);
    if (problem.rule === "length") throw new Error(`${field.key} is the wrong length`);
    throw new Error(`${field.key} is not one of its choices`);
  }
}

/** The stored settings an edit carries over because no field of the form holds them. */
export function keptMemoryProviderSettings(
  provider: string,
  stored: Record<string, string>,
): Record<string, string> {
  const kept = memoryProviderAdapter(provider).settings.keptSettings ?? [];
  return Object.fromEntries(
    kept.flatMap((key) => (stored[key] === undefined ? [] : [[key, stored[key]]])),
  );
}

/** Adapters classify their settings; callers enforce the deployment trust boundary. */
export function memoryProviderRequiresPrivateEndpoint(
  provider: string,
  settings: Record<string, string>,
): boolean {
  return memoryProviderAdapter(provider).requiresPrivateEndpoint(settings);
}

/** Where a provider's stored credentials would be sent and what they could read there. */
export function memoryProviderCredentialTarget(
  provider: string,
  settings: Record<string, string>,
): string {
  return memoryProviderAdapter(provider).credentialTarget(settings);
}

/**
 * Run provider-specific trust classification (DNS, etc.) without credentialed probes.
 * Callers must authorize private endpoints through operator configuration before prepare/probe.
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
  connectionVersion?: string,
): SemanticMemoryProvider {
  return memoryProviderAdapter(provider).create(settings, credentials, connectionVersion);
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

/** Decrypts a Space's stored provider credentials. */
export async function loadMemoryProviderCredentials(
  secrets: Pick<SecretStore, "load">,
  provider: string,
  secret: { id: string; ciphertext: string },
): Promise<Record<string, string>> {
  return decodeCredentials(provider, await secrets.load(secret.ciphertext, secret.id));
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
    const settings = toStringRecord(config.settings);
    if (memoryProviderRequiresPrivateEndpoint(config.provider, settings)) {
      // Saved configurations cannot bypass an operator's current network policy.
      if (process.env.MCP_ALLOW_PRIVATE_ENDPOINT !== "true") return null;
    }
    const adapter = memoryProviderAdapter(config.provider);
    try {
      await adapter.revalidate?.(settings);
    } catch {
      getLogger().warn("Semantic memory disabled: endpoint revalidation failed");
      return null;
    }
    const credentials = await loadMemoryProviderCredentials(
      this.secrets,
      config.provider,
      config.secret,
    );
    return {
      provider: createMemoryProvider(
        config.provider,
        settings,
        credentials,
        // Memory connection saves create a new secret ID when credentials change.
        JSON.stringify([config.id, config.secretId, config.provider]),
      ),
      defaultScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
    };
  }
}
