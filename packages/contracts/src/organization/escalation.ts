import * as z from "zod";
import { Id } from "../ids.js";

export const EscalationSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type EscalationSeverity = z.infer<typeof EscalationSeveritySchema>;

export const EscalationStatusSchema = z.enum(["open", "acknowledged", "resolved", "cancelled"]);
export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;

export const EscalationSchema = z.object({
  id: Id,
  workspaceId: Id,
  sourceBotId: Id,
  targetBotId: Id.nullable(),
  workItemId: Id.nullable(),
  reason: z.string().min(1).max(4000),
  severity: EscalationSeveritySchema,
  status: EscalationStatusSchema,
  context: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

export const CreateEscalationInput = z.object({
  sourceBotId: Id,
  targetBotId: Id.nullable().optional(),
  workItemId: Id.nullable().optional(),
  reason: z.string().trim().min(1).max(4000),
  severity: EscalationSeveritySchema.default("medium"),
  context: z.record(z.string(), z.unknown()).default({}),
});
export type CreateEscalationInput = z.infer<typeof CreateEscalationInput>;

export const ResolveEscalationInput = z.object({
  escalationId: Id,
  status: z.enum(["resolved", "cancelled"]).default("resolved"),
});
export type ResolveEscalationInput = z.infer<typeof ResolveEscalationInput>;
