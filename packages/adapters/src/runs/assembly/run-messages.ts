import type { HistoryToolStep, MessageBlock } from "@rakazo/contracts";
import {
  callIdFromClientNonce,
  isBackgroundRunTrigger,
  redactSecrets,
  splitToolHistory,
} from "@rakazo/core";
import type { Prisma, RunLease } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { redactConnectorPayload } from "../../integrations/connector-safety.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";

/** Deps for one attempt: its run's history writes carry the lease, so a superseded attempt cannot write. */
export function withRunLease(
  deps: ExecutorDeps,
  runId: string,
  lease: RunLease,
  requestThreadId?: string,
): ExecutorDeps {
  return {
    ...deps,
    runLease: { runId, ...lease },
    events: {
      ...deps.events,
      append: (input) => deps.events.append(input.runId === runId ? { lease, ...input } : input),
      pauseRunForInput: (input) =>
        deps.events.pauseRunForInput(
          input.runId === runId && requestThreadId ? { ...input, requestThreadId } : input,
        ),
    },
  };
}

export function runLeaseFor(
  deps: Pick<ExecutorDeps, "runLease">,
  runId: string,
): RunLease | undefined {
  return deps.runLease?.runId === runId ? deps.runLease : undefined;
}

/** Stored call arguments with the run's secrets redacted inside their values, still valid JSON. */
function redactedArguments(json: string, secrets: string[]): string {
  try {
    return JSON.stringify(redactConnectorPayload(JSON.parse(json), secrets));
  } catch {
    return "{}";
  }
}

const MAX_CARD_URL_LENGTH = 2_048;

/** True when a URL carries any run secret in raw or percent-decoded form. */
export function urlContainsRunSecret(url: string, secrets: string[]): boolean {
  if (secrets.length === 0) return false;
  if (redactSecrets(url, secrets) !== url) return true;
  try {
    const decoded = decodeURIComponent(url);
    if (decoded !== url && redactSecrets(decoded, secrets) !== decoded) return true;
  } catch {
    // Malformed percent-encoding: raw check above already ran.
  }
  return false;
}

/** Keeps a card URL only if it fits the contract length limit and leaks no run secrets. */
export function sanitizeCardUrl(url: string | undefined, secrets: string[]): string | undefined {
  if (!url || url.length > MAX_CARD_URL_LENGTH) return undefined;
  return urlContainsRunSecret(url, secrets) ? undefined : url;
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
    if (block.kind === "card") {
      return {
        ...block,
        lines: block.lines.map((line) => ({
          k: redactSecrets(line.k, secrets),
          v: redactSecrets(line.v, secrets),
        })),
      };
    }
    if (block.kind === "result_cards") {
      return {
        ...block,
        ...(block.title ? { title: redactSecrets(block.title, secrets) } : {}),
        items: block.items.map((item) => {
          const safeUrl = sanitizeCardUrl(item.url, secrets);
          const safeImageUrl = sanitizeCardUrl(item.imageUrl, secrets);
          const { url: _u, imageUrl: _i, ...rest } = item;
          return {
            ...rest,
            title: redactSecrets(item.title, secrets),
            ...(item.subtitle ? { subtitle: redactSecrets(item.subtitle, secrets) } : {}),
            ...(item.price ? { price: redactSecrets(item.price, secrets) } : {}),
            ...(item.rating ? { rating: redactSecrets(item.rating, secrets) } : {}),
            ...(item.meta ? { meta: redactSecrets(item.meta, secrets) } : {}),
            ...(safeUrl ? { url: safeUrl } : {}),
            ...(safeImageUrl ? { imageUrl: safeImageUrl } : {}),
            ...(item.badges
              ? { badges: item.badges.map((badge) => redactSecrets(badge, secrets)) }
              : {}),
          };
        }),
      };
    }
    if (block.kind === "page") return { ...block, title: redactSecrets(block.title, secrets) };
    if (block.kind === "steps") {
      return {
        ...block,
        steps: (block.steps as HistoryToolStep[]).map((step) => ({
          ...step,
          label: redactSecrets(step.label, secrets),
          ...(step.note === undefined ? {} : { note: redactSecrets(step.note, secrets) }),
          // Secrets a later call revealed are redacted from earlier calls' arguments too.
          ...(step.calls
            ? {
                calls: step.calls.map((call) => ({
                  ...call,
                  ...(call.arguments === undefined
                    ? {}
                    : { arguments: redactedArguments(call.arguments, secrets) }),
                  ...(call.result === undefined
                    ? {}
                    : { result: redactSecrets(call.result, secrets) }),
                })),
              }
            : {}),
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
  replyToMessageId?: string,
) {
  if (isBackgroundRunTrigger(run.trigger)) {
    blocks = blocks.filter((block) => block.kind === "ask" || block.kind === "computer");
    if (blocks.length === 0 && !stoppedHelper) return null;
  }
  const lease = runLeaseFor(deps, run.id);
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
        replyToMessageId,
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
  replyToMessageId?: string,
) {
  // Clients get the blocks without the kept calls, in the message and in its event alike.
  const { blocks: shown, toolHistory } = splitToolHistory(blocks);
  blocks = shown;
  const message = await createThreadMessageInTransaction(tx, {
    threadId: run.threadId,
    role,
    blocks,
    toolHistory,
    botId: run.botId,
    runId: run.id,
    markUnread,
    clientNonce,
    replyToMessageId,
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
      ...(replyToMessageId ? { replyToMessageId } : {}),
      callId: callIdFromClientNonce(clientNonce),
    },
  });
  return {
    message,
    eventSeq: event.seq,
    firstResponseRunId: event.firstResponse ? run.id : undefined,
  };
}
