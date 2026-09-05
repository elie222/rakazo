import * as z from "zod";

export const WorkforceWorker = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  available: z.boolean(),
});
export const WorkforceReport = z.object({
  dispatchId: z.string().min(1).max(200),
  runId: z.string().max(100).optional(),
  status: z.enum([
    "queued",
    "running",
    "waiting_input",
    "waiting_takeover",
    "completed",
    "failed",
    "cancelled",
  ]),
  summary: z.string().max(4000).optional(),
});
export const WorkforceSync = z.object({
  installationId: z.string().min(1).max(100),
  enabled: z.boolean(),
  workers: z.array(WorkforceWorker).max(8),
  reports: z.array(WorkforceReport).max(100),
});
export const WorkforceAssignment = z.object({
  dispatchId: z.string(),
  seq: z.number().int().positive(),
  workerId: z.string(),
  title: z.string(),
  brief: z.string(),
  status: z.enum(["claimed", "done", "cancelled"]),
  executionStatus: z.string().optional(),
});
export const WorkforceSyncResult = z.object({
  protocol: z.literal(1),
  company: z.object({ name: z.string(), slug: z.string() }),
  assignments: z.array(WorkforceAssignment),
  acknowledged: z.array(z.string()),
});
export const WorkforceConfigure = z.object({
  endpoint: z.string().url(),
  key: z.string().min(10).max(4096).optional(),
  enabled: z.boolean(),
  workers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        instructions: z.string().max(8000),
        model: z
          .string()
          .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/-]+$/)
          .max(200),
      }),
    )
    .min(1)
    .max(8),
});
