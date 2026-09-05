import type { MessageBlock, ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import {
  isPeerReceiptBlocks,
  isPeerReportBlocks,
  isTakeoverRequestBlocks,
  terminalPeerSummaryIndexes,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

type MessageDb = PrismaClient | Prisma.TransactionClient;

export function isUserVisiblePeerRunEvent(event: {
  type: string;
  payload: { blocks?: unknown };
}): boolean {
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "computer.takeover.requested"
  ) {
    return true;
  }
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return false;
  }
  const blocks = event.payload.blocks;
  if (!Array.isArray(blocks)) return false;
  return (
    isPeerReceiptBlocks(blocks as MessageBlock[]) ||
    isTakeoverRequestBlocks(blocks as MessageBlock[])
  );
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
        ? (await prisma.message.count({ where: { threadId, seq: { lt: first.seq } } })) > 0
        : false;
      // Peer activity stays out of the normal transcript. Receipts and a
      // coordinator's user-facing report remain; assigned workers' replies
      // belong in the bot-messages overlay (includePeerRuns).
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

async function withoutPeerRunMessages<
  T extends {
    id: string;
    runId: string | null;
    seq?: number;
    clientNonce?: string | null;
    blocks: Prisma.JsonValue;
  },
>(prisma: MessageDb, rows: T[]): Promise<T[]> {
  const runIds = [...new Set(rows.flatMap((row) => (row.runId ? [row.runId] : [])))];
  if (runIds.length === 0) return rows;
  const peerRuns = await prisma.run.findMany({
    where: { id: { in: runIds }, trigger: "bot_message" },
    select: { id: true, sourceMessage: { select: { blocks: true } } },
  });
  const peerRunIds = new Set(peerRuns.map((run) => run.id));
  const peerReportRunIds = new Set(
    peerRuns
      .filter((run) =>
        isPeerReportBlocks(
          Array.isArray(run.sourceMessage?.blocks)
            ? (run.sourceMessage.blocks as MessageBlock[])
            : [],
        ),
      )
      .map((run) => run.id),
  );
  const peerReportMessages =
    peerReportRunIds.size > 0
      ? await prisma.message.findMany({
          where: { runId: { in: [...peerReportRunIds] } },
          orderBy: { seq: "asc" },
          select: { id: true, runId: true, seq: true, clientNonce: true, blocks: true },
        })
      : [];
  const terminalSummaryIndexes = terminalPeerSummaryIndexes(
    peerReportMessages.map((row) => ({
      runId: row.runId ?? undefined,
      seq: row.seq,
      clientNonce: row.clientNonce,
      blocks: row.blocks as MessageBlock[],
    })),
    peerReportRunIds,
  );
  const terminalSummaryIds = new Set(
    [...terminalSummaryIndexes].flatMap((index) => {
      const message = peerReportMessages[index];
      return message ? [message.id] : [];
    }),
  );
  return rows.flatMap((row) => {
    if (!row.runId || !peerRunIds.has(row.runId)) return [row];
    // Keep compact sent/received receipts. Only a coordinator woken by a
    // result/status/fyi may publish a final report to the user; a worker woken
    // by a request/question remains private to the peer exchange.
    const blocks = row.blocks as MessageBlock[];
    if (isTakeoverRequestBlocks(blocks)) return [row];
    if (
      blocks.some(
        (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
      )
    ) {
      return [row];
    }
    if (!peerReportRunIds.has(row.runId) || !terminalSummaryIds.has(row.id)) return [];

    // A terminal peer message can also contain steps/tool activity. Only the
    // owner-facing text belongs in the normal transcript.
    const summaryBlocks = blocks.filter(
      (block) => block.kind === "text" && block.text.trim().length > 0,
    );
    return [{ ...row, blocks: summaryBlocks as Prisma.JsonValue } as T];
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
