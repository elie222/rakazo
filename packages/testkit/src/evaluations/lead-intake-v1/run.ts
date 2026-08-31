import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EVALUATION_PACK_ID,
  type EvaluationCaseId,
  EvaluationCaseIdSchema,
  type EvaluationState,
  type EvaluationStateTransition,
  type LeadIntakeCaseInput,
  LeadIntakeCaseInputSchema,
} from "@rakazo/contracts";
import {
  applyEvaluationTransition,
  type EvaluationStateLedger,
  evaluateLeadIntake,
} from "@rakazo/core";
import {
  type CampaignManifestBody,
  canonicalSha256,
  EvidenceFormatError,
  type EvidencePacket,
  type EvidencePacketBody,
  isPacketHashValid,
  packetFileName,
  parseEvidencePacket,
  sealManifest,
  sealPacket,
} from "./evidence.js";

/**
 * Hermetic campaign runner for the lead-intake-quote-readiness-v1 evaluation pack.
 *
 * "Scripted runtime" means the agent-under-test is the deterministic
 * `evaluateLeadIntake` function, not a live model. That is what makes this pack
 * runnable with zero model, connector, browser, or external-system dependency —
 * required by Plan 03 and by SOLO-OPERATOR-APPROVAL-20260829.md.
 */

export const CASE_COUNT = 20;
export const ITERATIONS = 3;
export const EXPECTED_RUN_COUNT = CASE_COUNT * ITERATIONS;

const packageRoot = path.join(import.meta.dirname);
const casesRoot = path.join(packageRoot, "cases");

export function canonicalCaseIds(): EvaluationCaseId[] {
  return Array.from({ length: CASE_COUNT }, (_, index) =>
    EvaluationCaseIdSchema.parse(`LIQR-${String(index + 1).padStart(3, "0")}`),
  ) as EvaluationCaseId[];
}

export function loadCase(caseId: EvaluationCaseId): LeadIntakeCaseInput {
  const raw = JSON.parse(readFileSync(path.join(casesRoot, `${caseId}.json`), "utf8"));
  return LeadIntakeCaseInputSchema.parse(raw);
}

export interface PlannedRun {
  case_id: EvaluationCaseId;
  iteration: number;
}

/** Stable order: case LIQR-001..020, each x iterations 1..N. Never randomized. */
export function planCampaign(iterations: number = ITERATIONS): PlannedRun[] {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS) {
    throw new Error(`iterations must be an integer between 1 and ${ITERATIONS}`);
  }
  const plan: PlannedRun[] = [];
  for (const caseId of canonicalCaseIds()) {
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      plan.push({ case_id: caseId, iteration });
    }
  }
  return plan;
}

export type RuntimeMode = "scripted";
export type SandboxMode = "fake";

export interface CampaignOptions {
  campaignId: string;
  runtime: RuntimeMode;
  sandbox: SandboxMode;
  iterations: number;
  outputDir: string;
  candidateRevision?: string;
  dryRun?: boolean;
  resume?: boolean;
  /** Called before each run; returning a reason stops the campaign at that point. */
  shutdownCheck?: () => string | null;
}

export interface CampaignResult {
  campaignId: string;
  plannedRuns: number;
  completedRuns: number;
  packetPaths: string[];
  manifestPath: string | null;
  shutdown: { triggered: boolean; reason: string | null; afterRuns: number };
}

function packetsDir(outputDir: string): string {
  return path.join(outputDir, "packets");
}

/**
 * The resumable checkpoint is the sealed evidence itself, not a separate mutable
 * log: a packet only counts as "already done" if it parses against the current
 * schema, its filename matches its own declared case/iteration, its hash is
 * valid, and it belongs to this exact campaign. A corrupt or foreign leftover
 * file is silently re-run rather than trusted — resume can only skip a run it
 * can independently verify, never one it merely remembers doing.
 */
function loadResumableCompletedKeys(outputDir: string, campaignId: string): Set<string> {
  const dir = packetsDir(outputDir);
  const completed = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return completed;
  }
  for (const name of names) {
    try {
      const packet = parseEvidencePacket(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
      if (
        packet.campaign_id === campaignId &&
        isPacketHashValid(packet) &&
        packetFileName(packet.case_id, packet.iteration) === name
      ) {
        completed.add(name);
      }
    } catch (error) {
      if (!(error instanceof EvidenceFormatError) && !(error instanceof SyntaxError)) throw error;
      // unparseable/foreign file at this path — treated as not-yet-completed, will be overwritten
    }
  }
  return completed;
}

