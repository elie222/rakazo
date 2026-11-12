import { z } from "zod";
import type {
  BackgroundJob,
  BackgroundJobExecution,
  BackgroundJobHandlers,
  BackgroundJobName,
  BackgroundJobPayloads,
} from "./types.js";

const payloadSchemas = {
  "run.continue": z.object({ runId: z.string().min(1) }),
  "routine.wakeup": z.object({
    routineId: z.string().min(1),
    scheduledFor: z.string().datetime({ offset: true }),
  }),
  "routine.retry": z.object({ runId: z.string().min(1) }),
  "computer.update": z.object({ updateId: z.string().min(1) }),
  "computer.sleep": z.object({ computerId: z.string().min(1) }),
  "computer.control-expire": z.object({
    computerId: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  "skill.teaching-expire": z.object({ skillId: z.string().min(1) }),
  "call.expire": z.object({ threadId: z.string().min(1), callId: z.string().min(1) }),
  // The member whose turn asked for it, who pays; older jobs name only the thread.
  "history.compact": z.object({
    threadId: z.string().min(1),
    userId: z.string().min(1).optional(),
  }),
  "memory.purge-history": z.object({
    spaceId: z.string().min(1),
    userId: z.string().min(1),
    botId: z.string().min(1),
    threadId: z.string().min(1),
    generations: z.array(z.number().int().min(0)).min(1),
    connectionIdentity: z.string().min(1),
  }),
  "memory.retain-turn": z.object({
    runId: z.string().min(1),
    messageIds: z.array(z.string().min(1)).optional(),
    pending: z
      .object({
        token: z.string().min(1).optional(),
        unconfirmed: z.literal(true).optional(),
        generation: z.number().int().min(0),
        checks: z.number().int().min(0),
        connectionIdentity: z.string().min(1),
        source: z.object({
          spaceId: z.string().min(1),
          userId: z.string().min(1),
          botId: z.string().min(1),
          threadId: z.string().min(1),
        }),
      })
      .optional(),
  }),
  "messaging.deliver": z.object({ runId: z.string().min(1).optional() }),
  "messaging.progress": z.object({ runId: z.string().min(1) }),
  "messaging.credential-cleanup": z.object({
    installationId: z.string().min(1),
    ref: z.string().min(1),
  }),
  "cloud_agent.poll": z.object({ agentId: z.string().min(1) }),
  "purchase.poll": z.object({ purchaseId: z.string().min(1) }),
  "media.poll": z.object({ jobId: z.string().min(1) }),
  "push.receipt": z.object({
    userId: z.string().min(1),
    ticketId: z.string().min(1),
    tokenDigest: z.string().min(1),
  }),
} satisfies { [Name in BackgroundJobName]: z.ZodType<BackgroundJobPayloads[Name]> };

export function parseBackgroundJob(name: string, payload: unknown): BackgroundJob {
  if (!(name in payloadSchemas)) throw new Error(`Unknown background job: ${name}`);
  const typedName = name as BackgroundJobName;
  const parsed = payloadSchemas[typedName].parse(payload);
  return { name: typedName, payload: parsed } as BackgroundJob;
}

export async function dispatchBackgroundJob(
  handlers: BackgroundJobHandlers,
  name: string,
  payload: unknown,
  execution?: BackgroundJobExecution,
): Promise<void> {
  const job = parseBackgroundJob(name, payload);
  const handler = handlers[job.name] as (
    payload: typeof job.payload,
    execution?: BackgroundJobExecution,
  ) => Promise<void>;
  if (execution) await handler(job.payload, execution);
  else await handler(job.payload);
}

export function runJobKey(runId: string): string {
  return `run:${runId}`;
}

export function routineJobKey(routineId: string): string {
  return `routine:${routineId}`;
}

export function computerSleepJobKey(computerId: string): string {
  return `computer.sleep:${computerId}`;
}

export function computerControlExpireJobKey(computerId: string, leaseId?: string): string {
  return leaseId
    ? `computer.control-expire:${computerId}:${leaseId}`
    : `computer.control-expire:${computerId}`;
}

export function skillTeachingExpireJobKey(skillId: string): string {
  return `skill.teaching-expire:${skillId}`;
}

export function runContinueJob(runId: string): BackgroundJob {
  return {
    name: "run.continue",
    payload: { runId },
    replaceKey: runJobKey(runId),
  };
}

export function routineWakeupJob(routineId: string, scheduledFor: Date): BackgroundJob {
  return {
    name: "routine.wakeup",
    payload: { routineId, scheduledFor: scheduledFor.toISOString() },
    availableAt: scheduledFor,
    replaceKey: routineJobKey(routineId),
  };
}

/** Keyed to the failed run, so a repeated enqueue keeps a single retry. */
export function routineRetryJob(runId: string, availableAt: Date): BackgroundJob {
  return {
    name: "routine.retry",
    payload: { runId },
    availableAt,
    replaceKey: `routine.retry:${runId}`,
  };
}

export function computerSleepJob(computerId: string, availableAt: Date): BackgroundJob {
  return {
    name: "computer.sleep",
    payload: { computerId },
    availableAt,
    replaceKey: computerSleepJobKey(computerId),
  };
}

export function computerControlExpireJob(
  computerId: string,
  leaseId: string,
  availableAt: Date,
): BackgroundJob {
  return {
    name: "computer.control-expire",
    payload: { computerId, leaseId },
    availableAt,
    replaceKey: computerControlExpireJobKey(computerId, leaseId),
  };
}

export function skillTeachingExpireJob(skillId: string, availableAt: Date): BackgroundJob {
  return {
    name: "skill.teaching-expire",
    payload: { skillId },
    availableAt,
    replaceKey: skillTeachingExpireJobKey(skillId),
  };
}

export function callExpireJob(threadId: string, callId: string, availableAt: Date): BackgroundJob {
  return {
    name: "call.expire",
    payload: { threadId, callId },
    availableAt,
    replaceKey: `call.expire:${callId}`,
  };
}

export function historyCompactJobKey(threadId: string): string {
  return `history.compact:${threadId}`;
}

/**
 * Each attempt runs a summarizer completion that can take up to the summarizer
 * timeout, so the job queue's default attempt count turns one permanently
 * failing thread into hours of paid retries. A few tries ride out transient
 * provider errors without storming.
 */
export const HISTORY_COMPACT_MAX_ATTEMPTS = 4;

/**
 * Delivers the interim messages of a run a chat app started, while the run is still going. Few
 * attempts: each one drains the whole outbox, and the end-of-run mirror sends them anyway.
 */
export function messagingProgressJob(runId: string): BackgroundJob {
  return {
    name: "messaging.progress",
    payload: { runId },
    replaceKey: `messaging.progress:${runId}`,
    maxAttempts: 3,
  };
}

export function messagingDeliverJob(runId?: string, availableAt?: Date): BackgroundJob {
  return {
    name: "messaging.deliver",
    payload: runId ? { runId } : {},
    replaceKey: `messaging.deliver:${runId ?? "drain"}`,
    ...(availableAt ? { availableAt } : {}),
  };
}

export function historyCompactJob(threadId: string, userId?: string): BackgroundJob {
  return {
    name: "history.compact",
    payload: userId ? { threadId, userId } : { threadId },
    replaceKey: historyCompactJobKey(threadId),
    maxAttempts: HISTORY_COMPACT_MAX_ATTEMPTS,
  };
}

export function memoryPurgeHistoryJob(
  payload: BackgroundJobPayloads["memory.purge-history"],
): BackgroundJob {
  return {
    name: "memory.purge-history",
    payload,
    replaceKey: `memory.purge-history:${JSON.stringify([payload.spaceId, payload.botId, payload.threadId, payload.generations, payload.connectionIdentity])}`,
    maxAttempts: 12,
  };
}

/** Retries reuse the run's operation id, so the memory service never stores a turn twice. */
export function memoryRetainTurnJob(
  runId: string,
  messageIds: string[] = [],
  options: {
    pending?: BackgroundJobPayloads["memory.retain-turn"]["pending"];
    availableAt?: Date;
  } = {},
): BackgroundJob {
  return {
    name: "memory.retain-turn",
    payload: {
      runId,
      ...(messageIds.length ? { messageIds } : {}),
      ...(options.pending ? { pending: options.pending } : {}),
    },
    // Submission retries must not replace cleanup that already guards a remote write.
    replaceKey: `memory.retain-turn:${runId}${options.pending ? ":settle" : ""}`,
    ...(options.availableAt ? { availableAt: options.availableAt } : {}),
    maxAttempts: 4,
  };
}

/** A few tries ride out an Expo outage well inside the day it keeps receipts. */
export function pushReceiptJob(
  payload: BackgroundJobPayloads["push.receipt"],
  availableAt: Date,
): BackgroundJob {
  return { name: "push.receipt", payload, availableAt, maxAttempts: 8 };
}

export function cloudAgentPollJobKey(agentId: string): string {
  return `cloud_agent.poll:${agentId}`;
}

export function cloudAgentPollJob(
  payload: BackgroundJobPayloads["cloud_agent.poll"],
  availableAt?: Date,
): BackgroundJob {
  return {
    name: "cloud_agent.poll",
    payload,
    replaceKey: cloudAgentPollJobKey(payload.agentId),
    ...(availableAt ? { availableAt } : {}),
  };
}

export function purchasePollJob(purchaseId: string, availableAt?: Date): BackgroundJob {
  return {
    name: "purchase.poll",
    payload: { purchaseId },
    replaceKey: `purchase.poll:${purchaseId}`,
    ...(availableAt ? { availableAt } : {}),
  };
}

export function mediaPollJob(jobId: string, availableAt?: Date): BackgroundJob {
  return {
    name: "media.poll",
    payload: { jobId },
    replaceKey: `media.poll:${jobId}`,
    ...(availableAt ? { availableAt } : {}),
  };
}
