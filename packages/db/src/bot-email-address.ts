import type { PrismaClient } from "./client.js";

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/**
 * Give the bot `name` for good. A name is never reissued, even after its bot is deleted, so mail
 * meant for one bot never reaches another. Claiming the bot's own name again changes nothing.
 */
export async function claimBotEmailName(
  prisma: PrismaClient,
  botId: string,
  name: string,
): Promise<"claimed" | "taken" | "has-another"> {
  const existing = await prisma.botEmailAddress.findUnique({
    where: { botId },
    select: { localPart: true },
  });
  if (existing) return existing.localPart === name ? "claimed" : "has-another";
  try {
    await prisma.botEmailAddress.create({ data: { localPart: name, botId } });
    return "claimed";
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Either the name is taken, or a concurrent claim for this bot won with this same name.
    const winner = await prisma.botEmailAddress.findUnique({
      where: { localPart: name },
      select: { botId: true },
    });
    return winner?.botId === botId ? "claimed" : "taken";
  }
}
