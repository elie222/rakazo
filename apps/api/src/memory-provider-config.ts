import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import {
  classifyMemoryProviderSettings,
  loadMemoryProviderCredentials,
  MemoryProviderPrivateEndpointRequiredError,
  memoryProviderCredentialTarget,
  memoryProviderRequiresPrivateEndpoint,
  prepareMemoryProviderConnection,
  toStringRecord,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findSpaceMemoryConfig, Prisma, requireSpaceOwner, withTransactionRetry } from "@rakazo/db";

export interface MemoryProviderConfigDeps {
  prisma: PrismaClient;
  env?: { mcpAllowPrivateEndpoint?: boolean };
  secrets: Pick<SecretStore, "put" | "load">;
  /** Test seam: override DNS/trust classification without probing. */
  classifySettings?: (
    provider: string,
    settings: Record<string, string>,
  ) => Promise<Record<string, string>>;
  /** Test seam: override prepare/probe. */
  prepareConnection?: (
    input: Parameters<typeof prepareMemoryProviderConnection>[0],
  ) => ReturnType<typeof prepareMemoryProviderConnection>;
}

export async function persistMemoryProviderConfig(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  input: {
    provider: string;
    settings: Record<string, string>;
    credentials: Record<string, string>;
    defaultMemoryScope: "isolated" | "shared";
  },
) {
  await requireSpaceOwner(deps.prisma, actor);
  return saveMemoryProviderConnection(deps, actor, input, {
    defaultMemoryScope: input.defaultMemoryScope,
  });
}

/** Changes the connected provider's settings; empty or missing credentials keep the stored ones. */
export async function updateMemoryProviderConfig(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  input: { settings: Record<string, string>; credentials: Record<string, string> },
) {
  await requireSpaceOwner(deps.prisma, actor);
  const existing = await deps.prisma.spaceMemoryConfig.findUnique({
    where: { spaceId: actor.spaceId },
    include: { secret: true },
  });
  if (!existing) throw new ORPCError("NOT_FOUND");
  const movesCredentials =
    memoryProviderCredentialTarget(existing.provider, input.settings) !==
    memoryProviderCredentialTarget(existing.provider, toStringRecord(existing.settings));
  let credentials: Record<string, string>;
  if (movesCredentials) {
    // The stored secret never follows the provider somewhere else: only what was entered is
    // used, and the provider's own validation decides whether that is enough (a self-hosted server
    // may run without a key).
    credentials = { ...input.credentials };
  } else {
    credentials = await loadMemoryProviderCredentials(
      deps.secrets,
      existing.provider,
      existing.secret,
    );
    for (const [key, value] of Object.entries(input.credentials)) {
      if (value) credentials[key] = value;
    }
  }
  return saveMemoryProviderConnection(
    deps,
    actor,
    { provider: existing.provider, settings: input.settings, credentials },
    { replacesSecretId: existing.secretId },
  );
}

/**
 * Connects a provider, or with `replacesSecretId` updates that exact connection: the update is
 * refused when the connection was disconnected or replaced meanwhile, and keeps its default scope.
 */
async function saveMemoryProviderConnection(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  input: {
    provider: string;
    settings: Record<string, string>;
    credentials: Record<string, string>;
  },
  target: { defaultMemoryScope: "isolated" | "shared" } | { replacesSecretId: string },
) {
  let prepared: Awaited<ReturnType<typeof prepareMemoryProviderConnection>>;
  try {
    if (
      memoryProviderRequiresPrivateEndpoint(input.provider, input.settings) &&
      deps.env?.mcpAllowPrivateEndpoint !== true
    ) {
      throw new ORPCError("FORBIDDEN");
    }
    const classify = deps.classifySettings ?? classifyMemoryProviderSettings;
    const prepare = deps.prepareConnection ?? prepareMemoryProviderConnection;
    // Classify DNS/trust before any credentialed probe so LAN endpoints stay operator-authorized.
    const classifiedSettings = await classify(input.provider, input.settings);
    if (
      memoryProviderRequiresPrivateEndpoint(input.provider, classifiedSettings) &&
      deps.env?.mcpAllowPrivateEndpoint !== true
    ) {
      throw new ORPCError("FORBIDDEN");
    }
    prepared = await prepare({
      ...input,
      settings: classifiedSettings,
      allowPrivateEndpoint: deps.env?.mcpAllowPrivateEndpoint === true,
    });
    // Defense in depth if prepare reclassified further.
    if (
      memoryProviderRequiresPrivateEndpoint(prepared.provider, prepared.settings) &&
      deps.env?.mcpAllowPrivateEndpoint !== true
    ) {
      throw new ORPCError("FORBIDDEN");
    }
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof MemoryProviderPrivateEndpointRequiredError) {
      throw new ORPCError("FORBIDDEN");
    }
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Memory provider connection failed",
    });
  }
  const stored = await deps.secrets.put(JSON.stringify(prepared.credentials), {
    operationId: "memory-provider-config",
    traceId: "memory-provider-config",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const config = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
        let defaultMemoryScope: "isolated" | "shared";
        if ("replacesSecretId" in target) {
          // A disconnect or another save racing this update must not be overwritten: the stored
          // credentials it decided on belong to the connection it read.
          if (!existing || existing.secretId !== target.replacesSecretId) {
            throw new ORPCError("NOT_FOUND");
          }
          defaultMemoryScope = existing.defaultMemoryScope === "shared" ? "shared" : "isolated";
        } else {
          defaultMemoryScope = target.defaultMemoryScope;
        }
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: "memory-provider",
            ciphertext: stored.ciphertext,
          },
        });
        const updated = await tx.spaceMemoryConfig.upsert({
          where: { spaceId: actor.spaceId },
          create: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            provider: prepared.provider,
            settings: prepared.settings,
            secretId: secret.id,
            defaultMemoryScope,
          },
          update: {
            userId: actor.userId,
            provider: prepared.provider,
            settings: prepared.settings,
            secretId: secret.id,
            defaultMemoryScope,
          },
        });
        if (existing && existing.secretId !== secret.id) {
          await tx.secret.deleteMany({ where: { id: existing.secretId } });
        }
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return serializeSpaceMemoryConfig(config);
}

export async function updateMemoryProviderDefaultScope(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  defaultMemoryScope: "isolated" | "shared",
) {
  await requireSpaceOwner(deps.prisma, actor);
  const existing = await findSpaceMemoryConfig(deps.prisma, actor.spaceId);
  if (!existing) throw new ORPCError("NOT_FOUND");
  const updated = await deps.prisma.spaceMemoryConfig.update({
    where: { id: existing.id },
    data: { defaultMemoryScope },
  });
  return serializeSpaceMemoryConfig(updated);
}

export function serializeSpaceMemoryConfig(config: {
  provider: string;
  settings: unknown;
  defaultMemoryScope: string;
  updatedAt: Date;
}) {
  return {
    provider: config.provider,
    settings: toStringRecord(config.settings),
    defaultMemoryScope: config.defaultMemoryScope as "isolated" | "shared",
    updatedAt: config.updatedAt.toISOString(),
  };
}

export async function disconnectMemoryProvider(deps: MemoryProviderConfigDeps, actor: Actor) {
  await requireSpaceOwner(deps.prisma, actor);
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
        if (!existing) return;
        await tx.spaceMemoryConfig.delete({ where: { id: existing.id } });
        await tx.secret.deleteMany({ where: { id: existing.secretId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return { ok: true as const };
}
