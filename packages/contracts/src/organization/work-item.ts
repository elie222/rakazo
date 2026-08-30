import * as z from "zod";
import { Id } from "../ids.js";

export const WorkItemStatusSchema = z.enum([
  "backlog",
  "ready",
  "assigned",
  "planning",
  "in_progress",
  "blocked",
  "waiting_review",
  "reviewing",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkItemPrioritySchema = z.enum(["low", "medium", "high", "critical", "urgent"]);
export type WorkItemPriority = z.infer<typeof WorkItemPrioritySchema>;

export const WorkItemSourceSchema = z.enum(["manual", "goal", "project", "sop", "delegation", "escalation", "auto"]);
export type WorkItemSource = z.infer<typeof WorkItemSourceSchema>;

export const WorkItemSchema = z.object({
  id: Id,
  workspaceId: Id,
  projectId: Id.nullable(),
  parentWorkItemId: Id.nullable(),
  title: z.string().min(1).max(300),
  description: z.string().max(8000),
  status: WorkItemStatusSchema,
  priority: WorkItemPrioritySchema,
  createdByBotId: Id.nullable(),
  assignedToBotId: Id.nullable(),
  reviewerBotId: Id.nullable(),
  source: WorkItemSourceSchema,
  expectedOutcome: z.string().max(4000),
  required: z.boolean(),
  dueAt: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const CreateWorkItemInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(8000).default(""),
  projectId: Id.nullable().optional(),
  parentWorkItemId: Id.nullable().optional(),
  priority: WorkItemPrioritySchema.default("medium"),
  assignedToBotId: Id.nullable().optional(),
  reviewerBotId: Id.nullable().optional(),
  source: WorkItemSourceSchema.default("manual"),
  expectedOutcome: z.string().max(4000).default(""),
  required: z.boolean().default(true),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  idempotencyKey: z.string().max(200).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateWorkItemInput = z.infer<typeof CreateWorkItemInput>;

export const UpdateWorkItemInput = z.object({
  workItemId: Id,
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(8000).optional(),
  priority: WorkItemPrioritySchema.optional(),
  status: WorkItemStatusSchema.optional(),
  assignedToBotId: Id.nullable().optional(),
  reviewerBotId: Id.nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  expectedOutcome: z.string().max(4000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateWorkItemInput = z.infer<typeof UpdateWorkItemInput>;

export const WorkItemTransitionInput = z.object({
  workItemId: Id,
  toStatus: WorkItemStatusSchema,
  reason: z.string().max(1000).optional(),
});
export type WorkItemTransitionInput = z.infer<typeof WorkItemTransitionInput>;

export const WorkItemFilterSchema = z.object({
  projectId: Id.optional(),
  assignedToBotId: Id.optional(),
  status: WorkItemStatusSchema.optional(),
  priority: WorkItemPrioritySchema.optional(),
  parentWorkItemId: Id.nullable().optional(),
});
export type WorkItemFilter = z.infer<typeof WorkItemFilterSchema>;
