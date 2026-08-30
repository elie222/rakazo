import { z } from "zod";
import type {
  BackgroundJob,
  BackgroundJobHandlers,
  BackgroundJobName,
  BackgroundJobPayloads,
} from "./types.js";

const payloadSchemas = {
  "run.continue": z.object({ runId: z.string().min(1) }),
  "routine.wakeup": z.object({
    routineId: z.string().min(1),
    scheduledFor: z.string().datetime({ offset: true }),
  }),
  "computer.sleep": z.object({ computerId: z.string().min(1) }),
  "computer.control-expire": z.object({
    computerId: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  "skill.teaching-expire": z.object({ skillId: z.string().min(1) }),
  "history.compact": z.object({ threadId: z.string().min(1) }),
  "organization.tick": z.object({ workspaceId: z.string().min(1) }),
  "employee.wakeup": z.object({
    workspaceId: z.string().min(1),
    botId: z.string().min(1),
    reason: z.string().max(200).optional(),
  }),
  "employee.evaluate": z.object({ workspaceId: z.string().min(1), botId: z.string().min(1) }),
  "manager.evaluate": z.object({ workspaceId: z.string().min(1), managerBotId: z.string().min(1) }),
  "executive.evaluate": z.object({ workspaceId: z.string().min(1), executiveBotId: z.string().min(1) }),
  "goal.evaluate": z.object({ workspaceId: z.string().min(1), goalId: z.string().min(1) }),
  "project.evaluate": z.object({ workspaceId: z.string().min(1), projectId: z.string().min(1) }),
  "workitem.dispatch": z.object({ workspaceId: z.string().min(1), workItemId: z.string().min(1) }),
  "workitem.review": z.object({ workspaceId: z.string().min(1), reviewId: z.string().min(1) }),
  "sop.trigger": z.object({
    workspaceId: z.string().min(1),
    sopId: z.string().min(1),
    triggerPayload: z.record(z.string(), z.unknown()).optional(),
  }),
  "company.health.evaluate": z.object({ workspaceId: z.string().min(1) }),
  "phone.deliver": z.object({ runId: z.string().min(1).optional() }),
} satisfies { [Name in BackgroundJobName]: z.ZodType<BackgroundJobPayloads[Name]> };

export function parseBackgroundJob(name: string, payload: unknown): BackgroundJob {
  if (!(name in payloadSchemas)) throw new Error(`Unknown background job: ${name}`);
  const typedName = name as BackgroundJobName;
  const parsed = payloadSchemas[typedName].parse(payload);
  return { name: typedName, payload: parsed } as BackgroundJob;
}

export async function dispatchBackgroundJob(
  handlers: BackgroundJobHandlers,
  name: string,
  payload: unknown,
): Promise<void> {
  const job = parseBackgroundJob(name, payload);
  const handler = handlers[job.name] as (payload: typeof job.payload) => Promise<void>;
  await handler(job.payload);
}

export function runJobKey(runId: string): string {
  return `run:${runId}`;
}

export function routineJobKey(routineId: string): string {
  return `routine:${routineId}`;
}

export function computerSleepJobKey(computerId: string): string {
  return `computer.sleep:${computerId}`;
}

export function computerControlExpireJobKey(computerId: string, leaseId?: string): string {
  return leaseId
    ? `computer.control-expire:${computerId}:${leaseId}`
    : `computer.control-expire:${computerId}`;
}

export function skillTeachingExpireJobKey(skillId: string): string {
  return `skill.teaching-expire:${skillId}`;
}

export function runContinueJob(runId: string): BackgroundJob {
  return {
    name: "run.continue",
    payload: { runId },
    replaceKey: runJobKey(runId),
  };
}

export function routineWakeupJob(routineId: string, scheduledFor: Date): BackgroundJob {
  return {
    name: "routine.wakeup",
    payload: { routineId, scheduledFor: scheduledFor.toISOString() },
    availableAt: scheduledFor,
    replaceKey: routineJobKey(routineId),
  };
}

export function computerSleepJob(computerId: string, availableAt: Date): BackgroundJob {
  return {
    name: "computer.sleep",
    payload: { computerId },
    availableAt,
    replaceKey: computerSleepJobKey(computerId),
  };
}

export function computerControlExpireJob(
  computerId: string,
  leaseId: string,
  availableAt: Date,
): BackgroundJob {
  return {
    name: "computer.control-expire",
    payload: { computerId, leaseId },
    availableAt,
    replaceKey: computerControlExpireJobKey(computerId, leaseId),
  };
}

export function skillTeachingExpireJob(skillId: string, availableAt: Date): BackgroundJob {
  return {
    name: "skill.teaching-expire",
    payload: { skillId },
    availableAt,
    replaceKey: skillTeachingExpireJobKey(skillId),
  };
}

export function historyCompactJobKey(threadId: string): string {
  return `history.compact:${threadId}`;
}

export function phoneDeliverJob(runId?: string, availableAt?: Date): BackgroundJob {
  return {
    name: "phone.deliver",
    payload: runId ? { runId } : {},
    replaceKey: `phone.deliver:${runId ?? "drain"}`,
    ...(availableAt ? { availableAt } : {}),
  };
}

export function historyCompactJob(threadId: string): BackgroundJob {
  return {
    name: "history.compact",
    payload: { threadId },
    replaceKey: historyCompactJobKey(threadId),
  };
}

export function orgJobKey(name: string, id: string): string {
  return `${name}:${id}`;
}

export function employeeWakeupJob(workspaceId: string, botId: string, reason?: string, availableAt?: Date): BackgroundJob {
  return {
    name: "employee.wakeup",
    payload: { workspaceId, botId, reason },
    replaceKey: orgJobKey("employee.wakeup", botId),
    ...(availableAt ? { availableAt } : {}),
  };
}

export function organizationTickJob(workspaceId: string): BackgroundJob {
  return { name: "organization.tick", payload: { workspaceId }, replaceKey: orgJobKey("organization.tick", workspaceId) };
}

export function workItemDispatchJob(workspaceId: string, workItemId: string): BackgroundJob {
  return { name: "workitem.dispatch", payload: { workspaceId, workItemId }, replaceKey: orgJobKey("workitem.dispatch", workItemId) };
}

export function workItemReviewJob(workspaceId: string, reviewId: string): BackgroundJob {
  return { name: "workitem.review", payload: { workspaceId, reviewId }, replaceKey: orgJobKey("workitem.review", reviewId) };
}

export function projectEvaluateJob(workspaceId: string, projectId: string): BackgroundJob {
  return { name: "project.evaluate", payload: { workspaceId, projectId }, replaceKey: orgJobKey("project.evaluate", projectId) };
}

export function goalEvaluateJob(workspaceId: string, goalId: string): BackgroundJob {
  return { name: "goal.evaluate", payload: { workspaceId, goalId }, replaceKey: orgJobKey("goal.evaluate", goalId) };
}

export function managerEvaluateJob(workspaceId: string, managerBotId: string, availableAt?: Date): BackgroundJob {
  return {
    name: "manager.evaluate",
    payload: { workspaceId, managerBotId },
    replaceKey: orgJobKey("manager.evaluate", managerBotId),
    ...(availableAt ? { availableAt } : {}),
  };
}
