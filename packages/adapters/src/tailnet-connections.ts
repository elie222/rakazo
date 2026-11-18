import { createHash } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetConnectionConfig } from "@rakazo/contracts";
import { TailnetConnectionConfigSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { persistPreparedSecret } from "./secrets/secret-persistence.js";

/**
 * A tailnet connection belongs to one member in one Space. Every read and write here is keyed by
 * both, so another member of the Space can never see, change or use it, even for the same bot.
 * Row-level security enforces the same pair underneath.
 */
export type TailnetScope = { userId: string; spaceId: string };

/** What the owner sees: never the client ID or secret. */
export type TailnetConnectionView = { tag: string; botIds: string[] };

/**
 * The secret-persistence client in production: it deletes a replaced or removed value from a
 * remote secret store once no row uses it.
 */
type TailnetPrisma = Pick<PrismaClient, "tailnetConnection">;

export async function getTailnetConnection(
  prisma: TailnetPrisma,
  scope: TailnetScope,
): Promise<TailnetConnectionView | null> {
  return await prisma.tailnetConnection.findUnique({
    where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
    select: { tag: true, botIds: true },
  });
}

/**
 * Save or replace this member's connection after Tailscale accepts it. Replacing keeps the bots
 * they already allowed.
 */
export async function saveTailnetConnection(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: TailnetScope;
  config: TailnetConnectionConfig;
  verify: (config: TailnetConnectionConfig) => Promise<void>;
}): Promise<TailnetConnectionView> {
  const { prisma, secretStore, scope } = input;
  const config = TailnetConnectionConfigSchema.parse(input.config);
  await input.verify(config).catch((error: unknown) => {
    if (error instanceof PrivateNetworkError) throw tailnetConnectionError(error);
    throw error;
  });
  const where = { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } };
  const existing = await prisma.tailnetConnection.findUnique({ where, select: { id: true } });
  // A first connection's id comes from the member and Space, so two saves at once write one row.
  const id = existing?.id ?? tailnetConnectionId(scope);
  // Writes go by id: secret persistence finds the replaced value with findMany, which takes no
  // compound unique key.
  const stored = await secretStore.put(
    JSON.stringify(config),
    {
      operationId: id,
      traceId: id,
      userId: scope.userId,
      spaceId: scope.spaceId,
      signal: AbortSignal.timeout(15_000),
    },
    { recordId: id },
  );
  // A value no row ends up holding, because the write failed, is deleted again.
  return await persistPreparedSecret(
    input.prisma,
    secretStore,
    { id, ciphertext: stored.ciphertext },
    async () => {
      const update = { tag: config.tag, ciphertext: stored.ciphertext };
      const select = { tag: true, botIds: true };
      try {
        return await prisma.tailnetConnection.upsert({
          where: { id },
          create: { id, ...scope, ...update },
          update,
          select,
        });
      } catch (error) {
        // Another save created the row between this one's read and its write: update it.
        if (!isUniqueViolation(error)) throw error;
        return await prisma.tailnetConnection.update({ where: { id }, data: update, select });
      }
    },
  );
}

/** The id of a member's first connection in a Space; stable, so concurrent saves agree on it. */
function tailnetConnectionId(scope: TailnetScope): string {
  return createHash("sha256")
    .update(JSON.stringify(["tailnet", scope.spaceId, scope.userId]))
    .digest("hex")
    .slice(0, 24);
}

/** Remove this member's connection. Returns false when there was none. */
export async function removeTailnetConnection(input: {
  prisma: TailnetPrisma;
  scope: TailnetScope;
}): Promise<boolean> {
  const { count } = await input.prisma.tailnetConnection.deleteMany({
    where: { spaceId: input.scope.spaceId, userId: input.scope.userId },
  });
  return count > 0;
}

/** The tailnet refused the client, which the member can fix. */
export class TailnetConnectionRefusedError extends ClientError {
  constructor(message: string, options?: ErrorOptions) {
    super("BAD_REQUEST", message, "BAD_REQUEST", options);
    this.name = "TailnetConnectionRefusedError";
  }
}

/** The tailnet's service couldn't be reached to check the client: try again later. */
export class TailnetUnavailableError extends ClientError {
  constructor(message: string, options?: ErrorOptions) {
    super("SERVICE_UNAVAILABLE", message, "SERVICE_UNAVAILABLE", options);
    this.name = "TailnetUnavailableError";
  }
}

function tailnetConnectionError(error: PrivateNetworkError): ClientError {
  return error.code === "unavailable"
    ? new TailnetUnavailableError(error.message, { cause: error })
    : new TailnetConnectionRefusedError(error.message, { cause: error });
}

/** The bot is not one of this Space's. */
export class TailnetBotNotFoundError extends ClientError {
  constructor() {
    super("NOT_FOUND", "Bot not found in this space.");
    this.name = "TailnetBotNotFoundError";
  }
}

/** Let a bot of this Space onto this member's tailnet, or take it off. Null when not connected. */
export async function setTailnetBotAccess(input: {
  prisma: Pick<PrismaClient, "$transaction">;
  scope: TailnetScope;
  botId: string;
  enabled: boolean;
}): Promise<TailnetConnectionView | null> {
  const { scope, botId } = input;
  // The row stays locked while its list changes, so two switches flipped at once both count.
  return await input.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tailnet_connections
      WHERE "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} FOR UPDATE`;
    const current = await tx.tailnetConnection.findUnique({
      where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
      select: { id: true, botIds: true },
    });
    if (!current) return null;
    if (input.enabled) {
      const bot = await tx.bot.findFirst({
        where: { id: botId, spaceId: scope.spaceId },
        select: { id: true },
      });
      if (!bot) throw new TailnetBotNotFoundError();
    }
    const others = current.botIds.filter((id) => id !== botId);
    // By id, as in saveTailnetConnection.
    return await tx.tailnetConnection.update({
      where: { id: current.id },
      data: { botIds: input.enabled ? [...others, botId] : others },
      select: { tag: true, botIds: true },
    });
  });
}

/** Whether this member still lets the bot onto their tailnet, without opening the client. */
export async function tailnetBotAllowed(
  prisma: TailnetPrisma,
  run: { userId: string; spaceId: string; botId: string },
): Promise<boolean> {
  const row = await prisma.tailnetConnection.findUnique({
    where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
    select: { botIds: true },
  });
  return Boolean(row?.botIds.includes(run.botId));
}

/**
 * The OAuth client a run may use, or undefined. The connection is looked up by the run's own
 * user, never the bot's creator or another member, and only if that user let this bot on.
 */
export async function resolveRunTailnet(input: {
  prisma: TailnetPrisma;
  secretStore: SecretStore;
  run: { userId: string; spaceId: string; botId: string };
}): Promise<TailnetConnectionConfig | undefined> {
  const { run } = input;
  const row = await input.prisma.tailnetConnection.findUnique({
    where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
    select: { id: true, ciphertext: true, botIds: true },
  });
  if (!row?.botIds.includes(run.botId)) return undefined;
  const plaintext = await input.secretStore.load(row.ciphertext, row.id);
  return TailnetConnectionConfigSchema.parse(JSON.parse(plaintext));
}
