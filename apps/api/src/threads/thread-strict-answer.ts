import type { JobPublisher } from "@rakazo/adapter-kit";
import { wakeRun } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import {
  MessageBlock as MessageBlockSchema,
  QUESTION_ALREADY_ANSWERED_ERROR,
} from "@rakazo/contracts";
import {
  BACKGROUND_HELPER_TRIGGER,
  ClientError,
  isQuestionAskBlock,
  MODEL_REQUIRED_SEND_ERROR,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  eligibleWaitingTextAnswer,
  IsolationError,
  readJsonColumn,
  readMessageBlocks,
} from "@rakazo/db";
import * as z from "zod";

export const RUNS_NEEDING_CONTINUE = new Set(["queued", "waiting_takeover"]);

/** Strict card-answer send targeted a question that is already closed or belongs to someone else. */
export class QuestionAlreadyAnsweredError extends ClientError {
  constructor() {
    super("CONFLICT", "This question was already answered", QUESTION_ALREADY_ANSWERED_ERROR);
    this.name = "QuestionAlreadyAnsweredError";
  }
}

/**
 * Parses stored blocks entry by entry so an unrecognized sibling block from another release
 * cannot hide a valid pending question or reply preview on the same row. `intact` is false when
 * any entry was left out, so a reader that decides from a missing block takes the restrictive answer.
 */
