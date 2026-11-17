import type { BackgroundJobPayloads, JobPublisher, JobTransaction } from "@rakazo/adapter-kit";
import { messagingInboundSettleJob, messagingInboundSettleJobKey } from "@rakazo/adapter-kit";
import { DIRECT_MESSAGE_SETTLE_BUDGET_MS } from "./limits.js";

export type SettlePayload = BackgroundJobPayloads["messaging.inbound_settle"];

/** Past the message's settle budget, so the job never races a direct path still in its time. */
const SETTLE_JOB_MARGIN_MS = 60_000;

/** Records the message's backup job, due once its settle budget from `receivedAt` is spent. */
export function recordSettleJob(
  jobs: Pick<JobPublisher, "enqueueIn">,
  tx: JobTransaction,
  payload: SettlePayload,
  receivedAt: number,
): Promise<void> {
  return jobs.enqueueIn(
    tx,
    messagingInboundSettleJob(
      payload,
      new Date(receivedAt + DIRECT_MESSAGE_SETTLE_BUDGET_MS + SETTLE_JOB_MARGIN_MS),
    ),
  );
}

/** The message settled here: its backup job has nothing left to do. */
export function cancelSettleJob(
  jobs: Pick<JobPublisher, "cancelIn">,
  tx: JobTransaction,
  payload: Pick<SettlePayload, "provider" | "handle">,
): Promise<void> {
  return jobs.cancelIn(tx, messagingInboundSettleJobKey(payload.provider, payload.handle));
}

/** Settling here failed cleanly: the backup job takes the message now instead of later. */
export function settleByJobNow(
  jobs: Pick<JobPublisher, "enqueue">,
  payload: SettlePayload,
): Promise<void> {
  return jobs.enqueue(messagingInboundSettleJob(payload, new Date()));
}
