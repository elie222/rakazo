import { randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { TailscaleConnectionConfig } from "@rakazo/contracts";
import { TailscaleConnectionConfigSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { persistPreparedSecret } from "./secret-persistence.js";

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
  config: TailscaleConnectionConfig;
  verify: (config: TailscaleConnectionConfig) => Promise<void>;
}): Promise<TailnetConnectionView> {
  const { prisma, secretStore, scope } = input;
  const config = TailscaleConnectionConfigSchema.parse(input.config);
  await input.verify(config);
  const where = { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } };
  const existing = await prisma.tailnetConnection.findUnique({ where, select: { id: true } });
  const id = existing?.id ?? randomBytes(12).toString("hex");
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
    () =>
      prisma.tailnetConnection.upsert({
        where,
        create: { id, ...scope, tag: config.tag, ciphertext: stored.ciphertext },
        update: { tag: config.tag, ciphertext: stored.ciphertext },
        select: { tag: true, botIds: true },
      }),
  );
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

/** The bot is not one of this Space's. */
export class TailnetBotNotFoundError extends Error {
  constructor() {
    super("Bot not found in this space.");
    this.name = "TailnetBotNotFoundError";
  }
}

/** Let a bot of this Space onto this member's tailnet, or take it off. Null when not connected. */
export async function setTailnetBotAccess(input: {
  prisma: TailnetPrisma & Pick<PrismaClient, "bot">;
  scope: TailnetScope;
  botId: string;
  enabled: boolean;
}): Promise<TailnetConnectionView | null> {
  const where = { spaceId_userId: { spaceId: input.scope.spaceId, userId: input.scope.userId } };
  const current = await input.prisma.tailnetConnection.findUnique({
    where,
    select: { botIds: true },
  });
  if (!current) return null;
  if (input.enabled) {
    const bot = await input.prisma.bot.findFirst({
      where: { id: input.botId, spaceId: input.scope.spaceId },
      select: { id: true },
    });
    if (!bot) throw new TailnetBotNotFoundError();
  }
  const others = current.botIds.filter((id) => id !== input.botId);
  return await input.prisma.tailnetConnection.update({
    where,
    data: { botIds: input.enabled ? [...others, input.botId] : others },
    select: { tag: true, botIds: true },
  });
}

/**
 * The OAuth client a run may use, or undefined. The connection is looked up by the run's own
 * user, never the bot's creator or another member, and only if that user let this bot on.
 */
export async function resolveRunTailnet(input: {
  prisma: TailnetPrisma;
  secretStore: SecretStore;
  run: { userId: string; spaceId: string; botId: string };
}): Promise<TailscaleConnectionConfig | undefined> {
  const { run } = input;
  const row = await input.prisma.tailnetConnection.findUnique({
    where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
    select: { id: true, ciphertext: true, botIds: true },
  });
  if (!row?.botIds.includes(run.botId)) return undefined;
  const plaintext = await input.secretStore.load(row.ciphertext, row.id);
  return TailscaleConnectionConfigSchema.parse(JSON.parse(plaintext));
}
