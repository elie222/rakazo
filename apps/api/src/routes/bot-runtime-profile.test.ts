import { ORPCError } from "@orpc/server";
import { BotRuntimeProfile } from "@rakazo/contracts";
import { BotRuntimeProfileConflictError, IsolationError } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  botProfileDraftOnlyProblem,
  mapBotRuntimeProfileError,
  validateBotRuntimeProfileDraft,
} from "./bot-runtime-profile.js";

const digest = `sha256:${"a".repeat(64)}`;
const defaults = () => BotRuntimeProfile.parse({});

describe("partial bot runtime profile API guard", () => {
  it("accepts inert settings for persistence", () => {
    expect(botProfileDraftOnlyProblem(defaults())).toBeUndefined();
    expect(validateBotRuntimeProfileDraft({ settings: defaults() })).toEqual({
      valid: true,
      activationStatus: "partial",
      supportedCapabilities: ["persona"],
      issues: [],
    });
  });

  it.each([
    ["extension assignment", () => ({ ...defaults(), extensions: [{ extensionId: "calendar", version: "1", digest, settings: {} }] })],
    ["explicit skills", () => ({ ...defaults(), skills: { mode: "explicit", skillIds: ["research"] } })],
    ["learning", () => ({ ...defaults(), learning: { ...defaults().learning, mode: "proposals-only", maxReviewsPerDay: 1, maxCandidatesPerReview: 1, maxTokensPerReview: 100, maxReviewSeconds: 60 } })],
    ["initiative", () => ({ ...defaults(), initiative: { ...defaults().initiative, enabled: true, maxRunsPerDay: 1, maxTokensPerRun: 100, maxRunSeconds: 60, maxConcurrentRuns: 1 } })],
    ["routing", () => ({ ...defaults(), routing: { enabled: true, routes: [{ label: "fast", modelRef: "model-a", effort: "low", execution: "inline" }] } })],
  ])("rejects %s activation", (_name, createSettings) => {
    const settings = (createSettings as () => ReturnType<typeof defaults>)();
    expect(botProfileDraftOnlyProblem(settings)).toEqual(expect.any(String));
    expect(validateBotRuntimeProfileDraft({ settings }).activationStatus).toBe("partial");
  });

  it("allows persona activation and reports only partial support", () => {
    const settings = { ...defaults(), persona: { persona: "A persona" } };
    expect(botProfileDraftOnlyProblem(settings)).toBeUndefined();
    expect(validateBotRuntimeProfileDraft({ settings })).toEqual({
      valid: true,
      activationStatus: "partial",
      supportedCapabilities: ["persona"],
      issues: [],
    });
  });

  it("maps stale revisions and scoped access failures to API errors", () => {
    expect(() => mapBotRuntimeProfileError(new BotRuntimeProfileConflictError())).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(() => mapBotRuntimeProfileError(new IsolationError())).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(ORPCError).toBeDefined();
  });

  it("reports structural schema errors without throwing", () => {
    const result = validateBotRuntimeProfileDraft({ settings: { schemaVersion: 4 } });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});
