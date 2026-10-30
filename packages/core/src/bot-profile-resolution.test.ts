import { describe, expect, it } from "vitest";
import { resolveEffectiveBotProfile } from "./bot-profile-resolution.js";

const bot = {
  instructions: "Keep answers direct.",
  modelProvider: "provider-a",
  modelId: "model-a",
  thinkingLevel: "medium",
  disabledBuiltinTools: ["shell"],
};

describe("effective bot profile resolution", () => {
  it("uses safe profile defaults and preserves existing bot settings", () => {
    const result = resolveEffectiveBotProfile(bot);
    expect(result).toMatchObject({
      persona: "",
      instructions: bot.instructions,
      profileRevision: null,
      profileProvenance: "defaults",
      modelProvider: bot.modelProvider,
      modelId: bot.modelId,
      thinkingLevel: bot.thinkingLevel,
      disabledBuiltinTools: ["shell"],
      profile: {
        skills: { mode: "legacy-library" },
        learning: { mode: "off" },
        initiative: { enabled: false },
        routing: { enabled: false },
      },
    });
    expect(result).not.toHaveProperty("profile.instructions");
    result.disabledBuiltinTools.push("write");
    expect(bot.disabledBuiltinTools).toEqual(["shell"]);
  });

  it("resolves a stored persona and revision without copying profile instructions", () => {
    const result = resolveEffectiveBotProfile(bot, {
      settings: {
        schemaVersion: 1,
        persona: { persona: "A careful analyst" },
        skills: { mode: "legacy-library" },
        extensions: [],
        learning: { mode: "off", maxReviewsPerDay: 0, maxCandidatesPerReview: 0, maxTokensPerReview: 0, maxReviewSeconds: 0, maxRetries: 0 },
        initiative: { enabled: false, maxRunsPerDay: 0, maxTokensPerRun: 0, maxRunSeconds: 0, maxRetries: 0, maxConcurrentRuns: 0, maxMessagesPerDay: 0 },
        routing: { enabled: false, routes: [] },
      },
      revision: 7,
    });
    expect(result.persona).toBe("A careful analyst");
    expect(result.instructions).toBe(bot.instructions);
    expect(result.profileRevision).toBe(7);
    expect(result.profileProvenance).toBe("stored");
    expect(result.profile.persona).toEqual({ persona: "A careful analyst" });
    expect(result.profile.persona).not.toHaveProperty("instructions");
  });

  it("does not treat a null stored value as a profile revision", () => {
    const result = resolveEffectiveBotProfile(bot, { settings: null, revision: 4 });
    expect(result.profileProvenance).toBe("defaults");
    expect(result.profileRevision).toBeNull();
  });
});
