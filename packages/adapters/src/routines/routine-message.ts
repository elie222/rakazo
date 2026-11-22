import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  isUniqueViolation,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** A line in the routine's thread without a model run. */
export async function postRoutineMessage(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> },
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    role: "bot" | "system";
    text: string;
    /** Makes the line idempotent: a second post with it adds nothing to the thread. */
    clientNonce?: string;
    /** Marks the chat unread, which a status line otherwise does not. */
    markUnread?: boolean;
    /**
     * For a caller that retries: a line that can't be written throws instead of being skipped.
     * One an earlier attempt wrote under the same clientNonce counts as written.
     */
    required?: boolean;
  },
): Promise<void> {
  const blocks =
    input.role === "bot"
      ? [{ kind: "text" as const, text: input.text }]
      : [{ kind: "meta" as const, text: input.text }];
  try {
    // A write that conflicts with another in the chat tries again, as a sent message does.
    const seq = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        const message = await createThreadMessageInTransaction(tx, {
          threadId: input.threadId,
          botId: input.botId,
          role: input.role,
          blocks,
          clientNonce: input.clientNonce,
          ...(input.markUnread === undefined ? {} : { markUnread: input.markUnread }),
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          type: "thread.message.created",
          payload: { messageId: message.id, role: input.role, blocks },
        });
        return event.seq;
      }),
    );
    if (seq !== undefined) await deps.events.notify(input.threadId, seq);
  } catch (error) {
    // Already in the chat from an earlier attempt.
    if (input.clientNonce && isUniqueViolation(error)) return;
    if (input.required) throw error;
    // Best effort: the routine's state is already saved.
    getLogger().error("routine status line", error);
  }
}
