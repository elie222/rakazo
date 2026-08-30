import * as z from "zod";

export const ResourceLimitsSchema = z.object({
  maxConcurrentEmployees: z.number().int().min(1).max(100).default(10),
  maxEmployeeExecutions: z.number().int().min(1).max(100).default(5),
  minWakeIntervalMs: z.number().int().min(1000).max(3600000).default(30000),
  maxWorkItemsPerEvaluation: z.number().int().min(1).max(50).default(5),
  maxDelegationDepth: z.number().int().min(1).max(10).default(3),
  maxDecompositionDepth: z.number().int().min(1).max(10).default(3),
  maxChildWorkItems: z.number().int().min(1).max(100).default(20),
  maxRetries: z.number().int().min(0).max(10).default(3),
});
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

export const CompanyHealthSchema = z.object({
  stalledProjects: z.array(z.string()),
  blockedProjects: z.array(z.string()),
  overloadedEmployees: z.array(z.string()),
  idleEmployees: z.array(z.string()),
  excessiveFailures: z.array(z.string()),
  reviewBottlenecks: z.array(z.string()),
  goalsWithoutProjects: z.array(z.string()),
  projectsWithoutWork: z.array(z.string()),
  unresolvedEscalations: z.array(z.string()),
  approvalBottlenecks: z.array(z.string()),
  evaluatedAt: z.string(),
});
export type CompanyHealth = z.infer<typeof CompanyHealthSchema>;
