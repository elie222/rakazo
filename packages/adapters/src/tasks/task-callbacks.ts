import { createHmac } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { taskCallbackJob } from "@rakazo/adapter-kit";
import type { TaskCallbackBody } from "@rakazo/contracts";
import {
  TASK_CALLBACK_DELIVERY_HEADER,
  TASK_CALLBACK_SIGNATURE_HEADER,
  taskSettled,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { SafeWebFetchOptions } from "../web/web-ssrf.js";
import { fetchSafeHttpRequest } from "../web/web-ssrf.js";
import { readPublicTask } from "./public-task.js";

/** While a task works, its callback checks back this often; settling sends it at once. */
export const TASK_CALLBACK_RECHECK_MS = 5 * 60_000;
/** A run still working a week after it started is not reported. */
const TASK_CALLBACK_GIVE_UP_MS = 7 * 24 * 60 * 60_000;
const DELIVERY_TIMEOUT_MS = 15_000;

/** The key every callback secret is derived from, so no callback secret is stored. */
export function taskCallbackRootKey(encryptionKey: string): string {
  return createHmac("sha256", encryptionKey).update("rakazo:task-callback:v1").digest("hex");
}

/**
 * The secret one person's callbacks to one address are signed with. Every task that person sends
 * to that address shares it, so a follow-up's new task needs no new secret.
 */
export function taskCallbackSecret(rootKey: string, userId: string, url: string): string {
  return `whsec_${createHmac("sha256", rootKey).update(`${userId}\n${url}`).digest("hex")}`;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, so a replayed old body is visible. */
export function signTaskCallback(secret: string, body: string, timestamp: number): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

/** Brings a task's callback forward once one of its runs ends. */
export async function promptTaskCallback(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  taskId: string,
): Promise<void> {
  const callback = await deps.prisma.taskCallback.findUnique({
    where: { taskId },
    select: { id: true },
  });
  if (callback) await deps.jobs.enqueue(taskCallbackJob(taskId, new Date()));
}

/**
 * Sends a task's settled state to its callback address once per run and state, or checks back
 * later while it works. The delivery id is the same on every retry, so a receiver can drop a
 * repeat. A failed delivery throws, so the queue retries it with backoff. Runs in the owner's Space.
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
  if (!callback) return;
  const owner = { taskId, userId: callback.userId, spaceId: callback.spaceId };
  const [task, latestRun] = await Promise.all([
    readPublicTask(deps.prisma, owner),
    deps.prisma.run.findFirst({
      where: { taskId, userId: callback.userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true },
    }),
  ]);
  if (!task || !latestRun) return;
  if (!taskSettled(task.status)) {
    if (now.getTime() - latestRun.createdAt.getTime() < TASK_CALLBACK_GIVE_UP_MS)
      await deps.jobs.enqueue(
        taskCallbackJob(taskId, new Date(now.getTime() + TASK_CALLBACK_RECHECK_MS)),
      );
    return;
  }
  if (callback.deliveredRunId === latestRun.id && callback.deliveredStatus === task.status) return;
  const delivery = `${taskId}:${latestRun.id}:${task.status}`;
  const body = JSON.stringify({
    type: "task.settled",
    id: delivery,
    task,
  } satisfies TaskCallbackBody);
  const signature = signTaskCallback(
    taskCallbackSecret(deps.rootKey, callback.userId, callback.url),
    body,
    Math.floor(now.getTime() / 1000),
  );
  const response = await fetchSafeHttpRequest(
    callback.url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TASK_CALLBACK_SIGNATURE_HEADER]: signature,
        [TASK_CALLBACK_DELIVERY_HEADER]: delivery,
      },
      body,
    },
    { ...deps.egress, timeoutMs: DELIVERY_TIMEOUT_MS, maxBytes: 1024, allowedPorts: [443] },
  );
  if (response.status < 200 || response.status >= 300) {
    getLogger().warn("task callback refused", { taskId, status: response.status });
    throw new Error(`Task callback answered ${response.status}`);
  }
  // Records what was sent, not what is current: a later state always differs and is sent too.
  await deps.prisma.taskCallback.update({
    where: { id: callback.id },
    data: { deliveredAt: now, deliveredRunId: latestRun.id, deliveredStatus: task.status },
  });
}
