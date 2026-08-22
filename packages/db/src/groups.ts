import type { Actor, Group, GroupMember } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

const GROUP_MEMBER_MIN = 2;
const GROUP_MEMBER_MAX = 6;

type GroupRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  thread: {
    id: string;
    unread: boolean;
    messages: Array<{ blocks: unknown }>;
  } | null;
  members: Array<{
    bot: { id: string; name: string; color: string };
  }>;
};

function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return "";
}

function mapGroup(group: GroupRecord): Group {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  const preview = previewFromBlocks(group.thread.messages[0]?.blocks);
  return {
    id: group.id,
    workspaceId: group.workspaceId,
    name: group.name,
    members: group.members.map((member) => ({
      botId: member.bot.id,
      name: member.bot.name,
      color: member.bot.color,
    })),
    threadId: group.thread.id,
    preview,
    unread: group.thread.unread,
    updatedAt: group.updatedAt.toISOString(),
    createdAt: group.createdAt.toISOString(),
  };
}

async function assertOwnedBots(
  prisma: PrismaClient,
  actor: Actor,
  botIds: string[],
): Promise<GroupMember[]> {
  const unique = [...new Set(botIds)];
  if (unique.length < GROUP_MEMBER_MIN || unique.length > GROUP_MEMBER_MAX) {
    throw new IsolationError("Groups require 2 to 6 distinct bots");
  }
  const bots = await prisma.bot.findMany({
    where: {
      id: { in: unique },
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      archivedAt: null,
    },
    select: { id: true, name: true, color: true },
  });
  if (bots.length !== unique.length) throw new IsolationError();
  return bots.map((bot) => ({ botId: bot.id, name: bot.name, color: bot.color }));
}

const groupInclude = {
  thread: {
    include: {
      messages: { orderBy: { seq: "desc" as const }, take: 1 },
    },
  },
  members: {
    include: { bot: { select: { id: true, name: true, color: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

export function createGroupRepos(prisma: PrismaClient) {
  return {
    async listGroups(actor: Actor): Promise<Group[]> {
      const groups = await prisma.chatGroup.findMany({
        where: { workspaceId: actor.workspaceId, userId: actor.userId },
        include: groupInclude,
        orderBy: { updatedAt: "desc" },
      });
      return groups.map((group) => mapGroup(group as GroupRecord));
    },

    async getGroup(actor: Actor, groupId: string) {
      const group = await prisma.chatGroup.findFirst({
        where: { id: groupId, workspaceId: actor.workspaceId, userId: actor.userId },
        include: groupInclude,
      });
      if (!group) throw new IsolationError();
      return group as GroupRecord;
    },

    async createGroup(actor: Actor, input: { name: string; botIds: string[] }): Promise<Group> {
      await assertOwnedBots(prisma, actor, input.botIds);
      const created = await prisma.$transaction(async (tx) => {
        const group = await tx.chatGroup.create({
          data: {
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            name: input.name.trim(),
          },
        });
        await tx.chatGroupMember.createMany({
          data: input.botIds.map((botId) => ({ groupId: group.id, botId })),
        });
        await tx.thread.create({
          data: {
            workspaceId: actor.workspaceId,
            groupId: group.id,
            userId: actor.userId,
          },
        });
        return tx.chatGroup.findFirstOrThrow({
          where: { id: group.id },
          include: groupInclude,
        });
      });
      return mapGroup(created as GroupRecord);
    },

    async updateGroup(
      actor: Actor,
      input: { groupId: string; name?: string; botIds?: string[] },
    ): Promise<Group> {
      await this.getGroup(actor, input.groupId);
      if (input.botIds) await assertOwnedBots(prisma, actor, input.botIds);
      const updated = await prisma.$transaction(async (tx) => {
        if (input.name !== undefined) {
          await tx.chatGroup.update({
            where: { id: input.groupId },
            data: { name: input.name.trim() },
          });
        }
        if (input.botIds) {
          await tx.chatGroupMember.deleteMany({ where: { groupId: input.groupId } });
          await tx.chatGroupMember.createMany({
            data: input.botIds.map((botId) => ({ groupId: input.groupId, botId })),
          });
        }
        await tx.chatGroup.update({
          where: { id: input.groupId },
          data: { updatedAt: new Date() },
        });
        return tx.chatGroup.findFirstOrThrow({
          where: { id: input.groupId },
          include: groupInclude,
        });
      });
      if (!updated.thread) throw new IsolationError();
      return mapGroup(updated as GroupRecord);
    },

    async removeGroup(actor: Actor, groupId: string): Promise<void> {
      await this.getGroup(actor, groupId);
      await prisma.chatGroup.delete({ where: { id: groupId } });
    },

    mapGroup,
  };
}

export async function touchGroupUpdatedAt(prisma: PrismaClient, groupId: string) {
  await prisma.chatGroup.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });
}

export { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN };
