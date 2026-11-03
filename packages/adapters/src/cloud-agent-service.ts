import type { AdapterContext, JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import { cloudAgentPollJob } from "@rakazo/adapter-kit";
import { cloudAgentBlockFromPayload } from "@rakazo/core";
import type { CloudAgent, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { activeCloudAgentBinding, savedCloudAgentProviderKeys } from "./cloud-agent-credentials.js";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { cloudAgentLaunchSchema, cloudAgentReplySchema } from "./cloud-agent-tools.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { runLeaseFor } from "./run-messages.js";

export interface CloudAgentDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "notify">;
  cloudAgent: CloudAgentConnection | null | undefined;
  /** Loads a user's saved key while polling. Deploy-key agents do not need it. */
  secretStore?: Pick<SecretStore, "put" | "load" | "delete">;
  runLease?: ExecutorDeps["runLease"];
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
  const active = await activeCloudAgentBinding(deps, context.userId, context.spaceId);
  if (!connection || !active) {
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
          existing.providerKey !== active.providerKey
        ) {
          throw new Error("Cloud agent operation scope changed");
        }
        return { agent: existing };
      }
      const created = await tx.cloudAgent.create({
        data: {
          operationKey: context.operationId,
          providerKey: active.providerKey,
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
        lease: runLeaseFor(deps, run.id),
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
        lease: runLeaseFor(deps, run.id),
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
      return {
        agent: saved,
        seq: event.seq,
        firstResponseRunId: event.firstResponse ? run.id : undefined,
      };
    });
    agent = result.agent;
    if (result.seq !== undefined)
      await deps.events
        .notify(run.threadId, result.seq, result.firstResponseRunId)
        .catch(() => undefined);
  } else {
    const owned = await deps.prisma.cloudAgent.findFirst({
      where: {
        id: String(args.id).trim(),
        spaceId: context.spaceId,
        userId: context.userId,
      },
    });
    if (!owned || owned.providerKey !== active.providerKey)
      return { error: "Unknown cloud agent." };
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
          followupDispatchedAt: null,
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
    ...(agent.followupDispatchedAt ? { followupPending: true } : {}),
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
  const connection = deps.cloudAgent;
  if (!connection) return;
  const userKeys = await runAsSystem("list saved cloud agent keys", () =>
    savedCloudAgentProviderKeys(deps.prisma, connection.userCredentialProviderId),
  );
  const bindings = [
    ...(connection.provider && connection.key
      ? [
          {
            providerKey: connection.key,
            ...(connection.spaceId ? { spaceId: connection.spaceId } : {}),
          },
        ]
      : []),
    ...(userKeys.length ? [{ providerKey: { in: userKeys } }] : []),
  ];
  if (!bindings.length) return;
  const due = await deps.prisma.cloudAgent.findMany({
    where: {
      nextPollAt: { lte: new Date() },
      OR: bindings,
    },
    orderBy: [{ nextPollAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true },
  });
  for (const agent of due) await enqueueCloudAgent(deps, agent.id);
}
