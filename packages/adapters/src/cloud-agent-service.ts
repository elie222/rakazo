import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import { cloudAgentPollJob } from "@rakazo/adapter-kit";
import { cloudAgentBlockFromPayload } from "@rakazo/core";
import {
  appendEventInTransaction,
  type CloudAgent,
  createThreadMessageInTransaction,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { type CloudAgentConnection, cloudAgentsEnabled } from "./cloud-agent-factory.js";
import { cloudAgentLaunchSchema, cloudAgentReplySchema } from "./cloud-agent-tools.js";

export interface CloudAgentDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "notify">;
  cloudAgent: CloudAgentConnection | null | undefined;
}

export function cloudAgentBlock(agent: CloudAgent) {
  return cloudAgentBlockFromPayload({ ...agent, agentId: agent.id });
}

/** Queue an intent only after scope and owner checks. The worker owns remote I/O. */
export async function executeCloudAgentTool(
  deps: CloudAgentDeps,
  context: AdapterContext & { botId: string },
  run: { id: string; threadId: string },
  name: string,
  args: Record<string, unknown>,
) {
  const connection = deps.cloudAgent;
  if (!connection || !cloudAgentsEnabled(connection, context.spaceId)) {
    return { error: "Cloud agents are not configured for this space." };
  }
  let agent: CloudAgent;
  if (name === "cloud_agent_launch") {
    const request = cloudAgentLaunchSchema.parse(args);
    const result = await deps.prisma.$transaction(async (tx) => {
      // Serialize with clearThread before creating either the intent or its card.
      await tx.thread.update({
        where: { id: run.threadId, userId: context.userId, spaceId: context.spaceId },
        data: { unread: false },
      });
      const existing = await tx.cloudAgent.findUnique({
        where: { operationKey: context.operationId },
      });
      if (existing) {
        if (
          existing.spaceId !== context.spaceId ||
          existing.userId !== context.userId ||
          existing.providerKey !== connection.key
        ) {
          throw new Error("Cloud agent operation scope changed");
        }
        return { agent: existing };
      }
      const created = await tx.cloudAgent.create({
        data: {
          operationKey: context.operationId,
          providerKey: connection.key,
          spaceId: context.spaceId,
          userId: context.userId,
          botId: context.botId,
          threadId: run.threadId,
          title: request.prompt.split(/\r?\n/, 1)[0]!.slice(0, 80),
          launchRequest: request,
        },
      });
      const blocks = [cloudAgentBlock(created)];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        botId: context.botId,
        runId: run.id,
        role: "bot",
        blocks,
      });
      const saved = await tx.cloudAgent.update({
        where: { id: created.id },
        data: { messageId: message.id },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: context.spaceId,
        threadId: run.threadId,
        botId: context.botId,
        runId: run.id,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
      return { agent: saved, seq: event.seq };
    });
    agent = result.agent;
    if (result.seq !== undefined)
      await deps.events.notify(run.threadId, result.seq).catch(() => undefined);
  } else {
    const owned = await deps.prisma.cloudAgent.findFirst({
      where: {
        id: String(args.id).trim(),
        providerKey: connection.key,
        spaceId: context.spaceId,
        userId: context.userId,
      },
    });
    if (!owned) return { error: "Unknown cloud agent." };
    agent = owned;
    if (name === "cloud_agent_reply") {
      if (
        agent.status === "running" ||
        agent.followup ||
        agent.cancelRequested ||
        !agent.remoteId
      ) {
        return { error: "Wait for the current cloud agent operation to finish." };
      }
      const { id: _id, ...followup } = cloudAgentReplySchema.parse(args);
      const updated = await deps.prisma.cloudAgent.updateMany({
        where: { id: agent.id, version: agent.version },
        data: {
          followup,
          followupDispatching: false,
          status: "running",
          generation: { increment: 1 },
          version: { increment: 1 },
          nextPollAt: new Date(),
          errorCount: 0,
        },
      });
      if (!updated.count) return { error: "Cloud agent changed; check its status and try again." };
    } else if (name === "cloud_agent_cancel") {
      await deps.prisma.cloudAgent.update({
        where: { id: agent.id },
        data: { cancelRequested: true, version: { increment: 1 }, nextPollAt: new Date() },
      });
    }
    agent = await deps.prisma.cloudAgent.findUniqueOrThrow({ where: { id: agent.id } });
  }
  if (agent.nextPollAt) await enqueueCloudAgent(deps, agent.id);
  const { kind: _kind, agentId, ...snapshot } = cloudAgentBlock(agent);
  return {
    id: agentId,
    ...snapshot,
    ...(agent.cancelRequested ? { cancellationPending: true } : {}),
    ...(agent.followupDispatching ? { followupPending: true } : {}),
  };
}

/** The row is the outbox; queue failure leaves recoverable intent for the reconciler. */
export async function enqueueCloudAgent(
  deps: Pick<CloudAgentDeps, "jobs">,
  agentId: string,
  availableAt?: Date,
) {
  await deps.jobs.enqueue(cloudAgentPollJob({ agentId }, availableAt)).catch(() => {
    getLogger().warn("cloud agent scheduling deferred to reconciliation");
  });
}

export async function reconcileCloudAgents(
  deps: Pick<CloudAgentDeps, "prisma" | "jobs" | "cloudAgent">,
) {
  if (!deps.cloudAgent) return;
  const due = await deps.prisma.cloudAgent.findMany({
    where: {
      providerKey: deps.cloudAgent.key,
      nextPollAt: { lte: new Date() },
      ...(deps.cloudAgent.spaceId ? { spaceId: deps.cloudAgent.spaceId } : {}),
    },
    orderBy: [{ nextPollAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true },
  });
  for (const agent of due) await enqueueCloudAgent(deps, agent.id);
}
