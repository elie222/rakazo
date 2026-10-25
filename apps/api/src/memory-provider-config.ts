import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import {
  classifyMemoryProviderSettings,
  MemoryProviderPrivateEndpointRequiredError,
  memoryProviderCapabilities,
  memoryProviderRequiresPrivateEndpoint,
  prepareMemoryProviderConnection,
  toStringRecord,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  findSpaceMemoryConfig,
  lockSpaceMemoryScope,
  Prisma,
  type PrismaClient,
  runAsSystemInTransaction,
} from "@rakazo/db";

export async function assertMemoryScopeSupported(
  tx: Prisma.TransactionClient,
  spaceId: string,
  scope: "isolated" | "shared" | null,
): Promise<void> {
  if (scope !== "isolated") return;
  const config = await findSpaceMemoryConfig(tx, spaceId);
  if (config) assertProviderScope(config.provider, scope);
}

function assertProviderScope(provider: string, scope: string): void {
  if (scope === "isolated" && memoryProviderCapabilities(provider)?.isolatedScope === false) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "This memory provider supports shared memory only. Choose shared memory or another provider.",
    });
  }
}

export interface MemoryProviderConfigDeps {
  prisma: PrismaClient;
  env?: { mcpAllowPrivateEndpoint?: boolean };
  secrets: Pick<SecretStore, "put">;
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

async function requireSpaceOwner(prisma: PrismaClient, actor: Actor): Promise<void> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  const roles = member?.role.split(",").map((role) => role.trim());
  if (!roles?.includes("owner")) throw new ORPCError("FORBIDDEN");
}

export async function persistMemoryProviderConfig(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  input: {
    provider: string;
    settings: Record<string, string>;
    credentials: Record<string, string>;
    defaultMemoryScope: "isolated" | "shared";
    confirmSharedScope?: boolean;
  },
) {
  await requireSpaceOwner(deps.prisma, actor);
  assertProviderScope(input.provider, input.defaultMemoryScope);
  let prepared: Awaited<ReturnType<typeof prepareMemoryProviderConnection>>;
  try {
    // Fast-path known private endpoints before probing.
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
      spaceId: actor.spaceId,
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
      message: "Could not connect memory provider. Check the endpoint and credentials.",
    });
  }
  const stored = await deps.secrets.put(JSON.stringify(prepared.credentials), {
    operationId: "memory-provider-config",
    traceId: "memory-provider-config",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const config = await deps.prisma.$transaction(
    async (tx) => {
      await lockSpaceMemoryScope(tx, actor.spaceId);
      const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
      if (memoryProviderCapabilities(prepared.provider)?.isolatedScope === false) {
        assertProviderScope(prepared.provider, input.defaultMemoryScope);
        const isolated = await runAsSystemInTransaction(
          tx,
          "owner memory provider compatibility across all Space bots",
          () =>
            tx.bot.findFirst({
              where: { spaceId: actor.spaceId, memoryScope: "isolated" },
              select: { id: true },
            }),
        );
        if (isolated)
          throw new ORPCError("BAD_REQUEST", {
            message:
              "Some bots use isolated memory. Change their memory scope to shared or inherit, including archived bots, before connecting this provider.",
          });
        if (existing?.defaultMemoryScope !== "shared" && input.confirmSharedScope !== true) {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "Confirm shared memory for bots that inherit the Space default before connecting this provider.",
          });
        }
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
          defaultMemoryScope: input.defaultMemoryScope,
        },
        update: {
          userId: actor.userId,
          provider: prepared.provider,
          settings: prepared.settings,
          secretId: secret.id,
          defaultMemoryScope: input.defaultMemoryScope,
        },
      });
      if (existing && existing.secretId !== secret.id) {
        await tx.secret.deleteMany({ where: { id: existing.secretId } });
      }
      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  return serializeSpaceMemoryConfig(config);
}

export async function updateMemoryProviderDefaultScope(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  defaultMemoryScope: "isolated" | "shared",
) {
  await requireSpaceOwner(deps.prisma, actor);
  const updated = await deps.prisma.$transaction(
    async (tx) => {
      await lockSpaceMemoryScope(tx, actor.spaceId);
      const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
      if (!existing) throw new ORPCError("NOT_FOUND");
      assertProviderScope(existing.provider, defaultMemoryScope);
      return tx.spaceMemoryConfig.update({
        where: { id: existing.id },
        data: { defaultMemoryScope },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  return serializeSpaceMemoryConfig(updated);
}

export function serializeSpaceMemoryConfig(config: {
  provider: string;
  settings: unknown;
  defaultMemoryScope: string;
  updatedAt: Date;
}) {
  const capabilities = memoryProviderCapabilities(config.provider);
  return {
    ...(capabilities?.isolatedScope !== undefined
      ? { capabilities: { isolatedScope: capabilities.isolatedScope } }
      : {}),
    provider: config.provider,
    settings: toStringRecord(config.settings),
    defaultMemoryScope: config.defaultMemoryScope as "isolated" | "shared",
    updatedAt: config.updatedAt.toISOString(),
  };
}

export async function disconnectMemoryProvider(deps: MemoryProviderConfigDeps, actor: Actor) {
  await requireSpaceOwner(deps.prisma, actor);
  await deps.prisma.$transaction(
    async (tx) => {
      await lockSpaceMemoryScope(tx, actor.spaceId);
      const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
      if (!existing) return;
      await tx.spaceMemoryConfig.delete({ where: { id: existing.id } });
      await tx.secret.deleteMany({ where: { id: existing.secretId } });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  return { ok: true as const };
}
