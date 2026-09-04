import type {
  AdapterContext,
  BackgroundJobPayloads,
  CloudAgentProvider,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { cloudAgentPollJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type PrismaClient,
  type ThreadEvents,
  withTransactionRetry,
} from "@rakazo/db";

const TERMINAL = new Set(["finished", "failed", "cancelled"]);
/** Consecutive provider get() failures before the card is marked failed and the bot is woken. */
const MAX_ERROR_ATTEMPTS = 20;

type CloudAgentBlock = Extract<MessageBlock, { kind: "cloud_agent" }>;

export async function pollCloudAgent(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events: Pick<ThreadEvents, "notify">;
    cloudAgent: CloudAgentProvider | null | undefined;
  },
  payload: BackgroundJobPayloads["cloud_agent.poll"],
): Promise<void> {
  if (!deps.cloudAgent) return;
  const context: AdapterContext = {
    operationId: `cloud-agent-poll:${payload.agentId}`,
    traceId: `cloud-agent-poll:${payload.agentId}`,
    spaceId: payload.spaceId,
    userId: payload.userId,
    botId: payload.botId,
    signal: new AbortController().signal,
  };

  const attempt = payload.attempt ?? 0;
  const errorAttempt = payload.errorAttempt ?? 0;
  let snapshot: Awaited<ReturnType<CloudAgentProvider["get"]>>;
  try {
    snapshot = await deps.cloudAgent.get(payload.agentId, context);
  } catch (error) {
    console.error("cloud agent poll", error);
    if (errorAttempt + 1 >= MAX_ERROR_ATTEMPTS) {
      await failStuckCloudAgent(deps, payload, "Cloud agent polling failed repeatedly.");
      return;
    }
    await deps.jobs.enqueue(
      cloudAgentPollJob(
        { ...payload, attempt: attempt + 1, errorAttempt: errorAttempt + 1 },
        new Date(Date.now() + pollDelayMs(attempt)),
      ),
    );
    return;
  }

  const message = await deps.prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { id: true, blocks: true, threadId: true },
  });
  if (!message || message.threadId !== payload.threadId) return;

  const previous = (message.blocks as MessageBlock[]).find(
    (block): block is CloudAgentBlock =>
      block.kind === "cloud_agent" && block.agentId === payload.agentId,
  );
  const nextBlock: CloudAgentBlock = {
    kind: "cloud_agent",
    agentId: payload.agentId,
    title: snapshot.title || previous?.title || "Cloud agent",
    status: snapshot.status,
    url: snapshot.url || previous?.url || "",
    ...(snapshot.branch || previous?.branch ? { branch: snapshot.branch || previous?.branch } : {}),
    ...(snapshot.prUrl || previous?.prUrl ? { prUrl: snapshot.prUrl || previous?.prUrl } : {}),
    ...(snapshot.latestRunId || previous?.latestRunId
      ? { latestRunId: snapshot.latestRunId || previous?.latestRunId }
      : {}),
  };

  const changed =
    !previous ||
    previous.title !== nextBlock.title ||
    previous.status !== nextBlock.status ||
    previous.url !== nextBlock.url ||
    previous.branch !== nextBlock.branch ||
    previous.prUrl !== nextBlock.prUrl ||
    previous.latestRunId !== nextBlock.latestRunId;

  if (changed) {
    const blocks = (message.blocks as MessageBlock[]).map((block) =>
      block.kind === "cloud_agent" && block.agentId === payload.agentId ? nextBlock : block,
    );
    const committed = await deps.prisma.$transaction(async (tx) => {
      await tx.message.update({
        where: { id: message.id },
        data: { blocks },
      });
      return appendEventInTransaction(tx, {
        spaceId: payload.spaceId,
        threadId: payload.threadId,
        botId: payload.botId,
        type: "thread.cloud_agent",
        payload: {
          messageId: message.id,
          agentId: snapshot.id,
          title: nextBlock.title,
          status: nextBlock.status,
          url: nextBlock.url,
          branch: nextBlock.branch,
          prUrl: nextBlock.prUrl,
          latestRunId: nextBlock.latestRunId,
        },
      });
    });
    await deps.events.notify(payload.threadId, committed.seq).catch((error) => {
      console.error("cloud agent poll realtime notification", error);
    });
  }

  if (!TERMINAL.has(snapshot.status)) {
    // Still running: keep polling with backoff. Do not abandon long-lived agents.
    await deps.jobs.enqueue(
      cloudAgentPollJob(
        { ...payload, attempt: attempt + 1, errorAttempt: 0 },
        new Date(Date.now() + pollDelayMs(attempt)),
      ),
    );
    return;
  }

  await wakeBotForCloudAgent(deps, payload, {
    ...snapshot,
    latestRunId: snapshot.latestRunId || nextBlock.latestRunId,
  });
}

function pollDelayMs(attempt: number): number {
  if (attempt < 12) return 5_000;
  if (attempt < 36) return 15_000;
  return 60_000;
}