export function resolveCandidateRevision(explicit?: string): string {
  if (explicit) return explicit;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown-revision";
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Deterministic state path for one evaluated case, following the transitions
 * registered in `@rakazo/core`'s lead-intake state machine. Every case reaches
 * `EVIDENCE_PACKAGING` -> `VERIFYING` -> `AWAITING_HUMAN_REVIEW`; only the
 * analysis-stage branch differs by readiness class.
 */
function buildStateTransitions(
  analysisState: EvaluationState,
  includeDraftingStep: boolean,
  clockStart: number,
): EvaluationStateTransition[] {
  const path: EvaluationState[] = [
    "CREATED",
    "PREFLIGHT",
    "VALIDATING",
    "ANALYZING",
    analysisState,
  ];
  if (includeDraftingStep) path.push("DRAFTING_LOCAL_FOLLOW_UP");
  path.push("EVIDENCE_PACKAGING", "VERIFYING", "AWAITING_HUMAN_REVIEW");

  let ledger: EvaluationStateLedger = { state: "CREATED", fence: 0, transitions: [] };
  for (let index = 1; index < path.length; index += 1) {
    const to = path[index]!;
    ledger = applyEvaluationTransition(ledger, {
      transition_id: `TRANSITION-${String(index).padStart(2, "0")}-${to}`,
      to,
      expected_fence: ledger.fence,
      occurred_at: new Date(clockStart + index).toISOString(),
    });
  }
  return ledger.transitions;
}

function buildPacket(
  campaignId: string,
  input: LeadIntakeCaseInput,
  iteration: number,
  candidateRevision: string,
): EvidencePacket {
  const output = evaluateLeadIntake(input);
  const analysisState = output.readiness_class;
  const transitions = buildStateTransitions(
    analysisState,
    analysisState === "NEEDS_INFORMATION" && output.follow_up_draft !== null,
    Date.now(),
  );
  const startedAt = transitions[0]?.occurred_at ?? isoNow();
  const finishedAt = transitions.at(-1)?.occurred_at ?? isoNow();

  const body: EvidencePacketBody = {
    schema_version: "1.0",
    pack_id: EVALUATION_PACK_ID,
    campaign_id: campaignId,
    case_id: input.case_id,
    iteration,
    synthetic: true,
    source_revision: candidateRevision,
    input_sha256: canonicalSha256(input),
    started_at: startedAt,
    finished_at: finishedAt,
    state_transitions: transitions,
    output,
    tool_trace: [],
    denial_receipts: [],
    usage: {
      turns: 1,
      tool_calls: 0,
      wall_time_ms: 0,
      retries: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_microdollars: 0,
      child_agents: 0,
    },
    terminal_state: "AWAITING_HUMAN_REVIEW",
    terminal_reason: "complete",
    artifacts: [],
  };
  return sealPacket(body);
}

function buildPreflightRecord(options: CampaignOptions): Record<string, unknown> {
  return {
    pack_id: EVALUATION_PACK_ID,
    campaign_id: options.campaignId,
    runtime: options.runtime,
    sandbox: options.sandbox,
    live_model: false,
    connectors_enabled: false,
    production_mounts: false,
    allowed_tools: [
      "evaluation_read_case",
      "evaluation_write_result",
      "evaluation_halt",
      "evaluation_request_review",
    ],
  };
}

export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  const plan = planCampaign(options.iterations);
  if (options.dryRun) {
    return {
      campaignId: options.campaignId,
      plannedRuns: plan.length,
      completedRuns: 0,
      packetPaths: [],
      manifestPath: null,
      shutdown: { triggered: false, reason: null, afterRuns: 0 },
    };
  }

  mkdirSync(packetsDir(options.outputDir), { recursive: true });

  const completed = options.resume
    ? loadResumableCompletedKeys(options.outputDir, options.campaignId)
    : new Set<string>();
  const candidateRevision = resolveCandidateRevision(options.candidateRevision);

  const packetPaths: string[] = [];
  let shutdownReason: string | null = null;
  let runsThisInvocation = 0;

  for (const planned of plan) {
    const key = packetFileName(planned.case_id, planned.iteration);
    const packetPath = path.join(packetsDir(options.outputDir), key);
    if (completed.has(key)) {
      packetPaths.push(packetPath);
      continue;
    }

    const reason = options.shutdownCheck?.() ?? null;
    if (reason) {
      shutdownReason = reason;
      break;
    }

    const input = loadCase(planned.case_id);
    const packet = buildPacket(options.campaignId, input, planned.iteration, candidateRevision);
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    packetPaths.push(packetPath);
    completed.add(key);
    runsThisInvocation += 1;
  }

  let manifestPath: string | null = null;
  if (!shutdownReason || completed.size === plan.length) {
    const preflight = buildPreflightRecord(options);
    const packetHashes = readdirSync(packetsDir(options.outputDir))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const packet = JSON.parse(
          readFileSync(path.join(packetsDir(options.outputDir), name), "utf8"),
        ) as EvidencePacket;
        return packet.packet_sha256;
      });
    const manifestBody: CampaignManifestBody = {
      schema_version: "1.0",
      pack_id: EVALUATION_PACK_ID,
      campaign_id: options.campaignId,
      source_revision: candidateRevision,
      runtime: options.runtime,
      sandbox: options.sandbox,
      iterations: options.iterations,
      case_count: CASE_COUNT,
      expected_run_count: plan.length,
      packet_hashes: packetHashes,
      preflight_sha256: canonicalSha256(preflight),
      shutdown_receipt_sha256: shutdownReason ? canonicalSha256({ reason: shutdownReason }) : null,
      rollback_receipt_sha256: null,
      created_at: isoNow(),
    };
    const manifest = sealManifest(manifestBody);
    manifestPath = path.join(options.outputDir, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return {
    campaignId: options.campaignId,
    plannedRuns: plan.length,
    completedRuns: completed.size,
    packetPaths,
    manifestPath,
    shutdown: {
      triggered: shutdownReason !== null,
      reason: shutdownReason,
      afterRuns: runsThisInvocation,
    },
  };
}
