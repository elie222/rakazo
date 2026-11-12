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
import { getLogger } from "@rakazo/logging";

export interface MemoryProviderConfigDeps {
  prisma: PrismaClient;
  env?: { mcpAllowPrivateEndpoint?: boolean };
  secrets: Pick<SecretStore, "put" | "load" | "delete">;
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
  // What is stored now, when it can be read. It is only compared below, never sent anywhere when
  // the connection moves.
  const stored = await loadMemoryProviderCredentials(
    deps.secrets,
    existing.provider,
    existing.secret,
  ).catch((error: unknown) => error);
  const storedCredentials = stored instanceof Error ? null : (stored as Record<string, string>);
  let credentials: Record<string, string>;
  if (movesCredentials) {
    // The stored secret never follows the provider somewhere else: only what was entered is
    // used, and the provider's own validation decides whether that is enough (a self-hosted server
    // may run without a key).
    credentials = { ...input.credentials };
  } else {
    const entered = Object.fromEntries(
      Object.entries(input.credentials).filter(([, value]) => Boolean(value)),
    );
    if (storedCredentials) {
      credentials = { ...storedCredentials, ...entered };
    } else {
      // A stored key that can't be read (a rotated secret store, a legacy record, an outage) must
      // not block an owner who typed a replacement. With nothing typed, the failure is surfaced
      // instead of looking like a missing key.
      if (Object.keys(entered).length === 0) throw stored;
      getLogger().warn("Stored memory provider credentials could not be read", {
        "error.message": stored instanceof Error ? stored.message : String(stored),
      });
      credentials = entered;
    }
  }
  return saveMemoryProviderConnection(
    deps,
    actor,
    { provider: existing.provider, settings: input.settings, credentials },
    { replacesSecretId: existing.secretId, storedCredentials },
  );
}

function sameCredentials(a: Record<string, string>, b: Record<string, string>) {
  const canonical = (value: Record<string, string>) =>
    JSON.stringify(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)));
  return canonical(a) === canonical(b);
}

/**
 * Connects a provider, or with `replacesSecretId` updates that exact connection: the update is
 * refused when the connection was disconnected or replaced meanwhile, and keeps its default scope.
 * When the credentials to save equal `storedCredentials`, the same secret record is kept, so work
 * bound to this connection (pending memory cleanup) continues across the edit, including an edit
 * that only changes which outside banks are read.
 */
async function saveMemoryProviderConnection(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  input: {
    provider: string;
    settings: Record<string, string>;
    credentials: Record<string, string>;
  },
  target:
    | { defaultMemoryScope: "isolated" | "shared" }
    | { replacesSecretId: string; storedCredentials: Record<string, string> | null },
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
  const keptSecretId =
    "replacesSecretId" in target &&
    target.storedCredentials &&
    sameCredentials(prepared.credentials, target.storedCredentials)
      ? target.replacesSecretId
      : null;
  const stored = keptSecretId
    ? null
    : await deps.secrets.put(JSON.stringify(prepared.credentials), {
        operationId: "memory-provider-config",
        traceId: "memory-provider-config",
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: new AbortController().signal,
      });
  let saved: {
    config: Parameters<typeof serializeSpaceMemoryConfig>[0];
    replaced: { id: string; ciphertext: string } | null;
  };
  try {
    saved = await withTransactionRetry(() =>
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
          const secret = stored
            ? await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: actor.userId,
                  spaceId: actor.spaceId,
                  kind: "memory-provider",
                  ciphertext: stored.ciphertext,
                },
              })
            : { id: keptSecretId as string };
          const config = await tx.spaceMemoryConfig.upsert({
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
          let replaced: { id: string; ciphertext: string } | null = null;
          if (existing && existing.secretId !== secret.id) {
            replaced = await tx.secret.findUnique({
              where: { id: existing.secretId },
              select: { id: true, ciphertext: true },
            });
            await tx.secret.deleteMany({ where: { id: existing.secretId } });
          }
          return { config, replaced };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    // A remote secret store keeps the value it was given until it is deleted there too.
    if (stored) await deleteStoredSecret(deps, stored);
    throw error;
  }
  if (saved.replaced) {
    await deleteStoredSecret(deps, saved.replaced);
  }
  return serializeSpaceMemoryConfig(saved.config);
}

/** Best effort, but logged: a value left in a remote secret store needs an operator to remove it. */
async function deleteStoredSecret(
  deps: MemoryProviderConfigDeps,
  secret: { id: string; ciphertext: string },
) {
  await deps.secrets.delete(secret.ciphertext, secret.id).catch((error: unknown) => {
    getLogger().warn("Memory provider secret could not be removed from the secret store", {
      "secret.id": secret.id,
      "error.message": error instanceof Error ? error.message : String(error),
    });
  });
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
