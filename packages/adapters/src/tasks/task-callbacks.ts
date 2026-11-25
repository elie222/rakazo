import { createHash, createHmac } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { taskCallbackJob } from "@rakazo/adapter-kit";
import type { PublicTask, TaskCallbackBody } from "@rakazo/contracts";
import {
  TASK_CALLBACK_DELIVERY_HEADER,
  TASK_CALLBACK_SIGNATURE_HEADER,
  taskSettled,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isEgressRefused } from "../network/network-address.js";
import type { SafeWebFetchOptions } from "../web/web-ssrf.js";
import { assertSafeWebUrl, fetchSafeHttpRequest } from "../web/web-ssrf.js";
import { apiKeyStillGrants } from "./api-key-access.js";
import { readPublicTask } from "./public-task.js";

/** While a task works, its callback checks back this often; settling sends it at once. */
export const TASK_CALLBACK_RECHECK_MS = 5 * 60_000;
/** A run still working a week after it started is not reported. */
const TASK_CALLBACK_GIVE_UP_MS = 7 * 24 * 60 * 60_000;
const DELIVERY_TIMEOUT_MS = 15_000;
const CALLBACK_PORTS = [443];
/** The most output one callback carries, in characters: the newest part, the rest stays on the task. */
const CALLBACK_OUTPUT_LIMIT = 64 * 1024;

/**
 * Refuses, before any work starts, an address a callback could never be delivered to: not HTTPS
 * on the default port, or a private or local host. A lookup that fails for another reason, such
 * as a resolver outage, propagates as a server error.
 */
export async function assertCallbackUrl(
  url: string,
  resolveHostname?: SafeWebFetchOptions["resolveHostname"],
): Promise<void> {
  const refused = () =>
    new ClientError(
      "BAD_REQUEST",
      "callback_url must be a public HTTPS address on the default port",
    );
  const parsed = URL.parse(url);
  if (
    parsed?.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !CALLBACK_PORTS.includes(Number(parsed.port || 443))
  )
    throw refused();
  try {
    await assertSafeWebUrl(url, resolveHostname, undefined, CALLBACK_PORTS);
  } catch (error) {
    if (isEgressRefused(error)) throw refused();
    throw error;
  }
}

/** The key every callback secret is derived from, so no callback secret is stored. */
export function taskCallbackRootKey(encryptionKey: string): string {
  return createHmac("sha256", encryptionKey).update("rakazo:task-callback:v1").digest("hex");
}

/**
 * The secret callbacks to one address are signed with for one key. Every task the key sends there
 * shares it, so a follow-up's new task needs no new one; a new key gets a new secret.
 */
export function taskCallbackSecret(rootKey: string, issuerKeyId: string, url: string): string {
  return `whsec_${createHmac("sha256", rootKey).update(`${issuerKeyId}\n${url}`).digest("hex")}`;
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
  // Output goes only where the person could still read it themselves; otherwise it stops for good.
  const granted = await apiKeyStillGrants(deps.prisma, {
    keyId: callback.issuerKeyId,
    userId: callback.userId,
    spaceId: callback.spaceId,
  });
  if (!task || !latestRun || !granted) return;
  const recheck = async () => {
    if (now.getTime() - latestRun.createdAt.getTime() < TASK_CALLBACK_GIVE_UP_MS)
      await deps.jobs.enqueue(
        taskCallbackJob(taskId, new Date(now.getTime() + TASK_CALLBACK_RECHECK_MS), "recheck"),
      );
  };
  if (!taskSettled(task.status)) return recheck();
  // A run can ask more than once, so each question is its own state, named by what it asks; an
  // ended run is one state.
  const state =
    task.status === "needs_input"
      ? `needs_input:${createHash("sha256")
          .update(task.question ?? "")
          .digest("hex")
          .slice(0, 16)}`
      : task.status;
  // A waiting run may be cancelled or ask again with no worker to say so; keep looking, even if
  // this delivery fails for good.
  if (task.status === "needs_input") await recheck();
  if (callback.deliveredRunId !== latestRun.id || callback.deliveredStatus !== state) {
    await post(callback, task, `${taskId}:${latestRun.id}:${state}`);
    // Only the address it was sent to is marked; a changed address still gets this state.
    await deps.prisma.taskCallback.updateMany({
      where: { id: callback.id, url: callback.url },
      data: { deliveredAt: now, deliveredRunId: latestRun.id, deliveredStatus: state },
    });
  }

  async function post(
    target: { issuerKeyId: string; url: string },
    settled: PublicTask,
    delivery: string,
  ) {
    // The body stays small however long the task ran; the task itself holds all of it.
    const truncated = settled.output.length > CALLBACK_OUTPUT_LIMIT;
    const body = JSON.stringify({
      type: "task.settled",
      id: delivery,
      task: truncated
        ? { ...settled, output: settled.output.slice(-CALLBACK_OUTPUT_LIMIT) }
        : settled,
      truncated,
    } satisfies TaskCallbackBody);
    const signature = signTaskCallback(
      taskCallbackSecret(deps.rootKey, target.issuerKeyId, target.url),
      body,
      Math.floor(now.getTime() / 1000),
    );
    const response = await fetchSafeHttpRequest(
      target.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TASK_CALLBACK_SIGNATURE_HEADER]: signature,
          [TASK_CALLBACK_DELIVERY_HEADER]: delivery,
        },
        body,
      },
      {
        ...deps.egress,
        timeoutMs: DELIVERY_TIMEOUT_MS,
        maxBytes: 1024,
        allowedPorts: CALLBACK_PORTS,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      getLogger().warn("task callback refused", { taskId, status: response.status });
      throw new Error(`Task callback answered ${response.status}`);
    }
  }
}
