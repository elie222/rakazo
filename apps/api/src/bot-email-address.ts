import { ORPCError } from "@orpc/server";
import type { BotEmailAddress } from "@rakazo/contracts";
import { BOT_EMAIL_NAME_TAKEN } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "./routes/shared.js";

export const EMAIL_NOT_RECEIVED = "This server doesn't receive email.";

/** The bot's address, once claimed; null when this server receives no email. */
export async function botEmailAddress(
  prisma: PrismaClient,
  domain: string | undefined,
  botId: string,
): Promise<BotEmailAddress> {
  if (!domain) return null;
  const row = await prisma.botEmailAddress.findUnique({
    where: { botId },
    select: { name: true },
  });
  return { domain, address: row ? `${row.name}@${domain}` : null };
}

/**
 * Give the bot `name`@domain for good. A name is never reissued, even after
 * its bot is deleted, so mail meant for one bot never reaches another.
 */
export async function claimBotEmailAddress(
  prisma: PrismaClient,
  domain: string | undefined,
  botId: string,
  name: string,
): Promise<{ address: string }> {
  if (!domain) throw new ORPCError("BAD_REQUEST", { message: EMAIL_NOT_RECEIVED });
  const existing = await prisma.botEmailAddress.findUnique({
    where: { botId },
    select: { name: true },
  });
  if (existing && existing.name !== name) {
    throw new ORPCError("CONFLICT", { message: "This bot already has an address." });
  }
  if (!existing) {
    try {
      await prisma.botEmailAddress.create({ data: { name, botId } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either the name is taken, or a concurrent claim for this bot won with this same name.
      const winner = await prisma.botEmailAddress.findUnique({
        where: { name },
        select: { botId: true },
      });
      if (winner?.botId !== botId) {
        throw new ORPCError("CONFLICT", { message: BOT_EMAIL_NAME_TAKEN });
      }
    }
  }
  return { address: `${name}@${domain}` };
}

/** An email trigger needs a server that receives mail and a bot with an address. */
export async function assertEmailTrigger(
  prisma: PrismaClient,
  domain: string | undefined,
  botId: string,
): Promise<void> {
  if (!domain) throw new ORPCError("BAD_REQUEST", { message: EMAIL_NOT_RECEIVED });
  const row = await prisma.botEmailAddress.findUnique({
    where: { botId },
    select: { botId: true },
  });
  if (!row) {
    throw new ORPCError("BAD_REQUEST", { message: "Choose an email address for this bot first." });
  }
}
