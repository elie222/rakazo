import type { PinnedMessage } from "@rakazo/contracts";
import { MessageBlock, MessageRole } from "@rakazo/contracts";
import { ClientError, canPinMessage } from "@rakazo/core";
import { messageReplyPreview } from "@rakazo/core/message-quote";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { readMessageBlocks, THREAD_LOCK_TRANSACTION_OPTIONS } from "@rakazo/db";
import { withoutPeerRunMessages } from "./thread-message-pages.js";

const maxPins = 20;
const pinSelection = {
  id: true,
  role: true,
  blocks: true,
  runId: true,
  replyToMessageId: true,
  pinnedAt: true,
} as const;

type PinRow = Prisma.MessageGetPayload<{ select: typeof pinSelection }>;

function pinPreview(row: PinRow): PinnedMessage | null {
  const role = MessageRole.safeParse(row.role);
  const stored = readMessageBlocks(row);
  const blocks = MessageBlock.array().safeParse(stored.blocks);
  if (
    !role.success ||
    !stored.intact ||
    !blocks.success ||
    !canPinMessage({ ...row, blocks: blocks.data })
  )
    return null;
  const preview = messageReplyPreview(blocks.data, role.data);
  return {
    messageId: row.id,
    text: preview.text,
    ...(preview.attachment?.kind === "image" ? { image: true } : {}),
  };
}

function readPinRows(prisma: Prisma.TransactionClient, threadId: string) {
  return prisma.message.findMany({
    where: { threadId, pinnedAt: { not: null } },
    orderBy: [{ pinnedAt: "desc" }, { seq: "desc" }],
    take: maxPins,
    select: pinSelection,
  });
}

async function visiblePins(prisma: Prisma.TransactionClient, rows: PinRow[]) {
  const visible = await withoutPeerRunMessages(prisma, rows);
  return visible.flatMap((row) => pinPreview(row) ?? []);
}

export async function listMessagePins(prisma: PrismaClient, threadId: string) {
  return visiblePins(prisma, await readPinRows(prisma, threadId));
}

export async function setMessagePin(
  prisma: PrismaClient,
  threadId: string,
  messageId: string,
  pinned: boolean,
) {
  await prisma.$transaction(async (tx) => {
    // Serialize the limit check with other pins in this thread and with clearing its history.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR NO KEY UPDATE`;
    const where = { id: messageId, threadId };
    if (!pinned) {
      await tx.message.updateMany({ where, data: { pinnedAt: null } });
      return;
    }
    const row = await tx.message.findFirst({ where, select: pinSelection });
    if (!row || !pinPreview(row) || (await withoutPeerRunMessages(tx, [row])).length === 0)
      throw new ClientError("NOT_FOUND", "Message not found.");
    if (row.pinnedAt) return;
    const pins = await readPinRows(tx, threadId);
    if (pins.length === maxPins) {
      const visible = await visiblePins(tx, pins);
      if (visible.length === maxPins) {
        throw new ClientError("CONFLICT", "Unpin a message before adding another.");
      }
      const visibleIds = new Set(visible.map((pin) => pin.messageId));
      await tx.message.updateMany({
        where: {
          threadId,
          id: { in: pins.filter((pin) => !visibleIds.has(pin.id)).map((pin) => pin.id) },
        },
        data: { pinnedAt: null },
      });
    }
    const result = await tx.message.updateMany({ where, data: { pinnedAt: new Date() } });
    if (result.count === 0) throw new ClientError("NOT_FOUND", "Message not found.");
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}
