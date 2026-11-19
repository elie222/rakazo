import type { RoutineEventChange } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

export type RoutineNoticeDeps = { prisma: PrismaClient; events: ThreadEvents };

export type RoutineNoticeInput = {
  spaceId: string;
  /** The routine's chat; without one the bot's own chat is used. */
  threadId: string | null | undefined;
  botId: string;
  change: RoutineEventChange;
  name: string;
};

/** What an edit means for the chat: an on/off flip reads as enabled or disabled. */
export function routineEditChange(
  before: { active: boolean },
  after: { active: boolean },
): RoutineEventChange {
  if (before.active === after.active) return "updated";
  return after.active ? "enabled" : "disabled";
}

/** The bot's own chat, for a routine saved without one. */
async function botThreadId(prisma: PrismaClient, botId: string): Promise<string | undefined> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { thread: { select: { id: true } } },
  });
  return bot?.thread?.id;
}

/**
 * The small row a routine change leaves in its chat: a system message with one `routine_event`
 * block holding the routine's name and what happened, never the prompt or schedule. A system
 * message is not unread, and the block has no text, so the model never sees it. A deletion also
 * appends `routine.deleted` to the timeline, like the other routine events. Never throws:
 * the change is already saved, so a failure is only logged.
 */
export async function postRoutineNotice(
  deps: RoutineNoticeDeps,
  input: RoutineNoticeInput,
): Promise<void> {
  await bestEffort("routine notice", writeRoutineNotice(deps, input));
}

async function writeRoutineNotice(deps: RoutineNoticeDeps, input: RoutineNoticeInput) {
  const threadId = input.threadId ?? (await botThreadId(deps.prisma, input.botId));
  if (!threadId) return;
  const name = input.name.slice(0, 200);
  const blocks = [{ kind: "routine_event" as const, change: input.change, name }];
  const seq = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId,
      botId: input.botId,
      role: "system",
      blocks,
    });
    // Created and updated already have their timeline events; a deletion gets its own here.
    if (input.change === "deleted") {
      await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId,
        botId: input.botId,
        type: "routine.deleted",
        payload: { name },
      });
    }
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId,
      botId: input.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "system", blocks },
    });
    return event.seq;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  await bestEffort("routine notice notify", deps.events.notify(threadId, seq));
}
