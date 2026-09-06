import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  BackgroundJobPayloads,
  CloudAgentSnapshot,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import { appendEventInTransaction, type CloudAgent, Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cloudAgentsEnabled } from "./cloud-agent-factory.js";
import { type CloudAgentDeps, cloudAgentBlock, enqueueCloudAgent } from "./cloud-agent-service.js";
import { cloudAgentLaunchSchema, cloudAgentPromptSchema } from "./cloud-agent-tools.js";

/** Reconcile one persisted intent. A fenced lease serializes remote mutations. */
export async function pollCloudAgent(
  deps: CloudAgentDeps,
  payload: BackgroundJobPayloads["cloud_agent.poll"],
) {
  const connection = deps.cloudAgent;
  if (!connection) return;
  const stored = await deps.prisma.cloudAgent.findFirst({
    where: { id: payload.agentId, providerKey: connection.key },
  });
  if (!stored?.nextPollAt || !cloudAgentsEnabled(connection, stored.spaceId)) return;
  const token = randomUUID();
  const claimed = await deps.prisma.cloudAgent.updateMany({
    where: {
      id: stored.id,
      version: stored.version,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
    },
    data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + 90_000) },
  });
  if (!claimed.count) return;
  const agent = { ...stored, leaseToken: token };
  const context: AdapterContext = {
    operationId: agent.id,
    traceId: agent.id,
    spaceId: agent.spaceId,
    userId: agent.userId,
    botId: agent.botId,
    signal: AbortSignal.timeout(60_000),
  };
  const provider = connection.provider;
  try {
    const [card, member, bot] = await Promise.all([
      deps.prisma.message.findFirst({
        where: { id: agent.messageId ?? "", threadId: agent.threadId },
        select: { id: true },
      }),
      deps.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: agent.spaceId, userId: agent.userId } },
        select: { id: true },
      }),
      deps.prisma.bot.findFirst({
        where: { id: agent.botId, spaceId: agent.spaceId, userId: agent.userId, archivedAt: null },
      }),
    ]);
    const abandoned = !card || !member || !bot;
    if ((abandoned || agent.cancelRequested) && !agent.remoteId && !agent.launchDispatched) {
      await finishPoll(
        deps,
        agent,
        { status: "cancelled", cancelRequested: false, launchRequest: {} },
        abandoned,
      );
      return;
    }
    if (!agent.remoteId) {
      // Write dispatch intent before I/O; a crash replays the same idempotent create.
      const marked = await deps.prisma.cloudAgent.updateMany({
        where: fence(agent),
        data: { launchDispatched: true },
      });
      if (!marked.count) return;
      const request = cloudAgentLaunchSchema.parse(agent.launchRequest);
      try {
        const snapshot = await provider.launch({ ...request, idempotencyKey: agent.id }, context);
        await finishPoll(
          deps,
          agent,
          {
            ...snapshotData(snapshot),
            remoteId: snapshot.id,
            launchRequest: {},
            cancelRequested: abandoned || agent.cancelRequested,
          },
          abandoned,
        );
      } catch (error) {
        if (!(error instanceof CloudAgentRequestRejected)) throw error;
        await finishPoll(deps, agent, { status: "failed", launchRequest: {} }, abandoned);
      }
      return;
    }
    if (abandoned || agent.cancelRequested) {
      if (agent.followup && !agent.followupDispatching) {
        await finishPoll(
          deps,
          agent,
          { status: "cancelled", followup: Prisma.DbNull, cancelRequested: false },
          abandoned,
        );
        return;
      }
      const snapshot = await provider.cancel(
        agent.remoteId,
        context,
        agent.followupDispatching ? undefined : (agent.latestRunId ?? undefined),
      );
      if (agent.followupDispatching && snapshot.latestRunId === agent.latestRunId) {
        // The ambiguous follow-up may still be accepted. An old terminal run
        // cannot confirm cancellation of the pending new run.
        await retryPoll(deps, agent);
        return;
      }
      await finishPoll(
        deps,
        agent,
        {
          ...snapshotData(snapshot),
          cancelRequested: snapshot.status === "running",
          followup: Prisma.DbNull,
          followupDispatching: false,
        },
        abandoned,
      );
      return;
    }
    if (agent.followup) {
      if (agent.followupDispatching) {
        // A lost reply response is ambiguous. Observe it; never resend the mutation.
        const snapshot = await provider.get(agent.remoteId, context);
        if (!snapshot.latestRunId || snapshot.latestRunId === agent.latestRunId) {
          await retryPoll(deps, agent);
          return;
        }
        await finishPoll(deps, agent, {
          ...snapshotData(snapshot),
          followup: Prisma.DbNull,
          followupDispatching: false,
        });
      } else {
        const marked = await deps.prisma.cloudAgent.updateMany({
          where: fence(agent),
          data: { followupDispatching: true },
        });
        if (!marked.count) return;
        try {
          const snapshot = await provider.reply(
            agent.remoteId,
            cloudAgentPromptSchema.parse(agent.followup),
            context,
          );
          if (!snapshot.latestRunId || snapshot.latestRunId === agent.latestRunId)
            throw new Error("Cloud agent follow-up did not identify a new run");
          await finishPoll(deps, agent, {
            ...snapshotData(snapshot),
            followup: Prisma.DbNull,
            followupDispatching: false,
          });
        } catch (error) {
          if (!(error instanceof CloudAgentRequestRejected)) throw error;
          await finishPoll(deps, agent, {
            status: "failed",
            followup: Prisma.DbNull,
            followupDispatching: false,
          });
        }
      }
      return;
    }
    // A specific run cannot regress to stale agent-level metadata after a follow-up.
    const snapshot = await provider.get(agent.remoteId, context, agent.latestRunId ?? undefined);
    await finishPoll(deps, agent, snapshotData(snapshot));
  } catch {
    // Provider response bodies and secrets never enter logs, cards, or model context.
    getLogger().warn("cloud agent operation deferred to reconciliation");
    await retryPoll(deps, agent);
  } finally {
    // A concurrent user action can change version while remote I/O is in flight.
    // Release only our lease, preserving that action's pending intent and due date.
    await deps.prisma.cloudAgent.updateMany({
      where: { id: agent.id, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
}

function fence(agent: CloudAgent) {
  return { id: agent.id, version: agent.version, leaseToken: agent.leaseToken };
}

function snapshotData(snapshot: CloudAgentSnapshot): Prisma.CloudAgentUpdateManyMutationInput {
  return {
    title: snapshot.title,
    status: snapshot.status,
    url: cloudAgentHttpsUrl(snapshot.url) ?? "",
    branch: snapshot.branch,
    prUrl: snapshot.prUrl ? (cloudAgentHttpsUrl(snapshot.prUrl) ?? "") : undefined,
    latestRunId: snapshot.latestRunId,
  };
}

async function retryPoll(deps: CloudAgentDeps, agent: CloudAgent) {
  const nextPollAt = new Date(
    Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(agent.errorCount, 4)),
  );
  const saved = await deps.prisma.cloudAgent.updateMany({
    where: fence(agent),
    data: {
      nextPollAt,
      errorCount: { increment: 1 },
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (saved.count) await enqueueCloudAgent(deps, agent.id, nextPollAt);
}

async function finishPoll(
  deps: CloudAgentDeps,
  agent: CloudAgent,
  data: Prisma.CloudAgentUpdateManyMutationInput,
  abandoned = false,
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as clearing chat: thread first, then message/run changes.
    const thread = await tx.thread.updateMany({
      where: {
        id: agent.threadId,
        spaceId: agent.spaceId,
        userId: agent.userId,
      },
      data: { nextEventSeq: { increment: 0 } },
    });
    const message = thread.count
      ? await tx.message.findFirst({
          where: {
            id: agent.messageId ?? "",
            threadId: agent.threadId,
          },
        })
      : null;
    const [member, bot] = await Promise.all([
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: agent.spaceId, userId: agent.userId } },
        select: { id: true },
      }),
      tx.bot.findFirst({
        where: { id: agent.botId, spaceId: agent.spaceId, userId: agent.userId, archivedAt: null },
        select: { id: true },
      }),
    ]);
    const detached = abandoned || !message || !member || !bot;
    const status = typeof data.status === "string" ? data.status : agent.status;
    const terminal = status !== "running";
    const cancelRequested =
      !terminal && (detached || data.cancelRequested === true || agent.cancelRequested);
    const nextPollAt = terminal ? null : new Date(Date.now() + 5_000);
    const updated = await tx.cloudAgent.updateMany({
      where: fence(agent),
      data: {
        ...data,
        cancelRequested,
        nextPollAt,
        errorCount: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        version: { increment: 1 },
      },
    });
    if (!updated.count) return null;
    const saved = await tx.cloudAgent.findUniqueOrThrow({ where: { id: agent.id } });
    let seq: number | undefined;
    let wakeRunId: string | undefined;
    if (message && !detached) {
      const nextBlock = cloudAgentBlock(saved);
      const blocks = (message.blocks as MessageBlock[]).map((block) =>
        block.kind === "cloud_agent" && block.agentId === agent.id ? nextBlock : block,
      );
      if (JSON.stringify(blocks) !== JSON.stringify(message.blocks)) {
        await tx.message.update({ where: { id: message.id }, data: { blocks } });
        const event = await appendEventInTransaction(tx, {
          spaceId: agent.spaceId,
          threadId: agent.threadId,
          botId: agent.botId,
          type: "thread.cloud_agent",
          payload: { messageId: message.id, ...nextBlock },
        });
        seq = event.seq;
      }
      if (terminal && saved.wakeGeneration < saved.generation) {
        // Provider text is untrusted. Wake with local identity and status only.
        const summary = `Cloud agent ${agent.id} is ${status}. Use cloud_agent_status to inspect its result.`;
        const task = await tx.task.create({
          data: {
            spaceId: agent.spaceId,
            botId: agent.botId,
            threadId: agent.threadId,
            userId: agent.userId,
            prompt: summary,
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: agent.spaceId,
            botId: agent.botId,
            threadId: agent.threadId,
            userId: agent.userId,
            taskId: task.id,
            status: "queued",
            trigger: "cloud_agent",
            clientNonce: `cloud-agent-wake-run:${agent.id}:${saved.generation}`,
          },
        });
        await tx.cloudAgent.update({
          where: { id: agent.id },
          data: { wakeGeneration: saved.generation },
        });
        wakeRunId = run.id;
      }
    }
    return { seq, wakeRunId, nextPollAt };
  });
  if (!committed) return;
  if (committed.seq !== undefined)
    await deps.events.notify(agent.threadId, committed.seq).catch(() => undefined);
  if (committed.wakeRunId) {
    // The existing run reconciler recovers a queued wake after an enqueue failure.
    await deps.jobs.enqueue(runContinueJob(committed.wakeRunId)).catch(() => {
      getLogger().warn("cloud agent wake deferred to reconciliation");
    });
  }
  if (committed.nextPollAt) await enqueueCloudAgent(deps, agent.id, committed.nextPollAt);
}
