import { randomUUID } from "node:crypto";
import type { ComputerMode } from "@rakazo/contracts";
import { ComputerModeSchema } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { computerChangedNote } from "./computer-change.prompt.js";

type ComputerChange = { from: ComputerMode; to: ComputerMode; files?: "copied" | "stayed" };

/** The note's nonce records the change itself, so it can be told again without its text. */
const NOTE_NONCE = "computer-change";

/**
 * Leaves one system note in the bot's thread saying it moved to another computer. A turn that
 * reads the chat finds it in the history; `unreadComputerChange` gives it to one that does not.
 */
export async function announceComputerChange(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  bot: { id: string; spaceId: string; threadId: string },
  change: ComputerChange,
): Promise<void> {
  const blocks = [
    { kind: "meta" as const, text: computerChangedNote(change.from, change.to, change.files) },
  ];
  const seq = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: bot.threadId,
      botId: bot.id,
      role: "system",
      blocks,
      clientNonce: [NOTE_NONCE, change.from, change.to, change.files ?? "", randomUUID()].join(":"),
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: bot.spaceId,
      threadId: bot.threadId,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "system", blocks },
    });
    return event.seq;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  await bestEffort("computer change note signal", deps.events.notify(bot.threadId, seq));
}

/**
 * The bot's latest computer change, as its note, while no turn of the bot has started since.
 * A turn that does not read the whole chat (a scheduled routine) is told through this, so the
 * first turn after a move always knows about it and later ones are not told again. The run
 * asking does not count as a turn since, so it gets the same answer each time it is assembled.
 */
export async function unreadComputerChange(
  prisma: Pick<PrismaClient, "message" | "run">,
  botId: string,
  runId: string,
): Promise<string | undefined> {
  const note = await prisma.message.findFirst({
    where: { thread: { botId }, clientNonce: { startsWith: `${NOTE_NONCE}:` } },
    orderBy: { seq: "desc" },
    select: { clientNonce: true, createdAt: true },
  });
  if (!note?.clientNonce) return undefined;
  const [, from, to, files] = note.clientNonce.split(":");
  const change = {
    from: ComputerModeSchema.safeParse(from),
    to: ComputerModeSchema.safeParse(to),
  };
  if (!change.from.success || !change.to.success) return undefined;
  const told = await prisma.run.findFirst({
    where: { botId, id: { not: runId }, startedAt: { gt: note.createdAt } },
    select: { id: true },
  });
  if (told) return undefined;
  return computerChangedNote(
    change.from.data,
    change.to.data,
    files === "copied" || files === "stayed" ? files : undefined,
  );
}
