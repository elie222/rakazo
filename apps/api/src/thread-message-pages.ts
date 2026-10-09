import type { MessageBlock, ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import {
  BACKGROUND_RUN_TRIGGERS,
  callIdFromClientNonce,
  isBackgroundRunTrigger,
  isPeerReceiptBlocks,
  isUserProgressClientNonce,
} from "@rakazo/core";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { messageReplyPreview } from "@rakazo/core/message-quote";
import type { Prisma, PrismaClient } from "@rakazo/db";

type MessageDb = PrismaClient | Prisma.TransactionClient;

const replySelection = {
  threadId: true,
  role: true,
  botId: true,
  blocks: true,
} as const;

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
        include: { replyTo: { select: replySelection } },
      });
      const truncated = rows.length >= pageSize;
      const coveredThroughSeq = truncated ? (rows[rows.length - 1]?.seq ?? maxSeq) : maxSeq;
      const first = rows[0];
      const hasOlder = first
        ? (await prisma.message.count({ where: { threadId, seq: { lt: first.seq } } })) > 0
        : false;
      // Peer text/activity stays out of the normal transcript (including the
      // around target). Receipts remain via withoutPeerRunMessages; full peer
      // history belongs in the bot-messages overlay (includePeerRuns).
      const messages = includePeerRuns ? rows : await withoutPeerRunMessages(prisma, rows);
      return {
        threadId,
        messages: messages.map(toThreadMessage),
        olderCursor: hasOlder ? (first?.seq ?? null) : null,
        coveredThroughSeq,
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
      include: { replyTo: { select: replySelection } },
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
    runId: string | null;
    blocks: Prisma.JsonValue;
    clientNonce?: string | null;
  },
>(prisma: MessageDb, rows: T[]): Promise<T[]> {
  const runIds = [...new Set(rows.flatMap((row) => (row.runId ? [row.runId] : [])))];
  if (runIds.length === 0) return rows;
  const runs = await prisma.run.findMany({
    where: {
      id: { in: runIds },
      trigger: { in: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
    },
    select: { id: true, trigger: true },
  });
  const backgroundRunIds = new Set(
    runs.filter((run) => isBackgroundRunTrigger(run.trigger)).map((r) => r.id),
  );
  const peerRunIds = new Set(
    runs.filter((run) => !backgroundRunIds.has(run.id)).map((run) => run.id),
  );
  return rows.filter((row) => {
    if (!row.runId) return true;
    const blocks = row.blocks as MessageBlock[];
    if (backgroundRunIds.has(row.runId)) {
      // Ticket work stays off the transcript. An explicit `message_user` update,
      // an ask card, or a computer block is the bot deliberately reaching the user.
      return (
        isUserProgressClientNonce(row.clientNonce) ||
        blocks.some((block) => block.kind === "ask" || block.kind === "computer")
      );
    }
    if (!peerRunIds.has(row.runId)) return true;
    // Keep peer receipts (chips), ask cards, and the bot's own text reply.
    return blocks.some(
      (block) =>
        block.kind === "bot_message_sent" ||
        block.kind === "bot_message_received" ||
        block.kind === "ask" ||
        block.kind === "text",
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

export async function isBackgroundRun(
  prisma: MessageDb,
  runId: string | undefined,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!runId) return false;
  let backgroundRun = cache.get(runId);
  if (!backgroundRun) {
    backgroundRun = prisma.run
      .findUnique({ where: { id: runId }, select: { trigger: true } })
      .then((run) => isBackgroundRunTrigger(run?.trigger));
    cache.set(runId, backgroundRun);
  }
  return backgroundRun;
}

/** Peer-run SSE events that must still reach an open thread (terminals, waits, receipts, asks, text). */
export function shouldForwardPeerThreadEvent(event: {
  type: string;
  payload: { blocks?: unknown };
}): boolean {
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested"
  ) {
    return true;
  }
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return false;
  }
  const blocks = event.payload.blocks;
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        "kind" in block &&
        (block.kind === "bot_message_received" ||
          block.kind === "bot_message_sent" ||
          block.kind === "ask" ||
          block.kind === "text"),
    )
  );
}

/**
 * A background run's chatter stays off the transcript: no starts, progress, steps,
 * or final text. An open thread still receives the state it needs to answer without
 * a reload — waiting input, computer takeover, and terminal run events — plus the
 * bot's explicit `message_user` updates, ask cards, and computer blocks.
 */
export function shouldForwardBackgroundThreadEvent(event: {
  type: string;
  payload: { blocks?: unknown; userProgress?: unknown };
}): boolean {
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested"
  ) {
    return true;
  }
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return false;
  }
  if (event.payload.userProgress === true) return true;
  const blocks = event.payload.blocks;
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        "kind" in block &&
        (block.kind === "ask" || block.kind === "computer"),
    )
  );
}

function toThreadMessage(row: {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  replyQuote: string | null;
  replyTo?: {
    threadId: string;
    role: string;
    botId: string | null;
    blocks: Prisma.JsonValue;
  } | null;
  runId: string | null;
  clientNonce?: string | null;
  createdAt: Date;
}): ThreadMessage {
  const parent = row.replyTo?.threadId === row.threadId ? row.replyTo : null;
  const parsed = parent ? MessageBlockSchema.array().safeParse(parent.blocks) : undefined;
  const replyPreview =
    parent && parsed?.success
      ? messageReplyPreview(
          parsed.data,
          parent.role as ThreadMessage["role"],
          parent.botId ?? undefined,
        )
      : row.replyToMessageId || row.replyQuote != null
        ? null
        : undefined;
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as ThreadMessage["role"],
    blocks: row.blocks as ThreadMessage["blocks"],
    botId: row.botId ?? undefined,
    replyToMessageId: row.replyToMessageId ?? undefined,
    replyQuote: row.replyQuote ?? undefined,
    replyPreview,
    runId: row.runId ?? undefined,
    callId: callIdFromClientNonce(row.clientNonce),
    createdAt: row.createdAt.toISOString(),
  };
}
