import type { BackgroundJobPayloads, JobPublisher, JobTransaction } from "@rakazo/adapter-kit";
import { messagingInboundSettleJob, messagingInboundSettleJobKey } from "@rakazo/adapter-kit";
import { DIRECT_MESSAGE_SETTLE_BUDGET_MS } from "./limits.js";

export type SettlePayload = BackgroundJobPayloads["messaging.inbound_settle"];

/** Past the message's settle budget, so the job never races a direct path still in its time. */
const SETTLE_JOB_MARGIN_MS = 60_000;

/** When a message's backup job is due: once its settle budget from `receivedAt` is spent. */
export function settleJobDueAt(receivedAt: number): Date {
  return new Date(receivedAt + DIRECT_MESSAGE_SETTLE_BUDGET_MS + SETTLE_JOB_MARGIN_MS);
}

/** Records the message's backup job. */
export function recordSettleJob(
  jobs: Pick<JobPublisher, "enqueueIn">,
  tx: JobTransaction,
  payload: SettlePayload,
  dueAt: Date,
): Promise<void> {
  return jobs.enqueueIn(tx, messagingInboundSettleJob(payload, dueAt));
}

/** The message settled here: its backup job has nothing left to do. */
export function cancelSettleJob(
  jobs: Pick<JobPublisher, "cancelIn">,
  tx: JobTransaction,
  payload: Pick<SettlePayload, "provider" | "handle">,
): Promise<void> {
  return jobs.cancelIn(tx, messagingInboundSettleJobKey(payload.provider, payload.handle));
}

/**
 * Writes the message's backup job again, under its key: due at `dueAt` (now, when settling here
 * failed cleanly or the process is stopping), or with what a stop changed in its payload.
 */
export function settleJobAt(
  jobs: Pick<JobPublisher, "enqueue">,
  payload: SettlePayload,
  dueAt: Date,
): Promise<void> {
  return jobs.enqueue(messagingInboundSettleJob(payload, dueAt));
}
