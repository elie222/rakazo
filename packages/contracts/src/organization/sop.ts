import * as z from "zod";
import { Id } from "../ids.js";

export const SopStepSchema = z.object({
  type: z.enum(["create_work", "assign", "review", "approval", "notify", "custom"]),
  role: z.string().max(80).optional(),
  assigneeBotId: Id.nullable().optional(),
  instruction: z.string().max(4000),
  requiresApproval: z.boolean().optional(),
});
export type SopStep = z.infer<typeof SopStepSchema>;

export const SopDefinitionSchema = z.object({
  trigger: z.string().min(1).max(200),
  conditions: z.array(z.record(z.string(), z.unknown())).default([]),
  steps: z.array(SopStepSchema).min(1).max(20),
});
export type SopDefinition = z.infer<typeof SopDefinitionSchema>;

export const SopSchema = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(4000),
  trigger: z.string().min(1).max(200),
  definition: SopDefinitionSchema,
  version: z.number().int().positive(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Sop = z.infer<typeof SopSchema>;

export const CreateSopInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(""),
  trigger: z.string().trim().min(1).max(200),
  definition: SopDefinitionSchema,
  active: z.boolean().default(true),
});
export type CreateSopInput = z.infer<typeof CreateSopInput>;

export const UpdateSopInput = z.object({
  sopId: Id,
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  trigger: z.string().trim().min(1).max(200).optional(),
  definition: SopDefinitionSchema.optional(),
  active: z.boolean().optional(),
});
export type UpdateSopInput = z.infer<typeof UpdateSopInput>;
