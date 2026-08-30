import { createHash } from "node:crypto";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  EVALUATION_ALLOWED_TOOL_IDS,
  EvaluationRunPolicySchema,
  type EvaluationRunPolicy,
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
