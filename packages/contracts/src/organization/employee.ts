import * as z from "zod";
import { Id } from "../ids.js";

export const AutonomyLevelSchema = z.enum(["supervised", "standard", "autonomous"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const WorkModeSchema = z.enum(["supervised", "standard", "autonomous"]);
export type WorkMode = z.infer<typeof WorkModeSchema>;

export const EmployeeStatusSchema = z.enum([
  "offline",
  "idle",
  "evaluating",
  "planning",
  "working",
  "blocked",
  "waiting",
  "waiting_review",
  "reviewing",
  "waiting_approval",
  "sleeping",
  "error",
]);
export type EmployeeStatus = z.infer<typeof EmployeeStatusSchema>;

export const AuthorityPolicySchema = z.object({
  canCreateWorkItems: z.boolean().default(true),
  canAssignWork: z.boolean().default(false),
  canDelegate: z.boolean().default(false),
  canReview: z.boolean().default(false),
  canManageDepartment: z.boolean().default(false),
  canCreateProjects: z.boolean().default(false),
  canModifyProjects: z.boolean().default(false),
  canCreateGoals: z.boolean().default(false),
  canModifyGoals: z.boolean().default(false),
  canManageEmployees: z.boolean().default(false),
  canResolveEscalations: z.boolean().default(false),
  canTriggerDeployment: z.boolean().default(false),
  canSendExternalCommunication: z.boolean().default(false),
  canSpendMoney: z.boolean().default(false),
});
export type AuthorityPolicy = z.infer<typeof AuthorityPolicySchema>;

export const EmployeeProfileSchema = z.object({
  id: Id,
  workspaceId: Id,
  botId: Id,
  departmentId: Id.nullable(),
  reportsToBotId: Id.nullable(),
  role: z.string().min(1).max(80),
  mission: z.string().max(4000),
  responsibilities: z.array(z.string().max(500)),
  authority: AuthorityPolicySchema,
  autonomyLevel: AutonomyLevelSchema,
  workMode: WorkModeSchema,
  status: EmployeeStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  runtime: z
    .object({
      status: EmployeeStatusSchema,
      currentWorkItemId: Id.nullable(),
      lastActiveAt: z.string().nullable(),
      lastEvaluationAt: z.string().nullable(),
      nextWakeAt: z.string().nullable(),
      failureCount: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export type EmployeeProfile = z.infer<typeof EmployeeProfileSchema>;

export const CreateEmployeeProfileInput = z.object({
  botId: Id,
  departmentId: Id.nullable().optional(),
  reportsToBotId: Id.nullable().optional(),
  role: z.string().trim().min(1).max(80).default("employee"),
  mission: z.string().max(4000).default(""),
  responsibilities: z.array(z.string().max(500)).max(50).default([]),
  authority: AuthorityPolicySchema.partial().default({}),
  autonomyLevel: AutonomyLevelSchema.default("standard"),
  workMode: WorkModeSchema.default("standard"),
});
export type CreateEmployeeProfileInput = z.infer<typeof CreateEmployeeProfileInput>;

export const UpdateEmployeeProfileInput = z.object({
  botId: Id,
  departmentId: Id.nullable().optional(),
  reportsToBotId: Id.nullable().optional(),
  role: z.string().trim().min(1).max(80).optional(),
  mission: z.string().max(4000).optional(),
  responsibilities: z.array(z.string().max(500)).max(50).optional(),
  authority: AuthorityPolicySchema.partial().optional(),
  autonomyLevel: AutonomyLevelSchema.optional(),
  workMode: WorkModeSchema.optional(),
  status: EmployeeStatusSchema.optional(),
});
export type UpdateEmployeeProfileInput = z.infer<typeof UpdateEmployeeProfileInput>;

export const EmployeeRuntimeStateSchema = z.object({
  id: Id,
  workspaceId: Id,
  botId: Id,
  status: EmployeeStatusSchema,
  currentWorkItemId: Id.nullable(),
  lastActiveAt: z.string().nullable(),
  lastEvaluationAt: z.string().nullable(),
  nextWakeAt: z.string().nullable(),
  failureCount: z.number().int().nonnegative(),
  state: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EmployeeRuntimeState = z.infer<typeof EmployeeRuntimeStateSchema>;
