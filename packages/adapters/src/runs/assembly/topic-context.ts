import { blocksToAgentHistoryText, plainTextFromMarkdown, truncatePlainText } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { listTopics, loadTopicRoot, storedMessageBlocks } from "@rakazo/db";
import { topicActivityNote, topicRootNote } from "./topic-context.prompt.js";

/** How much of a thread's root message a thread run reads. */
const ROOT_TEXT_LIMIT = 20_000;
/** At most this many changed threads are summarized for a chat run. */
const ACTIVITY_LIMIT = 8;
const LATEST_EXCERPT_LIMIT = 200;

/** The note leading a topic run's history, or none for a run outside a topic. */
export async function loadTopicRootContext(
  prisma: PrismaClient,
  thread: { id: string; parentMessageId: string | null },
): Promise<string | undefined> {
  if (!thread.parentMessageId) return undefined;
  const root = await loadTopicRoot(prisma, thread.id);
  if (!root) return undefined;
  const text = blocksToAgentHistoryText(storedMessageBlocks(root)).slice(0, ROOT_TEXT_LIMIT);
  return topicRootNote({ fromBot: root.role === "bot", text });
}

/**
 * For a run in a bot's own chat: the threads with replies after `since`, open or done, each with
 * its newest message in brief. Their replies never enter the chat's history, so this is how the
 * chat hears about them.
 */
export async function loadTopicActivityContext(
  prisma: PrismaClient,
  input: { mainThreadId: string; userId: string; since: Date | undefined },
): Promise<string | undefined> {
  const since = input.since?.toISOString() ?? "";
  const changed = (await listTopics(prisma, input))
    .filter((topic) => topic.replyCount > 0 && topic.lastActivityAt > since)
    .slice(0, ACTIVITY_LIMIT);
  if (!changed.length) return undefined;
  const latest = await Promise.all(
    changed.map((topic) =>
      prisma.message.findFirst({
        where: { threadId: topic.id },
        orderBy: { seq: "desc" },
        select: { id: true, blocks: true },
      }),
    ),
  );
  return topicActivityNote(
    changed.map((topic, index) => {
      const message = latest[index];
      const text = message ? blocksToAgentHistoryText(storedMessageBlocks(message)) : "";
      return {
        title: topic.title,
        replyCount: topic.replyCount,
        done: topic.settledBy !== null,
        latest: truncatePlainText(plainTextFromMarkdown(text), LATEST_EXCERPT_LIMIT),
      };
    }),
  );
}
