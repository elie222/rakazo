import type { EvalPricing, MeasuredCall } from "./measurement.js";
import { measureCalls } from "./measurement.js";

/** Internal ledger identifiers are used for attribution and never returned in reports. */
export type LedgerCall = MeasuredCall & {
  runId?: string | null;
  parentRunId?: string | null;
};

export function measureWorkflowSteps(
  calls: readonly LedgerCall[],
  runSteps: ReadonlyMap<string, number>,
  pricing?: EvalPricing,
  minimumCacheTokens?: number,
) {
  const unique = [...new Map(calls.map((call) => [call.id, call])).values()];
  const steps = new Map<number, LedgerCall[]>(
    [...new Set(runSteps.values())].sort((a, b) => a - b).map((step) => [step, []]),
  );
  const compaction: LedgerCall[] = [];
  const unattributed: LedgerCall[] = [];
  for (const call of unique) {
    if (call.operation === "compaction") {
      compaction.push(call);
      continue;
    }
    const step =
      (call.runId ? runSteps.get(call.runId) : undefined) ??
      (call.parentRunId ? runSteps.get(call.parentRunId) : undefined);
    if (step === undefined) unattributed.push(call);
    else steps.get(step)!.push(call);
  }
  const measure = (bucket: LedgerCall[]) => measureCalls(bucket, pricing, minimumCacheTokens);
  const foreground = [...steps].map(([step, bucket]) => ({ step, ...measure(bucket) }));
  const background = { compaction: measure(compaction), unattributed: measure(unattributed) };
  const workflow = measure(unique);
  const buckets = [...foreground, background.compaction, background.unattributed];
  const populated = buckets.filter((bucket) => bucket.modelCalls > 0);
  const partitionCost = populated.every((bucket) => bucket.costUsd !== null)
    ? populated.reduce((total, bucket) => total + bucket.costUsd!, 0)
    : null;
  return {
    attribution: "final-ledger-run-attribution" as const,
    steps: foreground,
    background,
    reconciliation: {
      modelCalls: buckets.reduce((total, bucket) => total + bucket.modelCalls, 0),
      workflowModelCalls: workflow.modelCalls,
      allCallsAccounted:
        buckets.reduce((total, bucket) => total + bucket.modelCalls, 0) === workflow.modelCalls,
      partitionCostUsd: populated.length ? partitionCost : null,
      workflowCostUsd: workflow.costUsd,
      tokenMatches: Object.fromEntries(
        (
          [
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "cacheWrite1hTokens",
            "reasoningTokens",
            "totalTokens",
          ] as const
        ).map((key) => {
          const known = populated.length > 0 && populated.every((bucket) => bucket[key] !== null);
          return [
            key,
            !known || workflow[key] === null
              ? null
              : populated.reduce((total, bucket) => total + bucket[key]!, 0) === workflow[key],
          ];
        }),
      ),
      costMatches:
        partitionCost === null || workflow.costUsd === null
          ? null
          : Math.abs(partitionCost - workflow.costUsd) < 1e-12,
    },
  };
}
