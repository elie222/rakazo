import type { AgentUsage } from "@rakazo/adapter-kit";
import { z } from "zod";

const id = z.string().trim().min(1).max(512);
const rate = z.number().finite().nonnegative();
const price = z
  .strictObject({
    input: rate,
    output: rate,
    cacheRead: rate,
    cacheWrite: rate,
  })
  .refine((value) => value.input > 0, "Input price must be positive");
const offering = z.strictObject({
  id,
  connectionId: id,
  provider: id,
  modelId: id,
  price,
});
const configuration = z
  .strictObject({
    defaultOfferingId: id.nullable(),
    offerings: z.array(offering).max(200),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    const models = new Set<string>();
    for (const entry of value.offerings) {
      const model = JSON.stringify([entry.provider, entry.modelId]);
      if (ids.has(entry.id) || models.has(model))
        ctx.addIssue({ code: "custom", message: "Duplicate offering or provider/model" });
      ids.add(entry.id);
      models.add(model);
    }
    if (
      (value.defaultOfferingId === null && value.offerings.length > 0) ||
      (value.defaultOfferingId !== null && !ids.has(value.defaultOfferingId))
    )
      ctx.addIssue({ code: "custom", message: "Default offering must be approved" });
  });
export type ModelCreditOffering = z.infer<typeof offering>;

let cached: { raw: string; value: z.infer<typeof configuration> } | undefined;

/** Deployment-owned allowlist. Never include key material or endpoints in this JSON. */
export function modelCreditOfferings(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.MODEL_CREDIT_OFFERINGS;
  if (raw === undefined) return undefined;
  if (cached?.raw === raw) return cached.value;
  try {
    const value = configuration.parse(JSON.parse(raw));
    cached = { raw, value };
    return value;
  } catch {
    // Configuration errors must not echo input, which could contain misplaced secrets.
    throw new Error("Invalid MODEL_CREDIT_OFFERINGS configuration");
  }
}

export function approvedModelCreditOffering(provider: string, modelId: string) {
  return modelCreditOfferings()?.offerings.find(
    (entry) => entry.provider === provider && entry.modelId === modelId,
  );
}

/** Price measured buckets at the snapshotted customer tariff, never the upstream bill. */
export function offeringUsage(
  entry: ModelCreditOffering,
  usage: AgentUsage | null,
): AgentUsage | null {
  if (!usage) return null;
  const buckets = [
    [usage.inputTokens, entry.price.input],
    [usage.outputTokens, entry.price.output],
    [usage.cacheReadTokens, entry.price.cacheRead],
    [usage.cacheWriteTokens, entry.price.cacheWrite],
  ] as const;
  const known = buckets.every(
    ([count, rate]) =>
      rate === 0 || (typeof count === "number" && Number.isSafeInteger(count) && count >= 0),
  );
  const rejected =
    usage.costSource === "provider-rejection" ||
    usage.usageSource === "not-started" ||
    usage.usageSource === "provider-rejected";
  const cost = known
    ? buckets.reduce((sum, [count, rate]) => sum + (rate === 0 ? 0 : count! * rate), 0) / 1_000_000
    : null;
  return {
    ...usage,
    costUsd: rejected ? 0 : cost,
    costSource: rejected ? "provider-rejection" : known ? "deployment-tariff" : null,
    pricingVersion: `deployment-tariff:${entry.id}`,
    pricingSnapshot: {
      ...entry.price,
      creditOfferingId: entry.id,
      connectionId: entry.connectionId,
    },
  };
}
