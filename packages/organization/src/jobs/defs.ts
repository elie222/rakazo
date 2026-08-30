/**
 * Organization background jobs — extend adapter-kit BackgroundJobPayloads.
 * Keep job keys stable for idempotency.
 */

export const ORG_JOB_NAMES = [
  "organization.tick",
  "employee.wakeup",
  "employee.evaluate",
  "manager.evaluate",
  "executive.evaluate",
  "goal.evaluate",
  "project.evaluate",
  "workitem.dispatch",
  "workitem.review",
  "sop.trigger",
  "company.health.evaluate",
] as const;

export type OrgJobName = (typeof ORG_JOB_NAMES)[number];

export interface OrgJobPayloads {
  "organization.tick": { workspaceId: string };
  "employee.wakeup": { workspaceId: string; botId: string; reason?: string };
  "employee.evaluate": { workspaceId: string; botId: string };
  "manager.evaluate": { workspaceId: string; managerBotId: string };
  "executive.evaluate": { workspaceId: string; executiveBotId: string };
  "goal.evaluate": { workspaceId: string; goalId: string };
  "project.evaluate": { workspaceId: string; projectId: string };
  "workitem.dispatch": { workspaceId: string; workItemId: string };
  "workitem.review": { workspaceId: string; reviewId: string };
  "sop.trigger": { workspaceId: string; sopId: string; triggerPayload?: Record<string, unknown> };
  "company.health.evaluate": { workspaceId: string };
}

export function orgJobKey(name: OrgJobName, id: string): string {
  return `${name}:${id}`;
}

export function employeeWakeupJob(workspaceId: string, botId: string, reason?: string) {
  return {
    name: "employee.wakeup" as const,
    payload: { workspaceId, botId, reason },
    replaceKey: orgJobKey("employee.wakeup", botId),
  };
}
export function managerEvaluateJob(workspaceId: string, managerBotId: string) {
  return {
    name: "manager.evaluate" as const,
    payload: { workspaceId, managerBotId },
    replaceKey: orgJobKey("manager.evaluate", managerBotId),
  };
}
