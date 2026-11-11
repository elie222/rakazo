import type { MessageBlock } from "@rakazo/contracts";
import {
  callIdFromClientNonce,
  isBackgroundRunTrigger,
  redactSecrets,
  SILENT_ROUTINE_TRIGGER,
} from "@rakazo/core";
import type { Prisma, RunLease } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  runReplyEvent,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";

/** Deps for one attempt: its run's history writes carry the lease, so a superseded attempt cannot write. */
export function withRunLease(deps: ExecutorDeps, runId: string, lease: RunLease): ExecutorDeps {
  return {
    ...deps,
    runLease: { runId, ...lease },
    events: {
      ...deps.events,
      append: (input) => deps.events.append(input.runId === runId ? { lease, ...input } : input),
    },
  };
}

export function runLeaseFor(
  deps: Pick<ExecutorDeps, "runLease">,
  runId: string,
): RunLease | undefined {
  return deps.runLease?.runId === runId ? deps.runLease : undefined;
}

/** Keeps blocks a silent routine would have posted for its run history, in the given transaction. */
export function holdRunReplyInTransaction(
  tx: Prisma.TransactionClient,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  blocks: MessageBlock[],
  lease?: RunLease,
) {
  return appendEventInTransaction(tx, runReplyEvent(run, blocks, lease));
}

export function redactBlocks(blocks: MessageBlock[], secrets: string[]): MessageBlock[] {
  return blocks.map((block) => {
    if (block.kind === "text") {
      return {
        kind: "text" as const,
        text: redactSecrets(block.text, secrets),
      };
    }
    if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
      return { ...block, text: redactSecrets(block.text, secrets) };
    }
    if (block.kind === "page") return { ...block, title: redactSecrets(block.title, secrets) };
    if (block.kind === "steps") {
      return {
        ...block,
        steps: block.steps.map((step) => ({
          ...step,
          label: redactSecrets(step.label, secrets),
          ...(step.note === undefined ? {} : { note: redactSecrets(step.note, secrets) }),
        })),
      };
    }
    return block;
  });
}

export async function publishMessage(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; threadId: string; botId: string; trigger: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread: boolean | undefined = run.trigger === "bot_message" ? false : undefined,
  clientNonce?: string,
  stoppedHelper?: Extract<MessageBlock, { kind: "subagent" }> & {
    status: "failed";
    result: "stopped";
  },
) {
  const lease = runLeaseFor(deps, run.id);
  if (isBackgroundRunTrigger(run.trigger)) {
    const reachesChat = (block: MessageBlock) => block.kind === "ask" || block.kind === "computer";
    // What a silent routine would have posted, its files, charts and pages included, goes to its
    // run history instead; ticket work reports on the board.
    const held = blocks.filter((block) => !reachesChat(block));
    if (run.trigger === SILENT_ROUTINE_TRIGGER && role === "bot" && held.length) {
      // Under the attempt's lease like the chat's own writes, so a superseded attempt can't
      // add to the history twice.
      await deps.events.append(runReplyEvent(run, held, lease));
    }
    blocks = blocks.filter(reachesChat);
    if (blocks.length === 0 && !stoppedHelper) return null;
  }
  // Concurrent runs in one thread contend for its sequence counters; Postgres aborts a
  // deadlock victim, which commits nothing, so retry instead of failing the run.
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      // Only synthetic terminal helper writes may bypass the cancellation guard.
      // Commit their event and durable message together so cleanup retries are safe.
      let helperEvent: { seq: number } | undefined;
      if (stoppedHelper) {
        const { kind: _kind, ...payload } = stoppedHelper;
        helperEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          runId: run.id,
          type: "thread.subagent",
          payload,
          allowCancelledRun: true,
          lease,
        });
      }
      if (blocks.length === 0 && helperEvent)
        return { message: null, eventSeq: helperEvent.seq, firstResponseRunId: undefined };
      return persistMessageInTransaction(
        tx,
        run,
        role,
        blocks,
        markUnread,
        clientNonce,
        Boolean(stoppedHelper),
        lease,
      );
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  await deps.events
    .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
    .catch((error) => {
      getLogger().error("thread message realtime notification", error);
    });
  return committed.message;
}

export async function persistMessageInTransaction(
  tx: Prisma.TransactionClient,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread?: boolean,
  clientNonce?: string,
  allowCancelledRun = false,
  lease?: RunLease,
) {
  const message = await createThreadMessageInTransaction(tx, {
    threadId: run.threadId,
    role,
    blocks,
    botId: run.botId,
    runId: run.id,
    markUnread,
    clientNonce,
    allowCancelledRun,
    lease,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.message.created",
    runId: run.id,
    allowCancelledRun,
    lease,
    payload: {
      messageId: message.id,
      role,
      blocks,
      callId: callIdFromClientNonce(clientNonce),
    },
  });
  return {
    message,
    eventSeq: event.seq,
    firstResponseRunId: event.firstResponse ? run.id : undefined,
  };
}
