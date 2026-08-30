import { createHash } from "node:crypto";
import {
  EVALUATION_PACK_ID,
  type EvaluationCaseId,
  EvaluationCaseIdSchema,
  type EvaluationPolicyDenialReceipt,
  EvaluationPolicyDenialReceiptSchema,
  type EvaluationState,
  EvaluationStateSchema,
  type EvaluationStateTransition,
  EvaluationStateTransitionSchema,
  type EvaluationTerminalReason,
  EvaluationTerminalReasonSchema,
  type EvaluationUsage,
  EvaluationUsageSchema,
  type EvidenceOutput,
  EvidenceOutputSchema,
} from "@rakazo/contracts";

/**
 * Evidence packets and campaign manifests for the lead-intake evaluation pack.
 *
 * This module deliberately imports only `@rakazo/contracts` (pure schemas) and Node
 * builtins. The verifier depends on it, and Plan 03 requires the verifier to be free
 * of the model runtime, connector stack, sandbox, and executor. Keep it that way —
 * `verifier.test.ts` asserts the import graph.
 */

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class EvidenceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceFormatError";
  }
}

function fail(message: string): never {
  throw new EvidenceFormatError(message);
}

/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Object keys are sorted by UTF-16 code unit (the default `Array#sort` ordering, which
 * matches JCS for the ASCII key space this pack uses). Arrays keep their order. No
 * insignificant whitespace is emitted, so the output bytes are stable across runs and
 * machines — which is what makes the packet hash meaningful.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`non-finite number cannot be canonicalized: ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`)
      .join(",")}}`;
  }
  return fail(`unsupported value type for canonicalization: ${typeof value}`);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export interface EvidencePacketBody {
  schema_version: "1.0";
  pack_id: typeof EVALUATION_PACK_ID;
  campaign_id: string;
  case_id: EvaluationCaseId;
  iteration: number;
  synthetic: true;
  source_revision: string;
  input_sha256: string;
  started_at: string;
  finished_at: string;
  state_transitions: EvaluationStateTransition[];
  output: EvidenceOutput;
  tool_trace: string[];
  denial_receipts: EvaluationPolicyDenialReceipt[];
  usage: EvaluationUsage;
  terminal_state: EvaluationState;
  terminal_reason: EvaluationTerminalReason;
  artifacts: string[];
}

export interface EvidencePacket extends EvidencePacketBody {
  packet_sha256: string;
}

const PACKET_KEYS: readonly (keyof EvidencePacket)[] = [
  "schema_version",
  "pack_id",
  "campaign_id",
  "case_id",
  "iteration",
  "synthetic",
  "source_revision",
  "input_sha256",
  "started_at",
  "finished_at",
  "state_transitions",
  "output",
  "tool_trace",
  "denial_receipts",
  "usage",
  "terminal_state",
  "terminal_reason",
  "artifacts",
  "packet_sha256",
];

/** The packet hash covers canonical bytes with `packet_sha256` itself omitted. */
export function packetHash(body: EvidencePacketBody): string {
  return canonicalSha256(body);
}

export function sealPacket(body: EvidencePacketBody): EvidencePacket {
  return { ...body, packet_sha256: packetHash(body) };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function asSha256(value: unknown, label: string): string {
  const text = asString(value, label);
  if (!SHA256_PATTERN.test(text)) fail(`${label} must be a lowercase hex sha256`);
  return text;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
}

function asPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Strict packet parse. Unknown or missing keys are a format error, not a warning —
 * missing evidence must never read as a skip or a pass.
 */
export function parseEvidencePacket(value: unknown): EvidencePacket {
  const raw = asRecord(value, "evidence packet");
  const seen = Object.keys(raw).sort();
  const expected = [...PACKET_KEYS].sort();
  if (seen.length !== expected.length || seen.some((key, index) => key !== expected[index])) {
    fail(`evidence packet keys mismatch: got [${seen.join(",")}]`);
  }
  if (raw.schema_version !== "1.0") fail("evidence packet schema_version must be 1.0");
  if (raw.pack_id !== EVALUATION_PACK_ID) fail("evidence packet pack_id mismatch");
  if (raw.synthetic !== true) fail("evidence packet synthetic must be true");
  if (!Array.isArray(raw.state_transitions)) fail("state_transitions must be an array");
  if (!Array.isArray(raw.denial_receipts)) fail("denial_receipts must be an array");

  const packet: EvidencePacket = {
    schema_version: "1.0",
    pack_id: EVALUATION_PACK_ID,
    campaign_id: asString(raw.campaign_id, "campaign_id"),
    case_id: EvaluationCaseIdSchema.parse(raw.case_id) as EvaluationCaseId,
    iteration: asPositiveInt(raw.iteration, "iteration"),
    synthetic: true,
    source_revision: asString(raw.source_revision, "source_revision"),
    input_sha256: asSha256(raw.input_sha256, "input_sha256"),
    started_at: asString(raw.started_at, "started_at"),
    finished_at: asString(raw.finished_at, "finished_at"),
    state_transitions: raw.state_transitions.map((entry) =>
      EvaluationStateTransitionSchema.parse(entry),
    ),
    output: EvidenceOutputSchema.parse(raw.output),
    tool_trace: asStringArray(raw.tool_trace, "tool_trace"),
    denial_receipts: raw.denial_receipts.map((entry) =>
      EvaluationPolicyDenialReceiptSchema.parse(entry),
    ),
    usage: EvaluationUsageSchema.parse(raw.usage),
    terminal_state: EvaluationStateSchema.parse(raw.terminal_state),
    terminal_reason: EvaluationTerminalReasonSchema.parse(raw.terminal_reason),
    artifacts: asStringArray(raw.artifacts, "artifacts"),
    packet_sha256: asSha256(raw.packet_sha256, "packet_sha256"),
  };
  return packet;
}

/** True only when the recomputed hash matches the stored one — one flipped byte fails. */
export function isPacketHashValid(packet: EvidencePacket): boolean {
  const { packet_sha256, ...body } = packet;
  return packetHash(body as EvidencePacketBody) === packet_sha256;
}

export interface CampaignManifestBody {
  schema_version: "1.0";
  pack_id: typeof EVALUATION_PACK_ID;
  campaign_id: string;
  source_revision: string;
  runtime: string;
  sandbox: string;
  iterations: number;
  case_count: number;
  expected_run_count: number;
  packet_hashes: string[];
  preflight_sha256: string;
  shutdown_receipt_sha256: string | null;
  rollback_receipt_sha256: string | null;
  created_at: string;
}

export interface CampaignManifest extends CampaignManifestBody {
  manifest_sha256: string;
}

const MANIFEST_KEYS: readonly (keyof CampaignManifest)[] = [
  "schema_version",
  "pack_id",
  "campaign_id",
  "source_revision",
  "runtime",
  "sandbox",
  "iterations",
  "case_count",
  "expected_run_count",
  "packet_hashes",
  "preflight_sha256",
  "shutdown_receipt_sha256",
  "rollback_receipt_sha256",
  "created_at",
  "manifest_sha256",
];

export function manifestHash(body: CampaignManifestBody): string {
  return canonicalSha256(body);
}

export function sealManifest(body: CampaignManifestBody): CampaignManifest {
  return { ...body, manifest_sha256: manifestHash(body) };
}

export function parseCampaignManifest(value: unknown): CampaignManifest {
  const raw = asRecord(value, "campaign manifest");
  const seen = Object.keys(raw).sort();
  const expected = [...MANIFEST_KEYS].sort();
  if (seen.length !== expected.length || seen.some((key, index) => key !== expected[index])) {
    fail(`campaign manifest keys mismatch: got [${seen.join(",")}]`);
  }
  if (raw.schema_version !== "1.0") fail("campaign manifest schema_version must be 1.0");
  if (raw.pack_id !== EVALUATION_PACK_ID) fail("campaign manifest pack_id mismatch");

  const optionalSha = (input: unknown, label: string): string | null =>
    input === null ? null : asSha256(input, label);

  return {
    schema_version: "1.0",
    pack_id: EVALUATION_PACK_ID,
    campaign_id: asString(raw.campaign_id, "campaign_id"),
    source_revision: asString(raw.source_revision, "source_revision"),
    runtime: asString(raw.runtime, "runtime"),
    sandbox: asString(raw.sandbox, "sandbox"),
    iterations: asPositiveInt(raw.iterations, "iterations"),
    case_count: asPositiveInt(raw.case_count, "case_count"),
    expected_run_count: asPositiveInt(raw.expected_run_count, "expected_run_count"),
    packet_hashes: asStringArray(raw.packet_hashes, "packet_hashes").map((entry, index) =>
      asSha256(entry, `packet_hashes[${index}]`),
    ),
    preflight_sha256: asSha256(raw.preflight_sha256, "preflight_sha256"),
    shutdown_receipt_sha256: optionalSha(raw.shutdown_receipt_sha256, "shutdown_receipt_sha256"),
    rollback_receipt_sha256: optionalSha(raw.rollback_receipt_sha256, "rollback_receipt_sha256"),
    created_at: asString(raw.created_at, "created_at"),
    manifest_sha256: asSha256(raw.manifest_sha256, "manifest_sha256"),
  };
}

export function isManifestHashValid(manifest: CampaignManifest): boolean {
  const { manifest_sha256, ...body } = manifest;
  return manifestHash(body as CampaignManifestBody) === manifest_sha256;
}

/** Stable, filesystem-safe packet filename. Sorting these sorts runs deterministically. */
export function packetFileName(caseId: string, iteration: number): string {
  return `${caseId}-iter${String(iteration).padStart(2, "0")}.json`;
}
