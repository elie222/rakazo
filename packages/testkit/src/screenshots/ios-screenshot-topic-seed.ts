import type { createDb } from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";

/** A thread of replies under the ready message, which its chat shows as a reply count. */
export async function ensureTopic(
  prisma: ReturnType<typeof createDb>["prisma"],
  rootText: string,
  bot: { id: string; threadId: string },
  userId: string,
): Promise<string> {
  const input = { threadId: bot.threadId, botId: bot.id, userId };
  const messages = await prisma.message.findMany({
    where: { threadId: input.threadId, role: "bot" },
    select: { id: true, blocks: true, thread: { select: { spaceId: true } } },
  });
  const root = messages.find((message) => JSON.stringify(message.blocks).includes(rootText));
  if (!root) throw new Error("The ready message is missing");
  const existing = await prisma.thread.findUnique({
    where: { parentMessageId: root.id },
    select: { id: true },
  });
  if (existing) return existing.id;
  const topic = await prisma.thread.create({
    data: { spaceId: root.thread.spaceId, userId: input.userId, parentMessageId: root.id },
    select: { id: true },
  });
  await createThreadMessage(prisma, {
    threadId: topic.id,
    role: "user",
    authorUserId: input.userId,
    blocks: [{ kind: "text", text: "Can you add the pricing quotes too?" }],
  });
  await createThreadMessage(prisma, {
    threadId: topic.id,
    role: "bot",
    botId: input.botId,
    blocks: [{ kind: "text", text: "Added two pricing quotes to the launch notes." }],
  });
  return topic.id;
}
