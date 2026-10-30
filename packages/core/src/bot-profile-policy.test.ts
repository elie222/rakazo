import { describe, expect, it } from "vitest";
import {
  automaticLearningPromotionDecision,
  type BotCapabilityPolicy,
  botPolicyAllowsTool,
  type LearningPromotionCheck,
  narrowBotCapabilityPolicy,
} from "./bot-profile-policy.js";

const parent: BotCapabilityPolicy = {
  allowedTools: ["read", "write"],
  deniedTools: ["write"],
  allowedSkillIds: ["research"],
  allowedMcpTools: ["calendar.read"],
};

const valid: LearningPromotionCheck = {
  mode: "automatic-private",
  artifactKind: "private-memory",
  hasEvidence: true,
  sourceGeneration: 2,
  currentGeneration: 2,
  expectedRevision: 3,
  currentRevision: 3,
  qualified: true,
  suppressed: false,
};

describe("bot capability policy", () => {
  it("intersects delegated authority and preserves parent denies", () => {
    expect(
      narrowBotCapabilityPolicy(parent, {
        allowedTools: ["read", "write", "shell"],
        deniedTools: [],
        allowedSkillIds: ["research", "private-peer-skill"],
        allowedMcpTools: ["calendar.read", "calendar.write"],
      }),
    ).toEqual({ ...parent, allowedTools: ["read"] });
  });

  it("requires explicit membership and lets denies win", () => {
    expect(botPolicyAllowsTool(parent, "read")).toBe(true);
    expect(botPolicyAllowsTool(parent, "write")).toBe(false);
    expect(botPolicyAllowsTool(parent, "shell")).toBe(false);
  });

  it("does not mutate or expand a parent policy", () => {
    const before = structuredClone(parent);
    const result = narrowBotCapabilityPolicy(parent, { ...parent, deniedTools: ["read"] });
    expect(result.allowedTools).toEqual([]);
    expect(parent).toEqual(before);
  });
});

describe("automatic learning promotion", () => {
  it("allows qualified evidenced private memory or instructional skills", () => {
    expect(automaticLearningPromotionDecision(valid)).toEqual({ allowed: true });
    expect(automaticLearningPromotionDecision({ ...valid, artifactKind: "private-skill" })).toEqual(
      {
        allowed: true,
      },
    );
  });

  it.each(["off", "proposals-only"] as const)("requires review in %s mode", (mode) => {
    expect(automaticLearningPromotionDecision({ ...valid, mode })).toEqual({
      allowed: false,
      reason: "owner-review",
    });
  });

  it.each([
    "shared-memory",
    "persona",
    "instructions",
    "executable",
    "permissions",
    "enabled-goal",
  ] as const)("never automatically promotes %s", (artifactKind) => {
    expect(automaticLearningPromotionDecision({ ...valid, artifactKind })).toEqual({
      allowed: false,
      reason: "artifact-requires-owner",
    });
  });

  it.each([
    [{ suppressed: true }, "source-suppressed"],
    [{ currentGeneration: 4 }, "stale-generation"],
    [{ currentRevision: 4 }, "revision-conflict"],
    [{ hasEvidence: false }, "unqualified"],
    [{ qualified: false }, "unqualified"],
  ] as const)("rejects invalid promotion state %j", (change, reason) => {
    expect(automaticLearningPromotionDecision({ ...valid, ...change })).toEqual({
      allowed: false,
      reason,
    });
  });
});
