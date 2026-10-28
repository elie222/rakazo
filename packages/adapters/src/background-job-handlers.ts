import type {
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  BackgroundJobExecution,
  BackgroundJobHandlers,
  JobPublisher,
  MessagingSurface,
  PaymentWalletProvider,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { settleCallRequest } from "./call-request.js";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import type { createRunExecutor } from "./executor.js";
import type { ExpoPushProvider } from "./expo-push.js";
import { compactHistory } from "./history-compaction.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import { pollPurchase } from "./purchase-poll.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

type Tenant = { spaceId: string; userId: string };

/**
 * A job that acts for one run, routine, computer, skill, thread, cloud agent or purchase runs
 * as that row's tenant, so row-level security keeps it, and every tool it runs, in
 * the owner's Space even where a query forgets to filter. The owner comes from one
 * narrow system read; when the row is gone there is nothing left to act on.
 */
function asOwner<Key, P extends Key>(
  owner: (payload: Key) => Promise<Tenant | null>,
  handler: (payload: P, execution?: BackgroundJobExecution) => Promise<void>,
): (payload: P, execution?: BackgroundJobExecution) => Promise<void> {
  return async (payload, execution) => {
    const tenant = await runAsSystem("find the tenant a background job acts for", () =>
      owner(payload),
    );
    if (tenant) await runAsTenant(tenant, () => handler(payload, execution));
  };
}

const OWNER = { spaceId: true, userId: true } as const;

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  artifacts: ArtifactStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: SecretStore;
  memoryProviders: MemoryProviderResolver;
  deploymentModelKey?: string;
  deploymentModelConfigured?: boolean;
  messaging?: MessagingSurface;
  cloudAgent?: CloudAgentConnection | null;
  paymentWallet?: PaymentWalletProvider | null;
  notifications?: ExpoPushProvider;
}): BackgroundJobHandlers {
  const messagingDeps = deps.messaging
    ? {
        prisma: deps.prisma,
        messaging: deps.messaging,
        events: deps.events,
        jobs: deps.jobs,
        artifacts: deps.artifacts,
      }
    : undefined;
  // The outbox holds every Space's pending sends, so draining it is cross-tenant.
  const drainMessaging = async () => {
    if (!messagingDeps) return;
    await runAsSystem("drain the messaging outbox across Spaces", () =>
      deliverMessagingOutbound(
        messagingDeps,
        {},
        {
          operationId: "messaging.deliver:drain",
          traceId: "messaging.deliver:drain",
          spaceId: "",
          userId: "",
          signal: new AbortController().signal,
        },
      ),
    );
  };
  const run = ({ runId }: { runId: string }) =>
    deps.prisma.run.findUnique({ where: { id: runId }, select: OWNER });
  const routine = ({ routineId }: { routineId: string }) =>
    deps.prisma.routine.findUnique({ where: { id: routineId }, select: OWNER });
  const computer = ({ computerId }: { computerId: string }) =>
    deps.prisma.computer.findUnique({ where: { id: computerId }, select: OWNER });
  const thread = ({ threadId }: { threadId: string }) =>
    deps.prisma.thread.findUnique({ where: { id: threadId }, select: OWNER });
  const skill = ({ skillId }: { skillId: string }) =>
    deps.prisma.taughtSkill.findUnique({ where: { id: skillId }, select: OWNER });
  const cloudAgent = ({ agentId }: { agentId: string }) =>
    deps.prisma.cloudAgent.findUnique({ where: { id: agentId }, select: OWNER });
  const purchase = ({ purchaseId }: { purchaseId: string }) =>
    deps.prisma.purchase.findUnique({ where: { id: purchaseId }, select: OWNER });
  const updatedComputer = async ({ updateId }: { updateId: string }) =>
    (
      await deps.prisma.computerUpdate.findUnique({
        where: { id: updateId },
        select: { computer: { select: OWNER } },
      })
    )?.computer ?? null;

  return {
    "run.continue": asOwner(run, async (payload, execution) => {
      if (execution)
        await deps.executor.continueRun(payload.runId, deps.workerId, execution.onRunStarted);
      else await deps.executor.continueRun(payload.runId, deps.workerId);
      // Automatic messaging mirror: once the run's bot messages are durable,
      // copy them into the outbox. Never let mirror failures fail the run.
      if (messagingDeps) {
        await mirrorMessagingOutbound(messagingDeps, payload.runId);
        await deps.jobs.enqueue(messagingDeliverJob()).catch(async (error) => {
          getLogger().error("messaging.deliver enqueue error", error);
          await drainMessaging();
        });
      }
    }),
    "messaging.credential-cleanup": async ({ installationId, ref }) => {
      await runAsSystem("clean up a retired messaging credential", async () => {
        const installation = await deps.prisma.messagingInstallation.findUnique({
          where: { id: installationId },
          select: { ciphertext: true },
        });
        if (installation?.ciphertext === ref) return;
        await deps.secretStore.delete(ref, {
          recordId: installationId,
          signal: AbortSignal.timeout(10_000),
        });
      });
    },
    "messaging.deliver": async ({ runId }) => {
      if (runId && messagingDeps) {
        await asOwner(run, () => mirrorMessagingOutbound(messagingDeps, runId))({ runId });
      }
      await drainMessaging();
    },
    "routine.wakeup": asOwner(routine, async (payload) => {
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    }),
    "routine.retry": asOwner(run, async (payload) => {
      await deps.executor.retryRoutineRun(payload.runId);
    }),
    "computer.update": asOwner(updatedComputer, async ({ updateId }) => {
      await performComputerUpdate(deps, updateId);
    }),
    "computer.sleep": asOwner(computer, async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId);
    }),
    "computer.control-expire": asOwner(computer, async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    }),
    "skill.teaching-expire": asOwner(skill, async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    }),
    "call.expire": asOwner(thread, async (payload) => {
      await settleCallRequest(deps, { ...payload, from: ["ringing"], status: "missed" });
    }),
    "cloud_agent.poll": asOwner(cloudAgent, async (payload) => {
      await pollCloudAgent(
        { prisma: deps.prisma, jobs: deps.jobs, events: deps.events, cloudAgent: deps.cloudAgent },
        payload,
      );
    }),
    "purchase.poll": asOwner(purchase, async (payload) => {
      await pollPurchase(
        {
          prisma: deps.prisma,
          secretStore: deps.secretStore,
          jobs: deps.jobs,
          paymentWallet: deps.paymentWallet,
        },
        payload,
      );
    }),
    // A receipt belongs to a device's push token, not to a Space.
    "push.receipt": async (payload) => {
      await runAsSystem("check a push receipt", () => deps.notifications?.checkReceipt(payload));
    },
    "history.compact": asOwner(thread, async (payload) => {
      // Retrieval policies use stored context without paid message-count compaction.
      // Skip legacy backlog work after a policy change.
      if (deps.executor.contextStrategy && deps.executor.contextStrategy !== "current") return;
      await compactHistory(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          jobs: deps.jobs,
          memoryProviders: deps.memoryProviders,
          deploymentModelKey: deps.deploymentModelKey,
          deploymentModelConfigured: deps.deploymentModelConfigured,
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
        },
        payload.threadId,
      );
    }),
  };
}
