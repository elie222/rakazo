import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REASON = "an owner's email sends across their Spaces";

/**
 * Count one email a bot is about to send against its own and its owner's limits for the last
 * day, or name the limit it would pass. One owner's sends are counted one at a time, so parallel
 * sends cannot all pass, and across all their Spaces and deleted bots.
 */
export function reserveBotEmailSend(
  prisma: PrismaClient,
  send: { userId: string; botId: string },
  limits: { bot: number; owner: number },
  now = new Date(),
): Promise<{ id: string } | "bot" | "owner"> {
  const since = new Date(now.getTime() - DAY_MS);
  return runAsSystem(REASON, () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`bot-email-send:${send.userId}`}, 0))::text AS "lock"`;
      await tx.botEmailSend.deleteMany({ where: { userId: send.userId, sentAt: { lt: since } } });
      const today = await tx.botEmailSend.findMany({
        where: { userId: send.userId },
        select: { botId: true },
      });
      if (today.filter((row) => row.botId === send.botId).length >= limits.bot) return "bot";
      if (today.length >= limits.owner) return "owner";
      return tx.botEmailSend.create({ data: { ...send, sentAt: now }, select: { id: true } });
    }),
  );
}

/** Give back a reserved send that did not go out. */
export async function releaseBotEmailSend(prisma: PrismaClient, id: string): Promise<void> {
  await runAsSystem(REASON, () => prisma.botEmailSend.deleteMany({ where: { id } }));
}
