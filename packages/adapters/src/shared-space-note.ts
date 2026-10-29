import type { PrismaClient } from "@rakazo/db";

/**
 * In a space several people share, everyone reads every chat and the bot's
 * memory, while each turn acts with the connected accounts of whoever sent it.
 * The bot is told so it does not repeat one person's private details where
 * the others will read them. Personal spaces get no note.
 */
export function formatSharedSpaceNote(memberNames: string[], requesterName?: string): string {
  const names = memberNames.join(", ");
  return [
    `This space is shared by ${names}. Everyone in it can read this chat and your memory.`,
    requesterName
      ? `This turn uses ${requesterName}'s connected accounts. Share what you find in them only as far as ${requesterName} asks.`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function loadSharedSpaceNote(
  prisma: Pick<PrismaClient, "spaceMember">,
  spaceId: string,
  requesterUserId: string,
): Promise<string | undefined> {
  const members = await prisma.spaceMember.findMany({
    where: { spaceId },
    select: { userId: true, member: { select: { user: { select: { name: true } } } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (members.length < 2) return undefined;
  const requester = members.find((member) => member.userId === requesterUserId);
  return formatSharedSpaceNote(
    members.map((member) => member.member.user.name),
    requester?.member.user.name,
  );
}
