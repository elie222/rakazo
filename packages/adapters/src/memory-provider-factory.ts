import { createHash } from "node:crypto";
import type {
  DurableMemoryScope,
  SecretStore,
  SemanticMemoryProvider,
  TurnMemoryLifecycle,
} from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { isPoolCheckoutTimeout, isTooManyDatabaseConnections } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  createHonchoProvider,
  HONCHO_PROVIDER_ID,
  honchoRequiresPrivateEndpoint,
  prepareHonchoConnection,
} from "./honcho-memory-provider.js";
import { revalidateLocalServiceSettings } from "./local-service-endpoint.js";
import {
  classifyMemmyConnectionSettings,
  memmyRequiresPrivateEndpoint,
  revalidateMemmySettings,
} from "./memmy-connection-trust.js";
import {
  createMemmyProvider,
  createMemmyTurnMemory,
  MEMMY_PROVIDER_ID,
  prepareMemmyConnection,
} from "./memmy-turn-memory.js";
import {
  classifySerenityConnectionSettings,
  createSerenityProvider,
  prepareSerenityConnection,
  SERENITY_PROVIDER_ID,
  serenityRequiresPrivateEndpoint,
} from "./serenity-memory-provider.js";

export { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";

import {
  createSupermemoryProvider,
  decodeLegacySupermemoryCredentials,
  prepareSupermemoryConnection,
  SUPERMEMORY_PROVIDER_ID,
  supermemoryRequiresPrivateEndpoint,
} from "./supermemory-memory-provider.js";

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
  /** Connection identity without credentials; stable across token rotation. */
  captureTarget?: string;
  /** Per-turn recall/capture for providers that learn from each turn. */
  lifecycle?: TurnMemoryLifecycle;
}

/** Pending captures retry only failures that can recover without changing their configuration. */
export type TurnMemoryAvailability =
  | {
      kind: "configured";
      lifecycle: TurnMemoryLifecycle;
      defaultScope: DurableMemoryScope;
      captureTarget?: string;
    }
  | { kind: "unconfigured" }
  | { kind: "unavailable"; reason: string; retryable: boolean };

export interface MemoryProviderResolver {
  resolve(spaceId: string): Promise<ConfiguredMemoryProvider | null>;
  resolveTurnMemory(spaceId: string): Promise<TurnMemoryAvailability>;
}

type UnavailableMemoryProvider = Extract<TurnMemoryAvailability, { kind: "unavailable" }>;
type MemoryProviderResolution =
  | { kind: "configured"; value: ConfiguredMemoryProvider }
  | Exclude<TurnMemoryAvailability, { kind: "configured" }>;

type MemoryProviderLoadStage =
  | "configuration_load"
  | "endpoint_revalidation"
  | "credential_load"
  | "credential_decode"
  | "provider_creation";

const TRANSIENT_DEPENDENCY_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  // Prisma connection, pool and transaction failures; authentication/schema errors are omitted.
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2034",
  "P2037",
  // Postgres connection loss, contention, capacity and shutdown codes.
  "08001",
  "08003",
  "08006",
  "40001",
  "40P01",
  "53300",
  "55P03",
  "57P01",
  "57P02",
  "57P03",
]);

function unavailable(reason: string, retryable = false): UnavailableMemoryProvider {
  return { kind: "unavailable", reason, retryable };
}

