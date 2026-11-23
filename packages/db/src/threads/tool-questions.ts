import type { MessageBlock } from "@rakazo/contracts";
import { checkToolQuestionValues, MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { sealTo } from "@rakazo/core/node/sealed-box";
import { bestEffort } from "@rakazo/logging";
import type { Prisma, PrismaClient } from "../database/client.js";
import { warnJsonColumnOnce } from "../database/json-column.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "../database/transaction-retry.js";
import { contentEncryptionOf } from "../encryption/content-encryption.js";
import { appendEventInTransaction } from "./events.js";
import { changeMessageBlocks, storedMessageBlocks } from "./message-blocks.js";

type ToolQuestionBlock = Extract<MessageBlock, { kind: "tool_question" }>;

/** The person's answer could not be taken: the card is gone, closed, or the values are wrong. */
export class ToolQuestionAnswerError extends ClientError {
  constructor(message: string, kind: "CONFLICT" | "BAD_REQUEST" = "CONFLICT") {
    super(kind, message);
    this.name = "ToolQuestionAnswerError";
  }
}

function questionBlock(blocks: readonly MessageBlock[]): ToolQuestionBlock | undefined {
  const block = blocks.find((entry) => entry.kind === "tool_question");
  const parsed = MessageBlockSchema.safeParse(block);
  return parsed.success && parsed.data.kind === "tool_question" ? parsed.data : undefined;
}

/** What the waiting call reads: the person's values still sealed to its own key. */
export type TakenToolQuestionAnswer =
  | { action: "accept"; sealedValues: string }
  | { action: "decline" }
  | { action: "cancel" };

function withoutBox(block: MessageBlock): MessageBlock {
  if (block.kind !== "tool_question" || block.sealedValues === undefined) return block;
  const { sealedValues: _sealed, ...rest } = block;
  return rest;
}

type QuestionRef = { spaceId: string; threadId: string; messageId: string };

async function lockedQuestion(tx: Prisma.TransactionClient, ref: QuestionRef) {
  // Thread row first, as every answer and run write takes it.
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${ref.threadId} FOR UPDATE`;
  const message = await tx.message.findFirst({
    where: { id: ref.messageId, threadId: ref.threadId, role: "bot", runId: { not: null } },
    select: { id: true, blocks: true, botId: true, runId: true },
  });
  const block = message && questionBlock(storedMessageBlocks(message));
  return message && block ? { message, block } : undefined;
}

async function writeQuestion(
  tx: Prisma.TransactionClient,
  ref: QuestionRef,
  message: { id: string; blocks: unknown; botId: string | null; runId: string | null },
  next: ToolQuestionBlock,
): Promise<number | undefined> {
  const changed = changeMessageBlocks(message, (block) =>
    block.kind === "tool_question" ? next : block,
  );
  if (!changed || !message.botId) return undefined;
  await tx.message.update({ where: { id: message.id }, data: { blocks: changed.stored } });
  const event = await appendEventInTransaction(tx, {
    spaceId: ref.spaceId,
    threadId: ref.threadId,
    botId: message.botId,
    runId: message.runId ?? undefined,
    // The card closes whatever became of its run.
    allowCancelledRun: true,
    type: "thread.message.updated",
    // The event log keeps no copy of the sealed answer, so taking it off the row removes it.
    payload: { messageId: message.id, role: "bot", blocks: changed.blocks.map(withoutBox) },
  });
  return event.seq;
}

/**
 * The person's answer to a tool's question. Only the run's own user answers, only while the card
 * is pending, unexpired and its run is still running. The values are sealed to the waiting call's
 * own key before they are written, so the row, its events and every reader of the chat hold only
 * a box that call alone opens; it hears the answer through the thread's event stream. Returns
 * the event to notify.
 */
export async function answerToolQuestion(
  prisma: PrismaClient,
  input: QuestionRef & {
    userId: string;
    action: "accept" | "decline";
    values?: Record<string, unknown>;
    now?: Date;
  },
): Promise<{ threadId: string; seq: number } | undefined> {
  await contentEncryptionOf(prisma)?.ring.all(input.spaceId);
  const seq = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const found = await lockedQuestion(tx, input);
    if (!found) throw new ToolQuestionAnswerError("This question is no longer open");
    const { message, block } = found;
    const run = await tx.run.findFirst({
      where: { id: message.runId ?? "", spaceId: input.spaceId },
      select: { userId: true, status: true },
    });
    // The answer goes to the run's own tool call, so only that run's user gives it.
    if (!run || run.userId !== input.userId)
      throw new ToolQuestionAnswerError("This question is no longer open");
    const now = input.now ?? new Date();
    if (
      block.status !== "pending" ||
      run.status !== "running" ||
      Date.parse(block.expiresAt) <= now.getTime()
    )
      throw new ToolQuestionAnswerError("This question is no longer open");
    let next: ToolQuestionBlock;
    if (input.action === "accept") {
      const checked = checkToolQuestionValues(block.question.fields, input.values ?? {});
      if (!checked.ok) throw new ToolQuestionAnswerError(checked.reason, "BAD_REQUEST");
      next = {
        ...block,
        status: "accepted",
        sealedValues: sealTo(block.publicKey, JSON.stringify(checked.values)),
      };
    } else {
      next = { ...block, status: "declined" };
    }
    return writeQuestion(tx, input, message, next);
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  return seq === undefined ? undefined : { threadId: input.threadId, seq };
}

/**
 * For the call waiting on a question: the answer once there is one, taking the person's values
 * off the row as it reads them. Undefined while the card is pending, unless `expire` is set,
 * when a pending card closes as expired and reads as `cancel`. `seq` is the event to notify
 * when the card changed.
 */
export async function takeToolQuestionAnswer(
  prisma: PrismaClient,
  ref: QuestionRef,
  options: { expire: boolean },
): Promise<{ answer: TakenToolQuestionAnswer | undefined; seq?: number }> {
  await contentEncryptionOf(prisma)?.ring.all(ref.spaceId);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const found = await lockedQuestion(tx, ref);
    if (!found) return { answer: { action: "cancel" } as const };
    const { message, block } = found;
    if (block.status === "declined") return { answer: { action: "decline" } as const };
    if (block.status === "expired") return { answer: { action: "cancel" } as const };
    if (block.status === "accepted") {
      if (!block.sealedValues) return { answer: { action: "cancel" } as const };
      const { sealedValues, ...rest } = block;
      const seq = await writeQuestion(tx, ref, message, rest);
      return { answer: { action: "accept", sealedValues } as const, seq };
    }
    if (!options.expire) return { answer: undefined };
    const seq = await writeQuestion(tx, ref, message, { ...block, status: "expired" });
    return { answer: { action: "cancel" } as const, seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

/**
 * Closes a run's open questions as expired: their calls ended with the process that held them,
 * so nothing would hear an answer. Run when an attempt of the run starts; `notify` hears each
 * card it closed.
 */
export async function expireRunToolQuestions(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
  notify: (threadId: string, seq: number) => Promise<void>,
): Promise<void> {
  const candidates = await prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    select: { id: true, threadId: true, blocks: true },
  });
  for (const message of candidates) {
    const stored = storedMessageBlocks(message);
    const block = questionBlock(stored);
    if (!block && stored.some((entry) => entry.kind === "tool_question"))
      warnJsonColumnOnce("Stored tool question does not match its schema; left as it is", {
        table: "messages",
        column: "blocks",
        id: message.id,
      });
    // An open card, or an answer its call never took: either way no call will read it now.
    if (block?.status !== "pending" && !block?.sealedValues) continue;
    const { seq } = await takeToolQuestionAnswer(
      prisma,
      { spaceId: run.spaceId, threadId: message.threadId, messageId: message.id },
      { expire: true },
    );
    // A missed signal only delays the card; the next cards still close.
    if (seq !== undefined) await bestEffort("tool question expiry", notify(message.threadId, seq));
  }
}