export function parseMessageBlocks(message: { id: string; blocks: unknown }) {
  const read = readMessageBlocks(message);
  const blocks = read.blocks.flatMap((entry): MessageBlock[] => {
    const parsed = MessageBlockSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return { blocks, intact: read.intact && blocks.length === read.blocks.length };
}

export function validateStrictAnswerInput(input: {
  answersQuestion?: true;
  replyToMessageId?: string;
  text?: string;
  noModel?: boolean;
}) {
  if (!input.answersQuestion) return;
  if (!input.replyToMessageId) {
    throw new ClientError("BAD_REQUEST", "answersQuestion requires replyToMessageId.");
  }
  if (!input.text?.trim()) {
    throw new ClientError("BAD_REQUEST", "answersQuestion requires nonblank text.");
  }
  // Receipt replay already ran above; only a fresh answer needs a runnable model.
  if (input.noModel) {
    throw new ClientError("BAD_REQUEST", MODEL_REQUIRED_SEND_ERROR);
  }
}

export async function loadStrictQuestionRun(
  tx: Prisma.TransactionClient,
  input: {
    actor: Actor;
    threadId: string;
    replyToMessageId: string | undefined;
    text: string | undefined;
    allowedBotIds: readonly string[];
  },
) {
  if (!input.replyToMessageId || input.allowedBotIds.length === 0) {
    throw new QuestionAlreadyAnsweredError();
  }
  // Re-read under the thread lock so a concurrent answer or another member's card
  // is refused rather than falling back to a newer question.
  const card = await tx.message.findFirst({
    where: { id: input.replyToMessageId, threadId: input.threadId, role: "bot" },
    select: { id: true, botId: true, runId: true, blocks: true },
  });
  const pendingQuestion =
    card &&
    parseMessageBlocks(card).blocks.some(
      (block) => block.kind === "ask" && isQuestionAskBlock(block) && block.status !== "answered",
    );
  if (!card?.runId || !pendingQuestion) throw new QuestionAlreadyAnsweredError();
  // Match threads.answer: a background helper posts its card in the originating chat
  // while its run row belongs to the helper's own thread.
  const run = await tx.run.findFirst({
    where: {
      id: card.runId,
      spaceId: input.actor.spaceId,
      botId: { in: [...input.allowedBotIds] },
      OR: [
        { threadId: input.threadId },
        {
          trigger: BACKGROUND_HELPER_TRIGGER,
          sourceMessage: {
            threadId: input.threadId,
            thread: { spaceId: input.actor.spaceId },
          },
        },
      ],
      status: "waiting_input",
    },
    select: {
      id: true,
      taskId: true,
      botId: true,
      status: true,
      trigger: true,
      userId: true,
    },
  });
  if (!run || run.userId !== input.actor.userId) throw new QuestionAlreadyAnsweredError();
  // Verify exact-card eligibility before creating the user message row.
  const eligible = await eligibleWaitingTextAnswer(tx, {
    spaceId: input.actor.spaceId,
    threadId: input.threadId,
    runId: run.id,
    answeredByUserId: input.actor.userId,
    answer: input.text ?? "",
    messageId: input.replyToMessageId,
  });
  if (!eligible) throw new QuestionAlreadyAnsweredError();
  return run;
}

export async function enqueueRunsNeedingContinue(
  jobs: JobPublisher,
  runs: Array<{ id: string; status: string }>,
) {
  await Promise.all(
    runs.filter((run) => RUNS_NEEDING_CONTINUE.has(run.status)).map((run) => wakeRun(jobs, run.id)),
  );
}

async function findSendReceipt(prisma: PrismaClient, threadId: string, clientNonce: string) {
  return prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce } },
    include: { sourceRuns: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
}

export async function replayExistingSend(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  threadId: string,
  authorUserId: string,
  clientNonce: string | undefined,
  releaseTakeover?: (runId: string) => Promise<void>,
  strictAnswer?: { replyToMessageId?: string; text?: string },
) {
  if (!clientNonce) return null;
  const message = await findSendReceipt(deps.prisma, threadId, clientNonce);
  if (!message) return null;
  // Legacy messages saved before shared spaces have authorUserId null and keep replaying.
  if (
    (message.authorUserId && message.authorUserId !== authorUserId) ||
    (strictAnswer && !(await answeredSameCard(deps.prisma, threadId, message, strictAnswer)))
  ) {
    throw new ClientError("CONFLICT", "This message nonce is already in use.");
  }
  const receiptEvent = await deps.prisma.event.findFirst({
    where: {
      threadId,
      type: "thread.message.created",
      payload: { path: ["messageId"], equals: message.id },
    },
    orderBy: { seq: "desc" },
    select: { id: true, payload: true },
  });
  const receiptRunIds = receiptEvent ? sendEventRunIds(receiptEvent) : [];
  const receiptRuns = receiptRunIds.length
    ? await deps.prisma.run.findMany({ where: { id: { in: receiptRunIds } } })
    : [];
  const receiptRunById = new Map(receiptRuns.map((run) => [run.id, run]));
  const orderedReceiptRuns = receiptRunIds.flatMap((id) => {
    const run = receiptRunById.get(id);
    return run ? [run] : [];
  });
  const linkedRun =
    message.sourceRuns[0] ??
    (message.runId ? await deps.prisma.run.findUnique({ where: { id: message.runId } }) : null);
  if (!linkedRun && orderedReceiptRuns.length === 0) return null;
  const runs = orderedReceiptRuns.length
    ? orderedReceiptRuns
    : message.sourceRuns.length
      ? message.sourceRuns
      : [linkedRun!];
  const pendingSteering = releaseTakeover
    ? await deps.prisma.steeringMessage.findFirst({
        where: { messageId: message.id, claimedAt: null },
        select: { runId: true },
      })
    : null;
  if (releaseTakeover && pendingSteering?.runId) await releaseTakeover(pendingSteering.runId);
  await enqueueRunsNeedingContinue(deps.jobs, runs);
  const latestEvent = await deps.prisma.event.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (latestEvent) {
    await deps.events.notify(threadId, latestEvent.seq);
  }
  return sendResult(message, runs);
}

/**
 * A card answer's receipt is the message that answered that card: one intact text block with the
 * same answer, replying to the card, whose ask records it as the answer. An ordinary send with the
 * same text, or a row that lost entries, never replays as a card answer.
 */
async function answeredSameCard(
  prisma: PrismaClient,
  threadId: string,
  message: { id: string; blocks: unknown; replyToMessageId: string | null },
  strictAnswer: { replyToMessageId?: string; text?: string },
) {
  const { blocks, intact } = parseMessageBlocks(message);
  const [block] = blocks;
  if (
    !intact ||
    blocks.length !== 1 ||
    block?.kind !== "text" ||
    block.text.trim() !== strictAnswer.text?.trim() ||
    !strictAnswer.replyToMessageId ||
    message.replyToMessageId !== strictAnswer.replyToMessageId
  ) {
    return false;
  }
  const card = await prisma.message.findFirst({
    where: { id: strictAnswer.replyToMessageId, threadId, role: "bot" },
    select: { id: true, blocks: true },
  });
  return Boolean(
    card &&
      parseMessageBlocks(card).blocks.some(
        (entry) => entry.kind === "ask" && entry.answerMessageId === message.id,
      ),
  );
}

const sendEventPayload = z.object({ runIds: z.array(z.string()).optional() });

/** Sends saved before receipts listed their runs fall back to the message's linked runs. */
function sendEventRunIds(event: { id: string; payload: Prisma.JsonValue }): string[] {
  return (
    readJsonColumn(
      sendEventPayload,
      event.payload,
      { table: "events", column: "payload", id: event.id },
      { fallback: {} },
    ).runIds ?? []
  );
}

export function sendResult(message: { seq: number }, runs: Array<{ id: string; taskId: string }>) {
  const first = runs[0];
  if (!first) throw new IsolationError("Send did not create a run");
  return {
    taskId: first.taskId,
    runId: first.id,
    seq: message.seq,
    runIds: runs.map((run) => run.id),
  };
}
