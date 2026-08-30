import * as z from "zod";
import { Id } from "../ids.js";

export const CompanyEventTypeSchema = z.enum([
  "goal.created",
  "goal.updated",
  "goal.achieved",
  "project.created",
  "project.blocked",
  "project.completed",
  "work.created",
  "work.assigned",
  "work.started",
  "work.blocked",
  "work.completed",
  "work.failed",
  "review.requested",
  "review.completed",
  "employee.wakeup",
  "employee.sleep",
  "employee.blocked",
  "approval.required",
  "escalation.created",
  "escalation.resolved",
  "company.health.warning",
  "sop.triggered",
]);
export type CompanyEventType = z.infer<typeof CompanyEventTypeSchema>;

// For DB storage allow any string but validate known types via union
export const CompanyEventSchema = z.object({
  id: Id,
  workspaceId: Id,
  type: z.string().min(1).max(100),
  actorBotId: Id.nullable(),
  workItemId: Id.nullable(),
  projectId: Id.nullable(),
  goalId: Id.nullable(),
  escalationId: Id.nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type CompanyEvent = z.infer<typeof CompanyEventSchema>;

export const CreateCompanyEventInput = z.object({
  type: z.string().min(1).max(100),
  actorBotId: Id.nullable().optional(),
  workItemId: Id.nullable().optional(),
  projectId: Id.nullable().optional(),
  goalId: Id.nullable().optional(),
  escalationId: Id.nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type CreateCompanyEventInput = z.infer<typeof CreateCompanyEventInput>;
