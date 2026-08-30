import * as z from "zod";
import { Id } from "../ids.js";
import { WorkItemPrioritySchema } from "./work-item.js";

const CreateWorkItemActionSchema = z.object({
  type: z.literal("create_work_item"),
  projectId: Id,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(8000),
  expectedOutcome: z.string().max(4000),
  assignedToBotId: Id.nullable(),
  reviewerBotId: Id.nullable(),
  priority: WorkItemPrioritySchema,
});

const AssignWorkItemActionSchema = z.object({
  type: z.literal("assign_work_item"),
  workItemId: Id,
  botId: Id,
});

const EscalateActionSchema = z.object({
  type: z.literal("escalate"),
  workItemId: Id.nullable(),
  reason: z.string().trim().min(1).max(4000),
});

export const ManagerDecisionSchema = z.object({
  summary: z.string().min(1).max(4000),
  actions: z
    .array(
      z.discriminatedUnion("type", [
        CreateWorkItemActionSchema,
        AssignWorkItemActionSchema,
        EscalateActionSchema,
      ]),
    )
    .min(1)
    .max(5),
});
export type ManagerDecision = z.infer<typeof ManagerDecisionSchema>;
