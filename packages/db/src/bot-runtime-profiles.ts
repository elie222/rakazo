import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

export class BotRuntimeProfileConflictError extends Error {
  constructor(message = "Profile changed; review the current profile first.") {
    super(message);
    this.name = "BotRuntimeProfileConflictError";
  }
}

export type BotRuntimeProfileScope = { spaceId: string; userId: string; botId: string };

const MAX_PROFILE_REASON_LENGTH = 500;
const MAX_PROFILE_SETTINGS_BYTES = 128 * 1024;

function validateProfileWrite(input: {
  expectedRevision: number;
  settings: Prisma.InputJsonValue;
  reason: string;
}): void {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision === Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError(
      "Expected revision must be a non-negative safe integer with room to increment.",
    );
  }
  if (!input.reason.trim() || input.reason.length > MAX_PROFILE_REASON_LENGTH) {
    throw new TypeError("Revision reason must contain 1 to 500 characters.");
  }
  const serialized = JSON.stringify(input.settings);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > MAX_PROFILE_SETTINGS_BYTES
  ) {
    throw new RangeError("Profile settings must not exceed 128 KiB of JSON.");
  }
}

/** Returns null for legacy bots that do not have an explicit profile yet. */
export async function readBotRuntimeProfile(prisma: PrismaClient, scope: BotRuntimeProfileScope) {
  const bot = await prisma.bot.findFirst({
    where: { id: scope.botId, spaceId: scope.spaceId, userId: scope.userId },
    select: { id: true },
  });
  if (!bot) throw new IsolationError();
  return prisma.botRuntimeProfile.findUnique({ where: { botId: scope.botId } });
}

export type BotRuntimeProfileRevisionPage = {
  limit: number;
  beforeRevision?: number;
};

function requireOwnedBot(prisma: PrismaClient, scope: BotRuntimeProfileScope) {
  return prisma.bot.findFirst({
    where: { id: scope.botId, spaceId: scope.spaceId, userId: scope.userId },
    select: { id: true },
  });
}

function validateRevisionPage(page: BotRuntimeProfileRevisionPage): void {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 50) {
    throw new RangeError("Revision page limit must be an integer from 1 to 50.");
  }
  if (
    page.beforeRevision !== undefined &&
    (!Number.isSafeInteger(page.beforeRevision) || page.beforeRevision < 1)
  ) {
    throw new RangeError("Revision cursor must be a positive safe integer.");
  }
}

/** Lists full revision snapshots only after the caller owns the bot in the supplied space. */
export async function listBotRuntimeProfileRevisions(
  prisma: PrismaClient,
  scope: BotRuntimeProfileScope,
  page: BotRuntimeProfileRevisionPage,
) {
  validateRevisionPage(page);
  const bot = await requireOwnedBot(prisma, scope);
  if (!bot) throw new IsolationError();
  return prisma.botRuntimeProfileRevision.findMany({
    where: {
      botId: scope.botId,
      ...(page.beforeRevision === undefined ? {} : { revision: { lt: page.beforeRevision } }),
    },
    orderBy: { revision: "desc" },
    take: page.limit,
  });
}

/** Reads one full immutable snapshot only after the caller owns the bot. */
export async function readBotRuntimeProfileRevision(
  prisma: PrismaClient,
  scope: BotRuntimeProfileScope,
  revision: number,
) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError("Revision must be a positive safe integer.");
  }
  const bot = await requireOwnedBot(prisma, scope);
  if (!bot) throw new IsolationError();
  return prisma.botRuntimeProfileRevision.findUnique({
    where: { botId_revision: { botId: scope.botId, revision } },
  });
}

/** The bot lock serializes both first creation and later revision checks. */
export async function writeBotRuntimeProfile(
  prisma: PrismaClient,
  input: BotRuntimeProfileScope & {
    expectedRevision: number;
    settings: Prisma.InputJsonValue;
    reason: string;
  },
) {
  validateProfileWrite(input);

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM bots
      WHERE id = ${input.botId} AND "spaceId" = ${input.spaceId} AND "userId" = ${input.userId}
      FOR UPDATE
    `;
    if (rows.length === 0) throw new IsolationError();

    const current = await tx.botRuntimeProfile.findUnique({ where: { botId: input.botId } });
    const revision = current?.revision ?? 0;
    if (revision !== input.expectedRevision) throw new BotRuntimeProfileConflictError();

    const nextRevision = revision + 1;
    const profile = current
      ? await tx.botRuntimeProfile.update({
          where: { botId: input.botId },
          data: { revision: nextRevision, settings: input.settings },
        })
      : await tx.botRuntimeProfile.create({
          data: { botId: input.botId, revision: nextRevision, settings: input.settings },
        });

    await tx.botRuntimeProfileRevision.create({
      data: {
        botId: input.botId,
        revision: nextRevision,
        settings: input.settings,
        actorUserId: input.userId,
        reason: input.reason,
      },
    });
    return profile;
  });
}
