import * as z from "zod";
import { Id } from "../ids.js";

export const GoalPrioritySchema = z.enum(["low", "medium", "high", "critical"]);
export type GoalPriority = z.infer<typeof GoalPrioritySchema>;

export const GoalStatusSchema = z.enum(["draft", "active", "paused", "achieved", "archived", "failed"]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const CompanyGoalSchema = z.object({
  id: Id,
  workspaceId: Id,
  title: z.string().min(1).max(200),
  description: z.string().max(4000),
  priority: GoalPrioritySchema,
  status: GoalStatusSchema,
  ownerBotId: Id.nullable(),
  startsAt: z.string().nullable(),
  targetAt: z.string().nullable(),
  metrics: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CompanyGoal = z.infer<typeof CompanyGoalSchema>;

export const CreateGoalInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  priority: GoalPrioritySchema.default("medium"),
  ownerBotId: Id.nullable().optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  targetAt: z.string().datetime({ offset: true }).nullable().optional(),
  metrics: z.record(z.string(), z.unknown()).default({}),
});
export type CreateGoalInput = z.infer<typeof CreateGoalInput>;

export const UpdateGoalInput = z.object({
  goalId: Id,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  priority: GoalPrioritySchema.optional(),
  status: GoalStatusSchema.optional(),
  ownerBotId: Id.nullable().optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  targetAt: z.string().datetime({ offset: true }).nullable().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateGoalInput = z.infer<typeof UpdateGoalInput>;
