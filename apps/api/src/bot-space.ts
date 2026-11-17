import type { Actor } from "@rakazo/contracts";
import { GROUP_MEMBER_MIN } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

/** The other Space holding one of the caller's own bots, among the Spaces they belong to in any organization. */
export function otherSpaceOfBot(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<string | undefined> {
  return runAsSystem("find which of the caller's Spaces holds their bot", async () => {
    const bot = await prisma.bot.findFirst({
      where: {
        id: botId,
        userId: actor.userId,
        archivedAt: null,
        spaceId: { not: actor.spaceId },
        space: { deletingAt: null, memberships: { some: { userId: actor.userId } } },
      },
      select: { spaceId: true },
    });
    return bot?.spaceId;
  });
}

/**
 * The other Space where the caller can open a group, among the Spaces they belong to in any
 * organization. A group they cannot open there answers like one that does not exist.
 */
export function otherSpaceOfGroup(
  prisma: PrismaClient,
  actor: Actor,
  groupId: string,
): Promise<string | undefined> {
  return runAsSystem("find which of the caller's Spaces holds a group", async () => {
    const group = await prisma.chatGroup.findFirst({
      where: {
        id: groupId,
        archivedAt: null,
        spaceId: { not: actor.spaceId },
        space: { deletingAt: null, memberships: { some: { userId: actor.userId } } },
      },
      select: {
        spaceId: true,
        members: { where: { bot: { archivedAt: null } }, select: { botId: true } },
      },
    });
    // With fewer active bots the group's own Space lists it as archived, not as a chat.
    return group && group.members.length >= GROUP_MEMBER_MIN ? group.spaceId : undefined;
  });
}
