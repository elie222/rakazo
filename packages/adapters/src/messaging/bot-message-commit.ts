import type { Prisma } from "@rakazo/db";
import {
  isUniqueViolation,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";

/** A delivery that found its work already done by an earlier or concurrent attempt. */
export type BotMessageReplay = { replayed: true };

/** A delivery the transaction refused; the caller reports the error verbatim. */
export type BotMessageRejection = {
  ok: false;
  error: string;
  /**
   * The route this delivery selected no longer matches the ticket's locked
   * assignment: nothing was committed, and the caller re-routes from a fresh
   * read instead of reporting the error to the model.
   */
  reassigned?: true;
};

/**
 * The transaction every bot-message delivery commits through, so the chat path
 * (`messageBot`) and the ticket path (`deliverTicketBotMessageOutcome`) share one source
 * of truth for idempotency and locking: the space-deletion check, the thread row locks,
 * the delivery-key replay probe, the sender-run status check, and the target's
 * still-addressable re-check. `body` performs only the writes that differ between the
 * two deliveries and may return `{ replayed: true }` for its own exactly-once claims.
 */
export async function commitBotMessageDelivery<
  Commit extends { ok: true; senderEventSeq?: number },
>(
  deps: Pick<ExecutorDeps, "prisma" | "runLease">,
  input: {
    run: { id: string; spaceId: string; threadId: string; botId: string; userId: string };
    /** `ended`/`waiting` sends come from a run that already stopped; undefined means running. */
    returnFrom?: "ended" | "waiting";
    /** Threads to lock for the delivery, in addition to the sender's own. */
    lockThreadIds: readonly string[];
    /** Where the delivery key is stamped; a probe hit means a prior attempt committed. */
    nonce?: { threadId: string; clientNonce: string };
    /** Re-check the chat target inside the transaction; ticket outcomes have none. */
    target?: { id: string; name: string };
  },
  body: (tx: Prisma.TransactionClient) => Promise<Commit | BotMessageReplay | BotMessageRejection>,
): Promise<Commit | BotMessageReplay | BotMessageRejection> {
  const replayed = (): BotMessageReplay => ({ replayed: true });
  try {
    return await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        if (!(await spaceTakesWork(tx, input.run.spaceId)))
          return { ok: false as const, error: "this Space is being deleted" };
        for (const threadId of [input.run.threadId, ...input.lockThreadIds].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        if (input.nonce) {
          // Probe the key on the route's own stamp thread and on the sender's:
          // the chat path stamps the delivered message on the target's thread
          // while the ticket path stamps its echo on the sender's, and a
          // reassignment between attempts can flip the route, so one probe
          // domain would let the same tool call deliver through both.
          for (const threadId of [...new Set([input.nonce.threadId, input.run.threadId])]) {
            const already = await tx.message.findUnique({
              where: {
                threadId_clientNonce: {
                  threadId,
                  clientNonce: input.nonce.clientNonce,
                },
              },
              select: { id: true },
            });
            if (already) return replayed();
          }
        }
        const senderStillRunning = await tx.run.findFirst({
          where: {
            id: input.run.id,
            spaceId: input.run.spaceId,
            threadId: input.run.threadId,
            botId: input.run.botId,
            userId: input.run.userId,
            status:
              input.returnFrom === "ended"
                ? { in: ["completed", "failed", "cancelled"] }
                : input.returnFrom === "waiting"
                  ? "waiting_input"
                  : "running",
          },
          select: { id: true },
        });
        if (!senderStillRunning)
          return { ok: false as const, error: "source run is no longer active" };
        if (input.target) {
          // Re-read the target inside the transaction: it can be archived between
          // resolving it above and committing here.
          const stillAddressable = await tx.bot.findFirst({
            where: { id: input.target.id, spaceId: input.run.spaceId, archivedAt: null },
            select: { id: true },
          });
          if (!stillAddressable)
            return { ok: false as const, error: `${input.target.name} is no longer available` };
        }
        return body(tx);
      }, THREAD_LOCK_TRANSACTION_OPTIONS),
    );
  } catch (error) {
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (input.nonce && isUniqueViolation(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: {
          threadId_clientNonce: {
            threadId: input.nonce.threadId,
            clientNonce: input.nonce.clientNonce,
          },
        },
        select: { id: true },
      });
      if (winner) return replayed();
    }
    throw error;
  }
}
