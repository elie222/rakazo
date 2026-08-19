import type { ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";

export async function loadMessagePage(
  prisma: PrismaClient,
  threadId: string,
  before: number | undefined,
  pageSize: number,
  around?: { messageId?: string; seq?: number },
): Promise<ThreadMessagePage> {
  if (around) {
    let targetSeq = around.seq;
    if (targetSeq === undefined && around.messageId) {
      const row = await prisma.message.findFirst({
        where: { id: around.messageId, threadId },
        select: { seq: true },
      });
      targetSeq = row?.seq;
    }
    if (targetSeq !== undefined) {
      const half = Math.floor(pageSize / 2);
      const minSeq = Math.max(0, targetSeq - half);
      const maxSeq = targetSeq + half;
      const rows = await prisma.message.findMany({
        where: { threadId, seq: { gte: minSeq, lte: maxSeq } },
        orderBy: { seq: "asc" },
        take: pageSize,
      });
      const first = rows[0];
      const hasOlder = first
        ? (await prisma.message.count({ where: { threadId, seq: { lt: first.seq } } })) > 0
        : false;
      return {
        threadId,
        messages: rows.map(toThreadMessage),
        olderCursor: hasOlder ? (first?.seq ?? null) : null,
      };
    }
  }

  const rows = await prisma.message.findMany({
    where: {
      threadId,
      ...(before === undefined ? {} : { seq: { lt: before } }),
    },
    orderBy: { seq: "desc" },
    take: pageSize + 1,
  });
  const hasOlder = rows.length > pageSize;
  const messages = rows.slice(0, pageSize).reverse().map(toThreadMessage);
  return {
    threadId,
    messages,
    olderCursor: hasOlder ? (messages[0]?.seq ?? null) : null,
  };
}

export async function loadAllMessages(
  prisma: PrismaClient,
  threadId: string,
  pageSize: number,
): Promise<ThreadMessage[]> {
  const pages: ThreadMessage[][] = [];
  let before: number | undefined;
  do {
    const page = await loadMessagePage(prisma, threadId, before, pageSize);
    pages.push(page.messages);
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return pages.reverse().flat();
}

function toThreadMessage(row: {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  runId: string | null;
  createdAt: Date;
}): ThreadMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as ThreadMessage["role"],
    blocks: row.blocks as ThreadMessage["blocks"],
    runId: row.runId ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}
