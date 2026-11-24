import { createHmac } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { taskCallbackJob } from "@rakazo/adapter-kit";
import type { TaskCallbackBody } from "@rakazo/contracts";
import { TASK_CALLBACK_SIGNATURE_HEADER, taskSettled } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { SafeWebFetchOptions } from "../web/web-ssrf.js";
import { fetchSafeHttpRequest } from "../web/web-ssrf.js";
import { readPublicTask } from "./public-task.js";

/** While a task works, its callback checks back this often; settling sends it at once. */
export const TASK_CALLBACK_RECHECK_MS = 5 * 60_000;
/** A task nobody settles in a week is not reported. */
const TASK_CALLBACK_GIVE_UP_MS = 7 * 24 * 60 * 60_000;
const DELIVERY_TIMEOUT_MS = 15_000;

/** The key every callback secret is derived from, so no callback secret is stored. */
export function taskCallbackRootKey(encryptionKey: string): string {
  return createHmac("sha256", encryptionKey).update("rakazo:task-callback:v1").digest("hex");
}

/** The secret the caller verifies one task's callbacks with, returned once when it is created. */
export function taskCallbackSecret(rootKey: string, callbackId: string): string {
  return `whsec_${createHmac("sha256", rootKey).update(callbackId).digest("hex")}`;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, so a replayed old body is visible. */
export function signTaskCallback(secret: string, body: string, timestamp: number): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

/** Brings a task's pending callback forward once one of its runs ends. */
export async function promptTaskCallback(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  taskId: string,
): Promise<void> {
  const callback = await deps.prisma.taskCallback.findUnique({
    where: { taskId },
    select: { deliveredAt: true },
  });
  if (!callback || callback.deliveredAt) return;
  await deps.jobs.enqueue(taskCallbackJob(taskId, new Date()));
}

/**
 * Sends a settled task to its callback address once, or checks back later while it works. A
 * failed delivery throws, so the queue retries it with backoff. Runs in the task owner's Space.
 */
export async function deliverTaskCallback(
  deps: {
    prisma: PrismaClient;
    jobs: Pick<JobPublisher, "enqueue">;
    rootKey: string;
    /** The safe fetch's own seams, so tests reach no network. */
    egress?: Pick<SafeWebFetchOptions, "fetch" | "resolveHostname">;
    now?: () => Date;
  },
  taskId: string,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const callback = await deps.prisma.taskCallback.findUnique({ where: { taskId } });
  if (!callback || callback.deliveredAt) return;
  const task = await readPublicTask(deps.prisma, {
    taskId,
    userId: callback.userId,
    spaceId: callback.spaceId,
  });
  if (!task) return;
  if (!taskSettled(task.status)) {
    if (now.getTime() - callback.createdAt.getTime() < TASK_CALLBACK_GIVE_UP_MS)
      await deps.jobs.enqueue(
        taskCallbackJob(taskId, new Date(now.getTime() + TASK_CALLBACK_RECHECK_MS)),
      );
    return;
  }
  const body = JSON.stringify({ type: "task.settled", task } satisfies TaskCallbackBody);
  const signature = signTaskCallback(
    taskCallbackSecret(deps.rootKey, callback.id),
    body,
    Math.floor(now.getTime() / 1000),
  );
  const response = await fetchSafeHttpRequest(
    callback.url,
    {
      method: "POST",
      headers: { "content-type": "application/json", [TASK_CALLBACK_SIGNATURE_HEADER]: signature },
      body,
    },
    { ...deps.egress, timeoutMs: DELIVERY_TIMEOUT_MS, maxBytes: 1024, allowedPorts: [443] },
  );
  if (response.status < 200 || response.status >= 300) {
    getLogger().warn("task callback refused", { taskId, status: response.status });
    throw new Error(`Task callback answered ${response.status}`);
  }
  await deps.prisma.taskCallback.updateMany({
    where: { id: callback.id, deliveredAt: null },
    data: { deliveredAt: now },
  });
}
