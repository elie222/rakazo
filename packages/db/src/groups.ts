import {
  type Actor,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
  type Group,
  type GroupMember,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

const activeRunStatuses = [...ACTIVE_RUN_STATUSES];
const activeRunSelection = {
  where: { status: { in: activeRunStatuses } },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
} as const;

type GroupRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  pinned: boolean;
  sectionId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  thread: {
    id: string;
    unread: boolean;
    messages: Array<{ blocks: unknown }>;
  } | null;
  members: Array<{
    bot: {
      id: string;
      name: string;
      color: string;
      runs: Array<{ status: string }>;
    };
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
    pinned: group.pinned,
    sectionId: group.sectionId,
    archivedAt: group.archivedAt?.toISOString() ?? null,
    members: group.members.map((member) => ({
      botId: member.bot.id,
      name: member.bot.name,
      color: member.bot.color,
      status: member.bot.runs[0]?.status ?? "idle",
    })),
    threadId: group.thread.id,
    preview,
    unread: group.thread.unread,
    updatedAt: group.updatedAt.toISOString(),
    createdAt: group.createdAt.toISOString(),
  };
}

function hasMinimumActiveMembers(members: readonly unknown[]) {
  return members.length >= GROUP_MEMBER_MIN;
}

async function assertOwnedBots(
  prisma: PrismaClient,
  actor: Actor,
  botIds: string[],
): Promise<GroupMember[]> {
  const unique = [...new Set(botIds)];
  if (unique.length < GROUP_MEMBER_MIN || unique.length > GROUP_MEMBER_MAX) {
    throw new IsolationError(
      `Groups require ${GROUP_MEMBER_MIN} to ${GROUP_MEMBER_MAX} distinct bots`,
    );
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
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  return unique.map((botId) => {
    const bot = botsById.get(botId);
    if (!bot) throw new IsolationError();
    return { botId: bot.id, name: bot.name, color: bot.color };
  });
}

const groupInclude = {
  thread: {
    include: {
      messages: { orderBy: { seq: "desc" as const }, take: 1 },
    },
  },
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          runs: activeRunSelection,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

const groupTargetInclude = {
  thread: { select: { id: true } },
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          runs: activeRunSelection,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

export function createGroupRepos(prisma: PrismaClient) {
  return {
    async listGroups(actor: Actor, options: { archived?: boolean } = {}): Promise<Group[]> {
      const groups = await prisma.chatGroup.findMany({
        where: {
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          archivedAt: options.archived ? { not: null } : null,
        },
        include: groupInclude,
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      });
      return groups
        .filter((group) => hasMinimumActiveMembers(group.members))
        .map((group) => mapGroup(group as GroupRecord));
    },

    async getGroup(actor: Actor, groupId: string, options: { includeArchived?: boolean } = {}) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
        include: groupInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return group as GroupRecord;
    },

    async getGroupTarget(actor: Actor, groupId: string) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          archivedAt: null,
        },
        include: groupTargetInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return group;
    },

    async createGroup(actor: Actor, input: { name: string; botIds: string[] }): Promise<Group> {
      const members = await assertOwnedBots(prisma, actor, input.botIds);
      const created = await prisma.$transaction(async (tx) => {
        const group = await tx.chatGroup.create({
          data: {
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            name: input.name.trim(),
          },
        });
        await tx.chatGroupMember.createMany({
          data: members.map((member) => ({ groupId: group.id, botId: member.botId })),
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
      input: {
        groupId: string;
        name?: string;
        botIds?: string[];
        pinned?: boolean;
        sectionId?: string | null;
      },
    ): Promise<{ group: Group; cancelledRunIds: string[] }> {
      const members = input.botIds ? await assertOwnedBots(prisma, actor, input.botIds) : undefined;
      const updated = await prisma.$transaction(async (tx) => {
        await lockOwnedGroup(tx, actor, input.groupId);
        const current = await tx.chatGroup.findFirst({
          where: {
            id: input.groupId,
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          include: {
            members: { select: { botId: true, bot: { select: { archivedAt: true } } } },
            thread: { select: { id: true } },
          },
        });
        if (!current?.thread) throw new IsolationError();
        if (
          !members &&
          !hasMinimumActiveMembers(
            current.members.filter((member) => member.bot.archivedAt === null),
          )
        ) {
          throw new IsolationError();
        }
        const nextBotIds = new Set(
          members?.map((member) => member.botId) ?? current.members.map((member) => member.botId),
        );
        const removedBotIds = current.members
          .map((member) => member.botId)
          .filter((botId) => !nextBotIds.has(botId));
        const activeRuns = removedBotIds.length
          ? await tx.run.findMany({
              where: {
                threadId: current.thread.id,
                botId: { in: removedBotIds },
                status: {
                  in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                },
              },
              select: { id: true, taskId: true },
            })
          : [];
        if (activeRuns.length) {
          const now = new Date();
          await tx.run.updateMany({
            where: { id: { in: activeRuns.map((run) => run.id) } },
            data: {
              status: "cancelled",
              completedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
            },
          });
          await tx.attempt.updateMany({
            where: { runId: { in: activeRuns.map((run) => run.id) }, status: "running" },
            data: { status: "cancelled", finishedAt: now },
          });
          await tx.task.updateMany({
            where: { id: { in: activeRuns.map((run) => run.taskId) } },
            data: { status: "cancelled" },
          });
        }
        if (input.name !== undefined) {
          await tx.chatGroup.update({
            where: { id: input.groupId },
            data: { name: input.name.trim() },
          });
        }
        if (members) {
          await tx.chatGroupMember.deleteMany({ where: { groupId: input.groupId } });
          await tx.chatGroupMember.createMany({
            data: members.map((member) => ({ groupId: input.groupId, botId: member.botId })),
          });
        }
        await tx.chatGroup.update({
          where: { id: input.groupId },
          data: {
            updatedAt: new Date(),
            pinned: input.pinned,
            sectionId: input.sectionId,
          },
        });
        return tx.chatGroup
          .findFirstOrThrow({
            where: { id: input.groupId },
            include: groupInclude,
          })
          .then((group) => ({ group, cancelledRunIds: activeRuns.map((run) => run.id) }));
      });
      if (!updated.group.thread) throw new IsolationError();
      return {
        group: mapGroup(updated.group as GroupRecord),
        cancelledRunIds: updated.cancelledRunIds,
      };
    },

    async archiveGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockOwnedGroup(tx, actor, groupId);
        const current = await tx.chatGroup.findFirst({
          where: {
            id: groupId,
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          select: { thread: { select: { id: true } } },
        });
        if (!current?.thread) throw new IsolationError();

        const activeRuns = await tx.run.findMany({
          where: {
            threadId: current.thread.id,
            status: { in: activeRunStatuses },
          },
          select: { id: true, taskId: true },
        });
        const runIds = activeRuns.map((run) => run.id);
        const now = new Date();
        const computers = runIds.length
          ? await tx.computer.findMany({
              where: { executionRunId: { in: runIds } },
              select: {
                homeKey: true,
                kind: true,
                providerRef: true,
                executionBotId: true,
              },
            })
          : [];

        if (runIds.length) {
          await tx.run.updateMany({
            where: { id: { in: runIds } },
            data: {
              status: "cancelled",
              completedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
            },
          });
          await tx.attempt.updateMany({
            where: { runId: { in: runIds }, status: "running" },
            data: { status: "cancelled", finishedAt: now },
          });
          await tx.task.updateMany({
            where: { id: { in: activeRuns.map((run) => run.taskId) } },
            data: { status: "cancelled" },
          });
          await tx.computerExecutionLease.deleteMany({ where: { runId: { in: runIds } } });
          await tx.computer.updateMany({
            where: { executionRunId: { in: runIds } },
            data: {
              executionRunId: null,
              executionBotId: null,
              executionLeaseExpiresAt: null,
            },
          });
          await tx.event.deleteMany({
            where: { type: "thread.progress", runId: { in: runIds } },
          });
        }

        await tx.chatGroup.update({
          where: { id: groupId },
          data: { archivedAt: now, pinned: false },
        });

        return { cancelledRunIds: runIds, computers };
      });
    },

    async restoreGroup(actor: Actor, groupId: string) {
      const restored = await prisma.chatGroup.updateMany({
        where: { id: groupId, workspaceId: actor.workspaceId, userId: actor.userId },
        data: { archivedAt: null },
      });
      if (restored.count !== 1) throw new IsolationError();
    },

    async removeGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockOwnedGroup(tx, actor, groupId);
        const group = await tx.chatGroup.findUnique({
          where: { id: groupId },
          select: {
            artifacts: { select: { storageKey: true } },
            members: { orderBy: { createdAt: "asc" }, take: 1, select: { botId: true } },
          },
        });
        const contextBotId = group?.members[0]?.botId;
        if (!contextBotId) throw new IsolationError();
        await tx.chatGroup.delete({ where: { id: groupId } });
        return {
          contextBotId,
          artifactStorageKeys: group.artifacts.map((artifact) => artifact.storageKey),
        };
      });
    },

    mapGroup,
  };
}

export async function lockOwnedGroup(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: Pick<Actor, "workspaceId" | "userId">,
  groupId: string,
) {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM chat_groups
    WHERE id = ${groupId}
      AND "workspaceId" = ${actor.workspaceId}
      AND "userId" = ${actor.userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new IsolationError();
}

export async function touchGroupUpdatedAt(
  prisma: Pick<Prisma.TransactionClient, "chatGroup">,
  groupId: string,
) {
  await prisma.chatGroup.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });
}
