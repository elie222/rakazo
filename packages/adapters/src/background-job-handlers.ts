import { randomUUID } from "node:crypto";
import type {
  AgentHomeStore,
  AgentRuntime,
  BackgroundJobHandlers,
  JobPublisher,
  MessagingProvider,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { phoneDeliverJob, workItemDispatchJob } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { acquireEmployeeEvaluationLease, releaseEmployeeEvaluationLease } from "@rakazo/organization";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import type { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import type { OrganizationExecutionBridge } from "./organization-execution-bridge.js";
import type { OrganizationManagerRuntime } from "./organization-manager-runtime.js";
import type { createOrganizationProgressEvaluator } from "./organization-progress-evaluator.js";
import { deliverPhoneOutbound } from "./phone-delivery.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: EncryptedSecretStore;
  memoryProviders: MemoryProviderResolver;
  deploymentModelKey?: string;
  organizationBridge?: OrganizationExecutionBridge;
  managerRuntime?: OrganizationManagerRuntime;
  progressEvaluator?: ReturnType<typeof createOrganizationProgressEvaluator>;
  messaging?: MessagingProvider;
}): BackgroundJobHandlers {
  return {
    "run.continue": async (payload) => {
      await deps.executor.continueRun(payload.runId, deps.workerId);
      // Automatic phone mirror: once the run's bot messages are durable,
      // copy them into the outbox. Never let mirror failures fail the run.
      if (deps.messaging) {
        await deps.jobs.enqueue(phoneDeliverJob(payload.runId)).catch((error) => {
          console.error("phone.deliver enqueue error", error);
        });
      }
    },
    "phone.deliver": async (payload) => {
      if (!deps.messaging) return;
      await deliverPhoneOutbound(
        { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
        payload,
        {
          operationId: `phone.deliver:${payload.runId ?? "drain"}`,
          traceId: `phone.deliver:${payload.runId ?? "drain"}`,
          workspaceId: "",
          userId: "",
          signal: new AbortController().signal,
        },
      );
    },
    "routine.wakeup": async (payload) => {
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    },
    "computer.sleep": async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId);
    },
    "computer.control-expire": async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    },
    "skill.teaching-expire": async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    },
    "history.compact": async (payload) => {
      await compactHistory(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          jobs: deps.jobs,
          memoryProviders: deps.memoryProviders,
          deploymentModelKey: deps.deploymentModelKey,
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
        },
        payload.threadId,
      );
    },
    "organization.tick": async () => undefined,
    "employee.wakeup": async (payload) => {
      const now = new Date();
      const lease = await acquireEmployeeEvaluationLease(deps.prisma, {
        workspaceId: payload.workspaceId,
        botId: payload.botId,
        owner: `${deps.workerId}:${randomUUID()}`,
        now,
      });
      if (!lease) return;
      const workItem = await deps.prisma.workItem.findFirst({
        where: {
          workspaceId: payload.workspaceId,
          assignedToBotId: payload.botId,
          status: { in: ["ready", "assigned", "planning", "in_progress"] },
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        select: { id: true },
      });
      if (workItem) {
        await deps.prisma.workItem.updateMany({
          where: { id: workItem.id, workspaceId: payload.workspaceId, status: "ready" },
          data: { status: "assigned" },
        });
        await deps.jobs.enqueue(workItemDispatchJob(payload.workspaceId, workItem.id));
      }
      await releaseEmployeeEvaluationLease(deps.prisma, {
        workspaceId: payload.workspaceId,
        botId: payload.botId,
        lease,
        status: workItem ? "working" : "sleeping",
        nextWakeAt: workItem ? null : new Date(now.getTime() + 30_000),
      });
    },
    "employee.evaluate": async () => undefined,
    "manager.evaluate": async (payload) => {
      await deps.managerRuntime?.dispatch(payload);
    },
    "executive.evaluate": async () => undefined,
    "goal.evaluate": async (payload) => {
      await deps.progressEvaluator?.evaluateGoal(payload);
    },
    "project.evaluate": async (payload) => {
      await deps.progressEvaluator?.evaluateProject(payload);
    },
    "workitem.dispatch": async (payload) => {
      await deps.organizationBridge?.dispatch(payload);
    },
    "workitem.review": async (payload) => {
      await deps.organizationBridge?.dispatchReview(payload);
    },
    "sop.trigger": async () => undefined,
    "company.health.evaluate": async () => undefined,
  };
}
