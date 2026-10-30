/** Capability policy is an intersection, never a grant from model-authored content. */
export type BotCapabilityPolicy = {
  allowedTools: readonly string[];
  deniedTools: readonly string[];
  allowedSkillIds: readonly string[];
  allowedMcpTools: readonly string[];
};

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const permitted = new Set(right);
  return [...new Set(left)].filter((value) => permitted.has(value)).sort();
}

export function narrowBotCapabilityPolicy(
  parent: BotCapabilityPolicy,
  requested: BotCapabilityPolicy,
): BotCapabilityPolicy {
  const deniedTools = [...new Set([...parent.deniedTools, ...requested.deniedTools])].sort();
  const denied = new Set(deniedTools);
  return {
    allowedTools: intersection(parent.allowedTools, requested.allowedTools).filter(
      (tool) => !denied.has(tool),
    ),
    deniedTools,
    allowedSkillIds: intersection(parent.allowedSkillIds, requested.allowedSkillIds),
    allowedMcpTools: intersection(parent.allowedMcpTools, requested.allowedMcpTools),
  };
}

/** Live restrictions override a persisted run snapshot, including explicit denies. */
export function botPolicyAllowsTool(policy: BotCapabilityPolicy, toolName: string): boolean {
  return policy.allowedTools.includes(toolName) && !policy.deniedTools.includes(toolName);
}

export type LearningArtifactKind =
  | "private-memory"
  | "private-skill"
  | "shared-memory"
  | "persona"
  | "instructions"
  | "executable"
  | "permissions"
  | "enabled-goal";

export type LearningPromotionCheck = {
  mode: "off" | "proposals-only" | "automatic-private";
  artifactKind: LearningArtifactKind;
  hasEvidence: boolean;
  sourceGeneration: number;
  currentGeneration: number;
  expectedRevision: number;
  currentRevision: number;
  qualified: boolean;
  suppressed: boolean;
};

/** Qualification alone cannot authorize a promotion or expand its allowed artifact types. */
export function automaticLearningPromotionDecision(
  check: LearningPromotionCheck,
): { allowed: true } | { allowed: false; reason: string } {
  if (check.mode !== "automatic-private") return { allowed: false, reason: "owner-review" };
  if (check.artifactKind !== "private-memory" && check.artifactKind !== "private-skill") {
    return { allowed: false, reason: "artifact-requires-owner" };
  }
  if (check.suppressed) return { allowed: false, reason: "source-suppressed" };
  if (check.sourceGeneration !== check.currentGeneration) {
    return { allowed: false, reason: "stale-generation" };
  }
  if (check.expectedRevision !== check.currentRevision) {
    return { allowed: false, reason: "revision-conflict" };
  }
  if (!check.hasEvidence || !check.qualified) return { allowed: false, reason: "unqualified" };
  return { allowed: true };
}
