import type { MessageBlock, ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import { isPeerReceiptBlocks } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

type MessageDb = PrismaClient | Prisma.TransactionClient;

export async function decorateExternalMessagePage(
  prisma: MessageDb,
  externalConversationId: string,
  page: ThreadMessagePage,
): Promise<ThreadMessagePage> {
  const messageIds = page.messages.map((message) => message.id);
  if (messageIds.length === 0) return page;

  const externalMessages = await prisma.externalMessage.findMany({
    where: {
      externalConversationId,
      OR: [
        { threadMessageId: { in: messageIds } },
        { run: { is: { sourceMessageId: { in: messageIds } } } },
      ],
    },
    select: {
      senderName: true,
      content: true,
      threadMessageId: true,
      run: { select: { sourceMessageId: true } },
    },
  });
  const visibleByMessageId = new Map(
    externalMessages.flatMap((message) =>
      message.threadMessageId ? [[message.threadMessageId, message] as const] : [],
    ),
  );
  const hiddenMessageIds = new Set(
    externalMessages.flatMap((message) => {
      const sourceMessageId = message.run?.sourceMessageId;
      return sourceMessageId && sourceMessageId !== message.threadMessageId
        ? [sourceMessageId]
        : [];
    }),
  );

  return {
    ...page,
    messages: page.messages.flatMap((message) => {
      if (hiddenMessageIds.has(message.id)) return [];
      const externalMessage = visibleByMessageId.get(message.id);
      if (!externalMessage) return [message];
      return [
        {
          ...message,
          speakerName: externalMessage.senderName,
          blocks: [{ kind: "text" as const, text: externalMessage.content }],
        },
      ];
    }),
  };
}

export async function loadMessagePage(
  prisma: MessageDb,
  threadId: string,
  before: number | undefined,
  pageSize: number,
  around?: { messageId?: string; seq?: number },
  includePeerRuns = false,
  includePeerReceipts = false,
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
        ? (await prisma.message.count({
            where: { threadId, seq: { lt: first.seq } },
          })) > 0
        : false;
      // Peer text/activity stays out of the normal transcript (including the
      // around target). Receipts remain via withoutPeerRunMessages; full peer
      // history belongs in the bot-messages overlay (includePeerRuns).
      const messages = includePeerRuns ? rows : await withoutPeerRunMessages(prisma, rows);
      return {
        threadId,
        messages: messages.map(toThreadMessage),
        olderCursor: hasOlder ? (first?.seq ?? null) : null,
      };
    }
  }

  let cursor = before;
  while (true) {
    const rows = await prisma.message.findMany({
      where: {
        threadId,
        ...(cursor === undefined ? {} : { seq: { lt: cursor } }),
      },
      orderBy: { seq: "desc" },
      take: pageSize + 1,
    });
    const hasOlder = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize).reverse();
    const visibleRows = includePeerRuns ? pageRows : await withoutPeerRunMessages(prisma, pageRows);
    // Web hides receipts client-side, so its receipt-only pages keep scanning.
    // Mobile explicitly retains them and must receive each page for pagination.
    const hasSubstantive = visibleRows.some(
      (row) => !isPeerReceiptBlocks(row.blocks as MessageBlock[]),
    );
    if (hasSubstantive || includePeerReceipts || !hasOlder || includePeerRuns) {
      return {
        threadId,
        messages: visibleRows.map(toThreadMessage),
        olderCursor: hasOlder ? (pageRows[0]?.seq ?? null) : null,
      };
    }
    // TODO: only rescan when a raw page is entirely peer output. Consider a run relation if
    // long peer-only histories make this path hot.
    cursor = pageRows[0]?.seq;
  }
}

export async function loadAllMessages(
  prisma: PrismaClient,
  threadId: string,
  pageSize: number,
): Promise<ThreadMessage[]> {
  const pages: ThreadMessage[][] = [];
  let before: number | undefined;
  do {
    const page = await loadMessagePage(prisma, threadId, before, pageSize, undefined, true);
    pages.push(page.messages);
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return pages.reverse().flat();
}

async function withoutPeerRunMessages<T extends { runId: string | null; blocks: Prisma.JsonValue }>(
  prisma: MessageDb,
  rows: T[],
): Promise<T[]> {
  const runIds = [...new Set(rows.flatMap((row) => (row.runId ? [row.runId] : [])))];
  if (runIds.length === 0) return rows;
  const peerRuns = await prisma.run.findMany({
    where: { id: { in: runIds }, trigger: "bot_message" },
    select: { id: true },
  });
  const peerRunIds = new Set(peerRuns.map((run) => run.id));
  return rows.filter((row) => {
    if (!row.runId || !peerRunIds.has(row.runId)) return true;
    // Keep compact sent/received receipts; clients render them as chips.
    const blocks = row.blocks as MessageBlock[];
    return blocks.some(
      (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
    );
  });
}

export async function isPeerRun(
  prisma: MessageDb,
  runId: string | undefined,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!runId) return false;
  let peerRun = cache.get(runId);
  if (!peerRun) {
    peerRun = prisma.run
      .findUnique({ where: { id: runId }, select: { trigger: true } })
      .then((run) => run?.trigger === "bot_message");
    cache.set(runId, peerRun);
  }
  return peerRun;
}

function toThreadMessage(row: {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  runId: string | null;
  thumbsUp: boolean;
  createdAt: Date;
}): ThreadMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as ThreadMessage["role"],
    blocks: row.blocks as ThreadMessage["blocks"],
    botId: row.botId ?? undefined,
    replyToMessageId: row.replyToMessageId ?? undefined,
    runId: row.runId ?? undefined,
    thumbsUp: row.thumbsUp,
    createdAt: row.createdAt.toISOString(),
  };
}
