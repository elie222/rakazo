import { createHash } from "node:crypto";
import type {
  ConnectorTool,
  EvaluationEvidenceSink,
  EvaluationToolHandlers,
} from "@rakazo/adapter-kit";
import {
  EVALUATION_ALLOWED_TOOL_IDS,
  type EvaluationPolicyDenialReceipt,
  EvaluationPolicyDenialReceiptSchema,
  type EvaluationRunPolicy,
  EvaluationRunPolicySchema,
  type EvaluationToolId,
} from "@rakazo/contracts";

export interface EvaluationRunIdentity {
  runId: string;
  workspaceId: string;
  userId: string;
  campaignId: string;
  caseId: string;
  policyHash: string;
}

export type EvaluationPreflightResult =
  | { ok: true; policy: EvaluationRunPolicy }
  | { ok: false; reason: string };

export const evaluationAgentTools: ConnectorTool[] = [
  {
    name: "evaluation_read_case",
    description: "Read only the current frozen synthetic evaluation case.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evaluation_write_result",
    description: "Write a structured result only to this run's bound evidence target.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" }, result: { type: "object" } },
      required: ["target", "result"],
    },
  },
  {
    name: "evaluation_halt",
    description: "Halt the current synthetic evaluation campaign with a bounded reason.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "evaluation_request_review",
    description: "Request human review without authorizing any external action.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

export function modelVisibleEvaluationTools(policy: EvaluationRunPolicy): ConnectorTool[] {
  const allowed = new Set(policy.allowed_tool_ids);
  return evaluationAgentTools.filter((tool) => allowed.has(tool.name as EvaluationToolId));
}

export function normalizeEvaluationToolIdentity(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
}

export type EvaluationToolDecision =
  | { allowed: true; tool: EvaluationToolId }
  | { allowed: false; receipt: EvaluationPolicyDenialReceipt };

export function authorizeEvaluationTool(input: {
  policy: EvaluationRunPolicy;
  name: string;
  args: Record<string, unknown>;
  executionId: string;
  now?: Date;
}): EvaluationToolDecision {
  const normalized = normalizeEvaluationToolIdentity(input.name);
  const exact = EVALUATION_ALLOWED_TOOL_IDS.includes(input.name as EvaluationToolId);
  let reason: EvaluationPolicyDenialReceipt["reason"] | undefined;
  if (input.policy.revoked_at) reason = "POLICY_REVOKED";
  else if (!exact) {
    reason = normalized !== input.name ? "TOOL_ALIAS_NOT_ALLOWED" : "TOOL_NOT_ALLOWED";
  } else if (!input.policy.allowed_tool_ids.includes(input.name as EvaluationToolId)) {
    reason = "TOOL_NOT_ALLOWED";
  } else if (
    input.name === "evaluation_write_result" &&
    input.args.target !== `${input.policy.evidence_root}/result.json`
  ) {
    reason = "EVIDENCE_TARGET_MISMATCH";
  }
  if (!reason) return { allowed: true, tool: input.name as EvaluationToolId };
  const receipt = EvaluationPolicyDenialReceiptSchema.parse({
    receipt_id: `denial-${createHash("sha256")
      .update(`${input.policy.run_id}\0${input.executionId}\0${normalized}`)
      .digest("hex")
      .slice(0, 24)}`,
    campaign_id: input.policy.campaign_id,
    case_id: input.policy.case_id,
    run_id: input.policy.run_id,
    requested_tool: input.name,
    normalized_tool: normalized,
    execution_id: input.executionId,
    argument_keys: Object.keys(input.args).sort(),
    reason,
    occurred_at: (input.now ?? new Date()).toISOString(),
  });
  return { allowed: false, receipt };
}

export class EvaluationToolDispatcher {
  readonly #policy: EvaluationRunPolicy;
  readonly #evidence: EvaluationEvidenceSink;
  readonly #results = new Map<string, unknown>();

  constructor(policy: EvaluationRunPolicy, evidence: EvaluationEvidenceSink) {
    this.#policy = policy;
    this.#evidence = evidence;
  }

  async dispatch(
    name: string,
    args: Record<string, unknown>,
    executionId: string,
    handlers: EvaluationToolHandlers,
  ): Promise<unknown> {
    if (this.#results.has(executionId)) return this.#results.get(executionId);
    const decision = authorizeEvaluationTool({
      policy: this.#policy,
      name,
      args,
      executionId,
    });
    if (!decision.allowed) {
      const result = { ok: false, error: "EVALUATION_POLICY_DENIED", receipt: decision.receipt };
      this.#results.set(executionId, result);
      await this.#evidence.appendDenial(decision.receipt);
      return result;
    }
    const result = await handlers[decision.tool]({
      policy: this.#policy,
      tool: decision.tool,
      args,
      executionId,
    });
    this.#results.set(executionId, result);
    return result;
  }
}

export function storedRunPolicyToContract(row: {
  kind: string;
  packId: string;
  campaignId: string;
  caseId: string;
  runId: string;
  userId: string;
  workspaceId: string;
  allowedToolIds: unknown;
  evidenceRoot: string;
  budgets: unknown;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  policyHash: string;
}): unknown {
  return {
    kind: row.kind,
    pack_id: row.packId,
    campaign_id: row.campaignId,
    case_id: row.caseId,
    run_id: row.runId,
    user_id: row.userId,
    workspace_id: row.workspaceId,
    allowed_tool_ids: row.allowedToolIds,
    evidence_root: row.evidenceRoot,
    budgets: row.budgets,
    issued_at: row.issuedAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    revoked_at: row.revokedAt?.toISOString() ?? null,
    policy_hash: row.policyHash,
  };
}

export function computeEvaluationPolicyHash(
  policy: Omit<EvaluationRunPolicy, "policy_hash">,
): string {
  return createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex");
}

export function validateEvaluationPreflight(input: {
  featureEnabled: boolean;
  policy: unknown;
  identity: EvaluationRunIdentity;
  now: Date;
}): EvaluationPreflightResult {
  if (!input.featureEnabled) return { ok: false, reason: "FEATURE_DISABLED" };
  const parsed = EvaluationRunPolicySchema.safeParse(input.policy);
  if (!parsed.success) return { ok: false, reason: "INVALID_POLICY" };
  const policy = parsed.data;
  const identityPairs: Array<[unknown, unknown, string]> = [
    [policy.run_id, input.identity.runId, "RUN_MISMATCH"],
    [policy.workspace_id, input.identity.workspaceId, "WORKSPACE_MISMATCH"],
    [policy.user_id, input.identity.userId, "USER_MISMATCH"],
    [policy.campaign_id, input.identity.campaignId, "CAMPAIGN_MISMATCH"],
    [policy.case_id, input.identity.caseId, "CASE_MISMATCH"],
    [policy.policy_hash, input.identity.policyHash, "POLICY_HASH_MISMATCH"],
  ];
  for (const [actual, expected, reason] of identityPairs) {
    if (actual !== expected) return { ok: false, reason };
  }
  if (policy.revoked_at) return { ok: false, reason: "POLICY_REVOKED" };
  if (new Date(policy.issued_at).getTime() > input.now.getTime()) {
    return { ok: false, reason: "POLICY_NOT_YET_VALID" };
  }
  if (new Date(policy.expires_at).getTime() <= input.now.getTime()) {
    return { ok: false, reason: "POLICY_EXPIRED" };
  }
  const material = { ...policy };
  delete (material as Partial<EvaluationRunPolicy>).policy_hash;
  if (computeEvaluationPolicyHash(material) !== policy.policy_hash) {
    return { ok: false, reason: "POLICY_HASH_INVALID" };
  }
  if (
    policy.allowed_tool_ids.length !== EVALUATION_ALLOWED_TOOL_IDS.length ||
    EVALUATION_ALLOWED_TOOL_IDS.some((tool) => !policy.allowed_tool_ids.includes(tool))
  ) {
    return { ok: false, reason: "TOOL_ALLOWLIST_INVALID" };
  }
  return { ok: true, policy };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