async function failStuckCloudAgent(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events: Pick<ThreadEvents, "notify">;
  },
  payload: BackgroundJobPayloads["cloud_agent.poll"],
  reason: string,
): Promise<void> {
  const message = await deps.prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { id: true, blocks: true, threadId: true },
  });
  if (!message || message.threadId !== payload.threadId) return;

  let title = "Cloud agent";
  let url = "";
  let branch: string | undefined;
  let prUrl: string | undefined;
  let latestRunId: string | undefined;
  const blocks = (message.blocks as MessageBlock[]).map((block) => {
    if (block.kind !== "cloud_agent" || block.agentId !== payload.agentId) return block;
    title = block.title || title;
    url = block.url || url;
    branch = block.branch;
    prUrl = block.prUrl;
    latestRunId = block.latestRunId;
    return { ...block, status: "failed" as const };
  });

  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    return appendEventInTransaction(tx, {
      spaceId: payload.spaceId,
      threadId: payload.threadId,
      botId: payload.botId,
      type: "thread.cloud_agent",
      payload: {
        messageId: message.id,
        agentId: payload.agentId,
        title,
        status: "failed",
        url,
        branch,
        prUrl,
        latestRunId,
      },
    });
  });
  await deps.events.notify(payload.threadId, committed.seq).catch((error) => {
    console.error("cloud agent fail realtime notification", error);
  });

  await wakeBotForCloudAgent(deps, payload, {
    id: payload.agentId,
    title,
    status: "failed",
    url,
    branch,
    prUrl,
    latestRunId,
  });
  console.error("cloud agent poll abandoned", reason, payload.agentId);
}

async function wakeBotForCloudAgent(
  deps: { prisma: PrismaClient; jobs: JobPublisher; events: Pick<ThreadEvents, "notify"> },
  payload: BackgroundJobPayloads["cloud_agent.poll"],
  snapshot: {
    id: string;
    title: string;
    status: string;
    url: string;
    branch?: string;
    prUrl?: string;
    latestRunId?: string;
  },
) {
  // Include latestRunId so a later follow-up that ends in the same status still wakes the bot.
  // Same agentId+status+latestRunId is idempotent — do not remint on terminal retries.
  const wakeNonce = `cloud-agent-wake:${payload.agentId}:${snapshot.status}:${snapshot.latestRunId ?? "na"}`;
  const existing = await deps.prisma.message.findFirst({
    where: { threadId: payload.threadId, clientNonce: wakeNonce },
    select: { id: true, runId: true },
  });
  if (existing?.runId) {
    const prior = await deps.prisma.run.findUnique({
      where: { id: existing.runId },
      select: { status: true },
    });
    if (prior && !TERMINAL.has(prior.status)) {
      // Let enqueue failures propagate so Graphile can retry this poll job.
      await deps.jobs.enqueue(runContinueJob(existing.runId));
      return;
    }
    // Same completion already woke the bot.
    return;
  }

  const summary = [
    `Cloud agent "${snapshot.title}" is ${snapshot.status}.`,
    snapshot.prUrl ? `PR: ${snapshot.prUrl}` : null,
    snapshot.branch ? `Branch: ${snapshot.branch}` : null,
    `Agent: ${snapshot.url}`,
  ]
    .filter(Boolean)
    .join(" ");

  const claimed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const wakeMessage = await createThreadMessageInTransaction(tx, {
        threadId: payload.threadId,
        role: "system",
        blocks: [{ kind: "meta", text: summary }],
        botId: payload.botId,
        clientNonce: wakeNonce,
      });
      const task = await tx.task.create({
        data: {
          spaceId: payload.spaceId,
          botId: payload.botId,
          threadId: payload.threadId,
          userId: payload.userId,
          prompt: summary,
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: payload.spaceId,
          botId: payload.botId,
          threadId: payload.threadId,
          taskId: task.id,
          userId: payload.userId,
          status: "queued",
          trigger: "cloud_agent",
          sourceMessageId: wakeMessage.id,
          clientNonce: `cloud-agent-wake-run:${wakeNonce}`,
        },
      });
      await tx.message.update({ where: { id: wakeMessage.id }, data: { runId: run.id } });
      const event = await appendEventInTransaction(tx, {
        spaceId: payload.spaceId,
        threadId: payload.threadId,
        botId: payload.botId,
        type: "thread.message.created",
        runId: run.id,
        payload: {
          messageId: wakeMessage.id,
          role: "system",
          blocks: [{ kind: "meta", text: summary }],
        },
      });
      return { run, seq: event.seq };
    }),
  );
  await deps.events.notify(payload.threadId, claimed.seq).catch((error) => {
    console.error("cloud agent wake realtime notification", error);
  });

  // Let enqueue failures propagate so Graphile can retry this poll job.
  await deps.jobs.enqueue(runContinueJob(claimed.run.id));
}
