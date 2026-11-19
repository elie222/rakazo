import type { RoutineEventChange } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { stableStringify } from "./routine-watch.js";

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

/** The settings a person edits, and when it next runs; a save that changes none leaves no row. */
const EDITABLE_FIELDS = [
  "name",
  "prompt",
  "crons",
  "timezone",
  "active",
  "notify",
  "inChat",
  "webhookEnabled",
  "githubEnabled",
  "messageProvider",
  "emailSenders",
  "modelProvider",
  "modelId",
  "thinkingLevel",
  "watch",
  "nextRunAt",
] as const;

const comparable = (value: unknown) =>
  value instanceof Date ? String(value.getTime()) : stableStringify(value);

/** Whether a save changed anything a person edits. */
export function routineEdited(
  before: Partial<Record<(typeof EDITABLE_FIELDS)[number], unknown>>,
  after: Partial<Record<(typeof EDITABLE_FIELDS)[number], unknown>>,
): boolean {
  return EDITABLE_FIELDS.some((key) => comparable(before[key]) !== comparable(after[key]));
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
 * message is not unread, and the block has no text, so the model never sees it. Never throws: the change is already saved, so a failure is only logged.
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