/** Recognized dependency outages may recover; unknown or invalid configuration errors do not. */
export function isRetryableMemoryError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  if (error instanceof SecretStoreUnavailableError) {
    const status = error.status;
    return (
      status === undefined || status === 408 || status === 425 || status === 429 || status >= 500
    );
  }
  if (isPoolCheckoutTimeout(error) || isTooManyDatabaseConnections(error)) return true;
  const failure = error as {
    code?: unknown;
    errorCode?: unknown;
    originalCode?: unknown;
    cause?: unknown;
    meta?: { driverAdapterError?: unknown };
    $fault?: unknown;
    $retryable?: { throttling?: unknown };
    $metadata?: { httpStatusCode?: unknown };
  };
  // Key-manager SDK errors retain their service classification through unwrap's cause.
  const httpStatus = failure.$metadata?.httpStatusCode;
  if (
    failure.$fault === "server" ||
    failure.$retryable?.throttling === true ||
    (typeof httpStatus === "number" &&
      (httpStatus === 408 || httpStatus === 425 || httpStatus === 429 || httpStatus >= 500)) ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
  ) {
    return true;
  }
  if (
    [failure.code, failure.errorCode, failure.originalCode].some(
      (code) => typeof code === "string" && TRANSIENT_DEPENDENCY_CODES.has(code),
    )
  ) {
    return true;
  }
  if (error instanceof AggregateError) {
    return error.errors.some((cause) => isRetryableMemoryError(cause, depth + 1));
  }
  return (
    isRetryableMemoryError(failure.cause, depth + 1) ||
    isRetryableMemoryError(failure.meta?.driverAdapterError, depth + 1)
  );
}

function resolutionFailure(
  error: unknown,
  stage: MemoryProviderLoadStage,
): UnavailableMemoryProvider {
  if (stage === "credential_decode") return unavailable("invalid_credentials");
  if (stage === "provider_creation") return unavailable("invalid_provider_configuration");
  if (stage === "credential_load" && error instanceof SecretStoreUnavailableError) {
    return unavailable("secret_store_unavailable", isRetryableMemoryError(error));
  }
  const retryable = isRetryableMemoryError(error);
  const reason =
    stage === "configuration_load"
      ? retryable
        ? "configuration_unavailable"
        : "configuration_load_failed"
      : stage === "endpoint_revalidation"
        ? retryable
          ? "endpoint_unavailable"
          : "endpoint_revalidation_failed"
        : retryable
          ? "secret_store_unavailable"
          : "credential_load_failed";
  // Exceptions can contain endpoints or plaintext credentials; expose only fixed classifications.
  return unavailable(reason, retryable);
}

interface MemoryProviderAdapter {
  requiresPrivateEndpoint(settings: Record<string, string>): boolean;
  /** Async trust classification (e.g. DNS) without probing credentials. */
  classifySettings?(settings: Record<string, string>): Promise<Record<string, string>>;
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
  createTurnMemory?(
    settings: Record<string, string>,
    credentials: Record<string, string>,
  ): TurnMemoryLifecycle;
  decodeLegacyCredentials?(plaintext: string): Record<string, string> | null;
}

