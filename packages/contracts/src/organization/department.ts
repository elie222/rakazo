import * as z from "zod";
import { Id } from "../ids.js";

export const DepartmentSchema = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string().min(1).max(80),
  description: z.string().max(2000),
  parentDepartmentId: Id.nullable(),
  managerBotId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Department = z.infer<typeof DepartmentSchema>;

export const CreateDepartmentInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).default(""),
  parentDepartmentId: Id.nullable().optional(),
  managerBotId: Id.nullable().optional(),
});
export type CreateDepartmentInput = z.infer<typeof CreateDepartmentInput>;

export const UpdateDepartmentInput = z.object({
  departmentId: Id,
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(2000).optional(),
  parentDepartmentId: Id.nullable().optional(),
  managerBotId: Id.nullable().optional(),
});
export type UpdateDepartmentInput = z.infer<typeof UpdateDepartmentInput>;

export const DepartmentListFilter = z.object({
  parentDepartmentId: Id.nullable().optional(),
});
export type DepartmentListFilter = z.infer<typeof DepartmentListFilter>;
