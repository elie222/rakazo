import { z } from "zod";

export const ModelQuotaWindowSchema = z.object({
  id: z.string().min(1).max(128),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().datetime().nullable(),
  modelIds: z.array(z.string()).nullable(),
  /** Provider-supplied name for a window scoped to particular models. */
  label: z.string().min(1).max(128).nullable().optional(),
});
export type ModelQuotaWindow = z.infer<typeof ModelQuotaWindowSchema>;

/** Prepaid money left on the account, separate from any percentage window. */
export const ModelQuotaBalanceSchema = z.object({
  remaining: z.number().min(0),
  currency: z.literal("USD"),
});
export type ModelQuotaBalance = z.infer<typeof ModelQuotaBalanceSchema>;

export const ModelQuotaSchema = z.object({
  credentialId: z.string(),
  status: z.enum(["fresh", "stale", "unavailable", "unsupported"]),
  observedAt: z.string().datetime().nullable(),
  checkedAt: z.string().datetime(),
  windows: z.array(ModelQuotaWindowSchema),
  balance: ModelQuotaBalanceSchema.nullable().optional(),
});
export type ModelQuota = z.infer<typeof ModelQuotaSchema>;
