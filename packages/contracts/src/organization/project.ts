import * as z from "zod";
import { Id } from "../ids.js";

export const ProjectStatusSchema = z.enum(["planned", "active", "paused", "blocked", "completed", "cancelled"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.object({
  id: Id,
  workspaceId: Id,
  goalId: Id.nullable(),
  name: z.string().min(1).max(200),
  description: z.string().max(4000),
  ownerBotId: Id.nullable(),
  status: ProjectStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  goalId: Id.nullable().optional(),
  ownerBotId: Id.nullable().optional(),
  status: ProjectStatusSchema.default("planned"),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const UpdateProjectInput = z.object({
  projectId: Id,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  goalId: Id.nullable().optional(),
  ownerBotId: Id.nullable().optional(),
  status: ProjectStatusSchema.optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;