const MEMORY_PROVIDER_ADAPTERS: ReadonlyMap<string, MemoryProviderAdapter> = new Map([
  [
    SUPERMEMORY_PROVIDER_ID,
    {
      requiresPrivateEndpoint: supermemoryRequiresPrivateEndpoint,
      revalidate: revalidateLocalServiceSettings,
      prepare: prepareSupermemoryConnection,
      create: createSupermemoryProvider,
      decodeLegacyCredentials: decodeLegacySupermemoryCredentials,
    },
  ],
  [
    SERENITY_PROVIDER_ID,
    {
      requiresPrivateEndpoint: serenityRequiresPrivateEndpoint,
      classifySettings: classifySerenityConnectionSettings,
      prepare: (
        settings: Record<string, string>,
        credentials: Record<string, string>,
        options?: { allowPrivateEndpoint?: boolean },
      ) => prepareSerenityConnection(settings, credentials, undefined, options),
      create: createSerenityProvider,
    },
  ],
  [
    HONCHO_PROVIDER_ID,
    {
      requiresPrivateEndpoint: honchoRequiresPrivateEndpoint,
      revalidate: revalidateLocalServiceSettings,
      prepare: prepareHonchoConnection,
      create: createHonchoProvider,
    },
  ],
  [
    MEMMY_PROVIDER_ID,
    {
      requiresPrivateEndpoint: memmyRequiresPrivateEndpoint,
      classifySettings: (settings: Record<string, string>) =>
        classifyMemmyConnectionSettings(settings),
      revalidate: revalidateMemmySettings,
      prepare: prepareMemmyConnection,
      create: createMemmyProvider,
      createTurnMemory: createMemmyTurnMemory,
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

function memoryCaptureTarget(provider: string, settings: Record<string, string>): string {
  const entries = Object.keys(settings)
    .sort()
    .map((key) => [key, settings[key]]);
  return createHash("sha256")
    .update(JSON.stringify([provider, entries]))
    .digest("hex");
}

export class SpaceMemoryProviderResolver implements MemoryProviderResolver {
  constructor(
    private readonly prisma: Pick<PrismaClient, "spaceMemoryConfig">,
    private readonly secrets: SecretStore,
  ) {}

  async resolveTurnMemory(spaceId: string): Promise<TurnMemoryAvailability> {
    const result = await this.loadConfiguredProvider(spaceId, true);
    if (result.kind !== "configured") return result;
    const { lifecycle, defaultScope, captureTarget } = result.value;
    return lifecycle
      ? { kind: "configured", lifecycle, defaultScope, captureTarget }
      : unavailable("lifecycle_unsupported");
  }

  async resolve(spaceId: string): Promise<ConfiguredMemoryProvider | null> {
    const result = await this.loadConfiguredProvider(spaceId, false);
    if (result.kind === "configured") return result.value;
    if (result.kind === "unavailable") {
      getLogger().warn("Semantic memory unavailable", {
        spaceId,
        reason: result.reason,
        retryable: result.retryable,
      });
    }
    return null;
  }

  /** Both public paths use the same checks; legacy providers need no per-turn lifecycle. */
  private async loadConfiguredProvider(
    spaceId: string,
    requireLifecycle: boolean,
  ): Promise<MemoryProviderResolution> {
    let stage: MemoryProviderLoadStage = "configuration_load";
    let legacyProvider = false;
    try {
      const config = await this.prisma.spaceMemoryConfig.findUnique({
        where: { spaceId },
        include: { secret: true },
      });
      if (!config) return { kind: "unconfigured" };
      const adapter = MEMORY_PROVIDER_ADAPTERS.get(config.provider);
      if (!adapter) return unavailable("unknown_provider");
      legacyProvider = !adapter.createTurnMemory;
      if (requireLifecycle && !adapter.createTurnMemory) {
        return unavailable("lifecycle_unsupported");
      }
      stage = "provider_creation";
      const settings = toStringRecord(config.settings);
      if (
        adapter.requiresPrivateEndpoint(settings) &&
        process.env.MCP_ALLOW_PRIVATE_ENDPOINT !== "true"
      ) {
        return unavailable("private_endpoint_not_authorized");
      }
      stage = "endpoint_revalidation";
      if (adapter.revalidate) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            adapter.revalidate(settings),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(
                  Object.assign(new Error("Memory endpoint revalidation timed out"), {
                    code: "ETIMEDOUT",
                  }),
                );
              }, 2500);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      stage = "credential_load";
      const plaintext = await this.secrets.load(config.secret.ciphertext, config.secret.id);
      stage = "credential_decode";
      const credentials = decodeCredentials(config.provider, plaintext);
      stage = "provider_creation";
      return {
        kind: "configured",
        value: {
          provider: adapter.create(settings, credentials),
          defaultScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
          captureTarget: memoryCaptureTarget(config.provider, settings),
          ...(adapter.createTurnMemory
            ? { lifecycle: adapter.createTurnMemory(settings, credentials) }
            : {}),
        },
      };
    } catch (error) {
      // Preserve existing semantic providers' credential/create failure behavior. Only the
      // optional lifecycle path converts those failures into explicit availability states.
      if (
        !requireLifecycle &&
        legacyProvider &&
        (stage === "credential_load" ||
          stage === "credential_decode" ||
          stage === "provider_creation")
      ) {
        throw error;
      }
      return resolutionFailure(error, stage);
    }
  }
}
