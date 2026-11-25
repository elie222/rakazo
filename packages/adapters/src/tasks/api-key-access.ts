import type { PrismaClient } from "@rakazo/db";

/**
 * Whether an API key may still act for its person in a Space: the key is enabled, the account
 * is on and the person is still a member. Live streams and task callbacks both stop on it.
 */
export async function apiKeyStillGrants(
  prisma: Pick<PrismaClient, "apiKey" | "spaceMember">,
  grant: { keyId: string; userId: string; spaceId: string },
): Promise<boolean> {
  const [key, member] = await Promise.all([
    prisma.apiKey.findFirst({
      where: {
        id: grant.keyId,
        referenceId: grant.userId,
        enabled: { not: false },
        user: { deactivatedAt: null },
      },
      select: { id: true },
    }),
    prisma.spaceMember.findFirst({
      where: { userId: grant.userId, spaceId: grant.spaceId, space: { deletingAt: null } },
      select: { userId: true },
    }),
  ]);
  return Boolean(key && member);
}
