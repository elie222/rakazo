import type { Actor, RunActivityRow } from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  BACKGROUND_RUN_TRIGGERS,
  botMessageContext,
  displayName,
  HELPER_RESULT_TRIGGER,
  isRunWaitingOnUser,
  truncatePlainText,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { chatMutedByDefault, hiddenFor, mutedFor, ownerHearsChat, Prisma } from "@rakazo/db";

const RECENT_LIMIT = 20;
// Background ticket work belongs on the board, not in the activity list. A background helper and
// the turn passing on its result show in the chat, on the helper's card.
const ACTIVITY_HIDDEN_TRIGGERS = [
  ...BACKGROUND_RUN_TRIGGERS,
  BACKGROUND_HELPER_TRIGGER,
  HELPER_RESULT_TRIGGER,
] as const;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${truncatePlainText(oneLine, max - 1)}…`;
}

export function activityPreview(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): Pick<RunActivityRow, "promptSnippet" | "agentMessage"> {
  if (input.trigger !== "bot_message")
    return { promptSnippet: promptSnippet(input.prompt, max), agentMessage: null };
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) {
    return {
      promptSnippet: "Message from another agent",
      agentMessage: { kind: "unknown" },
    };
  }
  const name = displayName(message.fromBotName, "Another agent");
  const kind =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? "update"
      : "request";
  const label = kind === "update" ? `Update from ${name}` : `${name} asked`;
  return {
    promptSnippet: promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max),
    agentMessage: {
      fromBotName: displayName(message.fromBotName, ""),
      kind,
      text: promptSnippet(message.text, max),
    },
  };
}

/** A run of the viewer's own that needs them: it waits on them or failed. */
export function runNeedsOwner(run: { userId: string; status: string }, viewerId: string): boolean {
  return run.userId === viewerId && (isRunWaitingOnUser(run.status) || run.status === "failed");
}

/**
 * Whether the viewer hears from the run's chat: not when they muted or hid it. Their own run that
 * waits on them or failed still reaches them there, as its push does.
 */
export function activityNotificationsEnabled(
  thread: { groupId: string | null; reads: Array<{ muted: boolean | null; hidden: boolean }> },
  bot: { notifyOnFinish: boolean },
  ownerNeeded = false,
): boolean {
  const chatBot = thread.groupId === null ? bot : null;
  if (ownerNeeded) return ownerHearsChat(thread.reads[0]?.muted, chatMutedByDefault(chatBot));
  return !hiddenFor(thread) && !mutedFor(thread, chatBot);
}

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
): Promise<RunActivityRow[]> {
  const rows = await prisma.run.findMany({
    where:
      filter === "active"
        ? {
            spaceId: actor.spaceId,
            bot: { archivedAt: null },
            trigger: { notIn: [...ACTIVITY_HIDDEN_TRIGGERS] },
            status: { in: [...ACTIVE_RUN_STATUSES] },
          }
        : { spaceId: actor.spaceId, id: { in: await latestFinishedRunPerChat(prisma, actor) } },
    include: {
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true } },
          reads: { where: { userId: actor.userId }, select: { muted: true, hidden: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
  });

  return rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group ? row.thread.group.name : null,
    threadId: row.threadId,
    status: row.status as RunActivityRow["status"],
    trigger: row.trigger as RunActivityRow["trigger"],
    notificationsEnabled: activityNotificationsEnabled(
      row.thread,
      row.bot,
      runNeedsOwner(row, actor.userId),
    ),
    ...activityPreview({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
  }));
}

/** Recent lists chats keyed like `activitySections`, so one busy chat must not push the others out of the limit. */
async function latestFinishedRunPerChat(prisma: PrismaClient, actor: Actor): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM (
      SELECT DISTINCT ON (COALESCE('group:' || t."groupId", 'bot:' || r."botId")) r.id, r."completedAt", r."updatedAt"
      FROM runs r
      JOIN threads t ON t.id = r."threadId"
      JOIN bots b ON b.id = r."botId"
      WHERE r."spaceId" = ${actor.spaceId}
        AND b."archivedAt" IS NULL
        AND r.trigger NOT IN (${Prisma.join([...ACTIVITY_HIDDEN_TRIGGERS])})
        AND r.status IN (${Prisma.join([...TERMINAL_STATUSES])})
      ORDER BY COALESCE('group:' || t."groupId", 'bot:' || r."botId"), r."completedAt" DESC, r."updatedAt" DESC, r.id DESC
    ) latest
    ORDER BY "completedAt" DESC, "updatedAt" DESC, id DESC
    LIMIT ${RECENT_LIMIT}`;
  return rows.map((row) => row.id);
}
