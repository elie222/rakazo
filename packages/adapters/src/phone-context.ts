import type { PrismaClient } from "@rakazo/db";

/**
 * Executor dep answering "does this bot belong to a phone identity?" — one
 * indexed query per run, and none at all when the phone surface is absent.
 */
export function createPhoneContextLoader(prisma: PrismaClient) {
  return {
    hasIdentity: async (botId: string): Promise<boolean> =>
      Boolean(await prisma.phoneIdentity.findUnique({ where: { botId }, select: { id: true } })),
  };
}
