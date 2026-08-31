import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packetFileName } from "./evidence.js";
import { ITERATIONS, planCampaign, runCampaign } from "./run.js";
import {
  isShutdownReceiptHashValid,
  offlinePhaseShutdownActions,
  SHUTDOWN_BUDGET_MS,
  type ShutdownTrigger,
  triggerShutdown,
} from "./shutdown.js";

/** EVAL-15 fault injection: each named trigger stops the run and seals a receipt
 * within (or provably outside) the 60-second monotonic budget, naming every
 * case/iteration that never ran. */

const ALL_TRIGGERS: ShutdownTrigger[] = [
  "operator_kill",
  "prohibited_action_boundary",
  "budget_overrun",
  "verifier_or_corpus_integrity_failure",
  "runtime_health_loss",
  "credential_canary_leak",
  "unexpected_production_path_or_connector",
];

describe("shutdown receipt — timing", () => {
  it.each(ALL_TRIGGERS)("seals a valid receipt for trigger '%s'", (trigger) => {
    const plan = planCampaign(ITERATIONS);
    const completed = new Set(
      plan.slice(0, 10).map((run) => packetFileName(run.case_id, run.iteration)),
    );
    const startNs = 0n;
    const receipt = triggerShutdown({
      campaignId: "shutdown-test",
      trigger,
      allPlannedRuns: plan,
      completedRunKeys: completed,
      runKey: (run) => packetFileName(run.case_id, run.iteration),
      monotonicStartNs: startNs,
      now: () => 5_000_000_000n, // 5s elapsed
    });
    expect(receipt.trigger).toBe(trigger);
    expect(receipt.elapsed_ms).toBe(5000);
    expect(receipt.within_budget).toBe(true);
    expect(receipt.unfinished_runs).toHaveLength(50);
    expect(isShutdownReceiptHashValid(receipt)).toBe(true);
  });

  it("passes at exactly 60,000ms", () => {
    const plan = planCampaign(ITERATIONS);
    const receipt = triggerShutdown({
      campaignId: "boundary-test",
      trigger: "operator_kill",
      allPlannedRuns: plan,
      completedRunKeys: new Set(),
      runKey: (run) => packetFileName(run.case_id, run.iteration),
      monotonicStartNs: 0n,
      now: () => BigInt(SHUTDOWN_BUDGET_MS) * 1_000_000n,
    });
    expect(receipt.elapsed_ms).toBe(SHUTDOWN_BUDGET_MS);
    expect(receipt.within_budget).toBe(true);
  });

  it("fails at 60,001ms", () => {
    const plan = planCampaign(ITERATIONS);
    const receipt = triggerShutdown({
      campaignId: "boundary-test",
      trigger: "operator_kill",
      allPlannedRuns: plan,
      completedRunKeys: new Set(),
      runKey: (run) => packetFileName(run.case_id, run.iteration),
      monotonicStartNs: 0n,
      now: () => BigInt(SHUTDOWN_BUDGET_MS + 1) * 1_000_000n,
    });
    expect(receipt.elapsed_ms).toBe(SHUTDOWN_BUDGET_MS + 1);
    expect(receipt.within_budget).toBe(false);
  });

  it("names every unfinished run and none that already completed", () => {
    const plan = planCampaign(ITERATIONS);
    const completedRuns = plan.slice(0, 37);
    const completed = new Set(
      completedRuns.map((run) => packetFileName(run.case_id, run.iteration)),
    );
    const receipt = triggerShutdown({
      campaignId: "unfinished-test",
      trigger: "budget_overrun",
      allPlannedRuns: plan,
      completedRunKeys: completed,
      runKey: (run) => packetFileName(run.case_id, run.iteration),
      monotonicStartNs: 0n,
      now: () => 1_000_000n,
    });
    expect(receipt.unfinished_runs).toHaveLength(plan.length - 37);
    for (const run of receipt.unfinished_runs) {
      expect(completed.has(packetFileName(run.case_id, run.iteration))).toBe(false);
    }
  });

  it("only claims actions this offline phase can actually perform", () => {
    const actions = offlinePhaseShutdownActions();
    expect(actions.blocked_new_case_creation).toBe("performed");
    expect(actions.cancelled_active_run).toBe("performed");
    // No live routine, policy-token session, or computer exists in this phase —
    // claiming these were "stopped" or "revoked" would fabricate an action that
    // never happened, exactly the failure mode this pack exists to prevent.
    expect(actions.disabled_pack_routines).toBe("not_applicable");
    expect(actions.revoked_evaluation_policy_token).toBe("not_applicable");
    expect(actions.stopped_dedicated_computer).toBe("not_applicable");
  });
});

describe("shutdown — integration with the campaign runner", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  it("stops the runner at the trigger point and no packet is written after it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "liqr-shutdown-"));
    tempDirs.push(dir);

    let calls = 0;
    const result = await runCampaign({
      campaignId: "halted-campaign",
      runtime: "scripted",
      sandbox: "fake",
      iterations: ITERATIONS,
      outputDir: dir,
      candidateRevision: "test-fixture-revision",
      shutdownCheck: () => {
        calls += 1;
        return calls > 20 ? "synthetic-operator-kill" : null;
      },
    });

    expect(result.shutdown.triggered).toBe(true);
    expect(result.completedRuns).toBe(20);

    const packetsOnDisk = readdirSync(path.join(dir, "packets"));
    expect(packetsOnDisk).toHaveLength(20);

    const plan = planCampaign(ITERATIONS);
    const completed = new Set(packetsOnDisk);
    const receipt = triggerShutdown({
      campaignId: "halted-campaign",
      trigger: "operator_kill",
      allPlannedRuns: plan,
      completedRunKeys: completed,
      runKey: (run) => packetFileName(run.case_id, run.iteration),
      monotonicStartNs: 0n,
      now: () => 1_000_000n,
    });
    expect(receipt.unfinished_runs).toHaveLength(40);
    // No manifest is written for a halted, incomplete campaign — Plan 03's
    // verify.ts would otherwise be asked to grade a campaign against the
    // pack's full 60-run shape and correctly call it INVALID_PACK.
    expect(result.manifestPath).toBeNull();
  });
});
