import { BACKGROUND_HELPER_TRIGGER, HELPER_RESULT_TRIGGER, isOwnerStartedRun } from "@rakazo/core";
import type { PrismaClient, Run } from "@rakazo/db";
import { storedMessageBlocks } from "@rakazo/db";

type RunOrigin = Pick<
  Run,
  "id" | "botId" | "spaceId" | "userId" | "trigger" | "delegatedFromRunId"
>;

export function isDelegatedRun(trigger: string): boolean {
  return trigger === BACKGROUND_HELPER_TRIGGER || trigger === HELPER_RESULT_TRIGGER;
}

/**
 * The member started this run itself. `ownerStartedRun` follows the conversation a spawn came
 * from, so a channel, routine, webhook, bot message, or spawn stays out even when that
 * conversation was theirs.
 */
export function runStartedByMember(
  trigger: string,
  source: { ownerStartedRun: boolean; nonOwnerChat: boolean },
): boolean {
  return isOwnerStartedRun(trigger, source.ownerStartedRun) && !source.nonOwnerChat;
}

/** Resolve the conversation that authorized delegation, including after restart or a result wake. */
export async function loadRunOrigin(prisma: PrismaClient, run: RunOrigin) {
  if (!isDelegatedRun(run.trigger)) return null;
  let id = run.delegatedFromRunId;
  for (let depth = 0; id && depth < 2; depth++) {
    const origin = await prisma.run.findFirst({
      where: { id, botId: run.botId, spaceId: run.spaceId, userId: run.userId },
      include: {
        thread: {
          include: {
            group: {
              select: {
                archivedAt: true,
                members: { where: { botId: run.botId }, select: { botId: true } },
              },
            },
          },
        },
        sourceMessage: true,
      },
    });
    if (!origin) return null;
    if (origin.status === "cancelled") {
      // Typing an answer retires a waiting parent, without revoking its delegated work.
      const replies = await prisma.message.findMany({
        where: { runId: origin.id, threadId: origin.threadId, role: "bot" },
        select: { id: true, blocks: true },
      });
      if (
        !replies.some((reply) =>
          storedMessageBlocks(reply).some(
            (block) =>
              block.kind === "ask" && block.status === "answered" && Boolean(block.answerMessageId),
          ),
        )
      )
        return null;
    }
    if (
      origin.thread?.groupId &&
      (!origin.thread.group ||
        origin.thread.group.archivedAt ||
        !origin.thread.group.members.length)
    )
      return null;
    if (!isDelegatedRun(origin.trigger)) {
      if (["user", "follow_up", "messaging"].includes(origin.trigger) && !origin.sourceMessage)
        return null;
      return origin;
    }
    id = origin.delegatedFromRunId;
  }
  return null;
}
