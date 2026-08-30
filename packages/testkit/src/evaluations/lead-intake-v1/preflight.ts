/**
 * Local Pi / dedicated-Docker readiness gate — Plan 04 item 3 preconditions.
 *
 * This is a pure decision function over an explicit, caller-supplied snapshot of
 * the environment. It does not itself inspect any live system: nothing in this
 * repository's current runtime can attest "this is a dedicated computer" or
 * "connectors are absent from tool exposure" from inside a test process, so a
 * caller must supply that attestation and stand behind it. What this function
 * guarantees is that if the attestation is honest, the gate is fail-closed: any
 * missing or false precondition blocks the campaign, no override, no exception.
 *
 * As of this pack's SOLO-OPERATOR-APPROVAL-20260829.md, the local-Pi/dedicated-
 * Docker campaign (Plan 04 item 3) is outside this phase's authority regardless
 * of what this gate reports — Docker mutation and Dell deployment are on the
 * prohibited list. This module exists so the gate itself is built and tested
 * now, not so it is invoked against a real computer in this phase.
 */

export interface LocalPiPreflightInput {
  evalPackV1EnabledForThisProcessOnly: boolean;
  computerKind: "dedicated" | "team_computer" | "this_mac" | "unknown";
  connectorsDisabled: boolean;
  routinesDisabled: boolean;
  corpusIsSynthetic: boolean;
  productionMountsPresent: boolean;
  candidatePolicyHash: string;
  approvedPolicyHash: string;
  costBudgetArmed: boolean;
  killSwitchArmed: boolean;
  /** True only when an operator has explicitly authorized THIS specific campaign to leave R1. */
  phaseAuthorizesLocalPiExecution: boolean;
}

export type LocalPiPreflightFailure =
  | "FEATURE_FLAG_NOT_SCOPED"
  | "NOT_DEDICATED_COMPUTER"
  | "CONNECTORS_NOT_DISABLED"
  | "ROUTINES_NOT_DISABLED"
  | "CORPUS_NOT_SYNTHETIC"
  | "PRODUCTION_MOUNTS_PRESENT"
  | "POLICY_HASH_MISMATCH"
  | "COST_BUDGET_NOT_ARMED"
  | "KILL_SWITCH_NOT_ARMED"
  | "PHASE_DOES_NOT_AUTHORIZE_LOCAL_PI";

export interface LocalPiPreflightResult {
  authorized: boolean;
  failures: LocalPiPreflightFailure[];
}

export function evaluateLocalPiPreflight(input: LocalPiPreflightInput): LocalPiPreflightResult {
  const failures: LocalPiPreflightFailure[] = [];

  if (!input.evalPackV1EnabledForThisProcessOnly) failures.push("FEATURE_FLAG_NOT_SCOPED");
  if (input.computerKind !== "dedicated") failures.push("NOT_DEDICATED_COMPUTER");
  if (!input.connectorsDisabled) failures.push("CONNECTORS_NOT_DISABLED");
  if (!input.routinesDisabled) failures.push("ROUTINES_NOT_DISABLED");
  if (!input.corpusIsSynthetic) failures.push("CORPUS_NOT_SYNTHETIC");
  if (input.productionMountsPresent) failures.push("PRODUCTION_MOUNTS_PRESENT");
  if (input.candidatePolicyHash !== input.approvedPolicyHash) failures.push("POLICY_HASH_MISMATCH");
  if (!input.costBudgetArmed) failures.push("COST_BUDGET_NOT_ARMED");
  if (!input.killSwitchArmed) failures.push("KILL_SWITCH_NOT_ARMED");
  // Checked last and independently of every other flag: even a perfect
  // environment cannot self-authorize leaving R1. This is the one failure a
  // caller cannot manufacture true by describing their environment accurately.
  if (!input.phaseAuthorizesLocalPiExecution) failures.push("PHASE_DOES_NOT_AUTHORIZE_LOCAL_PI");

  return { authorized: failures.length === 0, failures };
}

/**
 * The honest default for this phase: every optimistic flag on, and the one
 * flag that actually matters — phase authorization — off, because
 * SOLO-OPERATOR-APPROVAL-20260829.md does not grant it. Used by
 * lead-intake-release-report.ts to record why item 3 was not attempted,
 * without fabricating a live-environment claim this process cannot make.
 */
export function currentPhaseLocalPiInput(policyHash: string): LocalPiPreflightInput {
  return {
    evalPackV1EnabledForThisProcessOnly: true,
    computerKind: "dedicated",
    connectorsDisabled: true,
    routinesDisabled: true,
    corpusIsSynthetic: true,
    productionMountsPresent: false,
    candidatePolicyHash: policyHash,
    approvedPolicyHash: policyHash,
    costBudgetArmed: true,
    killSwitchArmed: true,
    phaseAuthorizesLocalPiExecution: false,
  };
}
