import { z } from "zod";

export const ModelQuotaWindowSchema = z.object({
  id: z.string().min(1).max(128),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().datetime().nullable(),
  modelIds: z.array(z.string()).nullable(),
});
export type ModelQuotaWindow = z.infer<typeof ModelQuotaWindowSchema>;

export const ModelQuotaSchema = z.object({
  credentialId: z.string(),
  status: z.enum(["fresh", "stale", "unavailable", "unsupported"]),
  observedAt: z.string().datetime().nullable(),
  checkedAt: z.string().datetime(),
  windows: z.array(ModelQuotaWindowSchema),
});
export type ModelQuota = z.infer<typeof ModelQuotaSchema>;
