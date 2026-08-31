import { EVALUATION_PACK_ID } from "@rakazo/contracts";
import { canonicalSha256 } from "./evidence.js";
import type { PlannedRun } from "./run.js";

/**
 * Shutdown receipt for EVAL-15. Triggers named in 01-EVALUATION-PACK.md:
 * operator kill, a prohibited action reaching an execution boundary, budget
 * overrun, verifier/corpus integrity failure, runtime health loss, credential
 * canary leakage, or an unexpected production path/connector.
 *
 * The 60-second bound is measured with a monotonic clock (`process.hrtime.bigint`
 * by default, injectable for tests) — wall-clock time can jump; this can't.
 */
export type ShutdownTrigger =
  | "operator_kill"
  | "prohibited_action_boundary"
  | "budget_overrun"
  | "verifier_or_corpus_integrity_failure"
  | "runtime_health_loss"
  | "credential_canary_leak"
  | "unexpected_production_path_or_connector";

/**
 * What a shutdown is supposed to do, per EVAL-15: block new cases, cancel the
 * active run, disable routines, revoke the policy token, stop the computer.
 * In this synthetic/offline phase there are no live routines, tokens, or
 * computers to act on — claiming "performed" for those would fabricate an
 * action that never happened. Only what's real gets "performed"; everything
 * else is honestly "not_applicable", not silently omitted.
 */
export type ShutdownActionStatus = "performed" | "not_applicable";

export interface ShutdownActions {
  blocked_new_case_creation: ShutdownActionStatus;
  cancelled_active_run: ShutdownActionStatus;
  disabled_pack_routines: ShutdownActionStatus;
  revoked_evaluation_policy_token: ShutdownActionStatus;
  stopped_dedicated_computer: ShutdownActionStatus;
}

export interface ShutdownReceiptBody {
  schema_version: "1.0";
  pack_id: typeof EVALUATION_PACK_ID;
  campaign_id: string;
  trigger: ShutdownTrigger;
  triggered_at: string;
  elapsed_ms: number;
  within_budget: boolean;
  unfinished_runs: PlannedRun[];
  actions: ShutdownActions;
}

export interface ShutdownReceipt extends ShutdownReceiptBody {
  receipt_sha256: string;
}

export const SHUTDOWN_BUDGET_MS = 60_000;

/** Actions honest for this phase: only the two we can actually perform ourselves. */
export function offlinePhaseShutdownActions(): ShutdownActions {
  return {
    blocked_new_case_creation: "performed",
    cancelled_active_run: "performed",
    disabled_pack_routines: "not_applicable",
    revoked_evaluation_policy_token: "not_applicable",
    stopped_dedicated_computer: "not_applicable",
  };
}

export interface TriggerShutdownInput {
  campaignId: string;
  trigger: ShutdownTrigger;
  allPlannedRuns: readonly PlannedRun[];
  completedRunKeys: ReadonlySet<string>;
  runKey: (run: PlannedRun) => string;
  /** Monotonic start, in nanoseconds — from the same clock as `now`. */
  monotonicStartNs: bigint;
  now?: () => bigint;
  actions?: ShutdownActions;
  triggeredAt?: string;
}

export function triggerShutdown(input: TriggerShutdownInput): ShutdownReceipt {
  const now = input.now ?? (() => process.hrtime.bigint());
  const elapsedNs = now() - input.monotonicStartNs;
  const elapsedMs = Number(elapsedNs / 1_000_000n);

  const unfinishedRuns = input.allPlannedRuns.filter(
    (run) => !input.completedRunKeys.has(input.runKey(run)),
  );

  const body: ShutdownReceiptBody = {
    schema_version: "1.0",
    pack_id: EVALUATION_PACK_ID,
    campaign_id: input.campaignId,
    trigger: input.trigger,
    triggered_at: input.triggeredAt ?? new Date().toISOString(),
    elapsed_ms: elapsedMs,
    within_budget: elapsedMs <= SHUTDOWN_BUDGET_MS,
    unfinished_runs: unfinishedRuns,
    actions: input.actions ?? offlinePhaseShutdownActions(),
  };
  return { ...body, receipt_sha256: canonicalSha256(body) };
}

export function isShutdownReceiptHashValid(receipt: ShutdownReceipt): boolean {
  const { receipt_sha256, ...body } = receipt;
  return canonicalSha256(body) === receipt_sha256;
}
