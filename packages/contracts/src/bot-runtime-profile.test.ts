import { describe, expect, it } from "vitest";
import {
  BotRuntimeExtensionReference,
  BotRuntimeProfile,
  BotRuntimeRouteReference,
} from "./bot-runtime-profile.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("bot runtime profile contracts", () => {
  it("provides safe defaults with opt-in capabilities disabled", () => {
    expect(BotRuntimeProfile.parse({})).toEqual({
      schemaVersion: 1,
      persona: { persona: "" },
      skills: { mode: "legacy-library" },
      extensions: [],
      learning: {
        mode: "off",
        maxReviewsPerDay: 0,
        maxCandidatesPerReview: 0,
        maxTokensPerReview: 0,
        maxReviewSeconds: 0,
        maxRetries: 0,
      },
      initiative: {
        enabled: false,
        maxRunsPerDay: 0,
        maxTokensPerRun: 0,
        maxRunSeconds: 0,
        maxRetries: 0,
        maxConcurrentRuns: 0,
        maxMessagesPerDay: 0,
      },
      routing: { enabled: false, routes: [] },
    });
  });

  it("keeps persona and operational instructions separate", () => {
    expect(
      BotRuntimeProfile.parse({
        persona: { persona: "A careful guide" },
      }).persona,
    ).toEqual({ persona: "A careful guide" });
    expect(
      BotRuntimeProfile.safeParse({ persona: { instructions: "Duplicate authority" } }).success,
    ).toBe(false);
    expect(BotRuntimeProfile.safeParse({ persona: { soul: "combined" } }).success).toBe(false);
  });

  it("accepts only the two skill selection modes and unique explicit IDs", () => {
    expect(
      BotRuntimeProfile.safeParse({ skills: { mode: "explicit", skillIds: ["a", "b"] } }).success,
    ).toBe(true);
    expect(
      BotRuntimeProfile.safeParse({ skills: { mode: "explicit", skillIds: ["a", "a"] } }).success,
    ).toBe(false);
    expect(BotRuntimeProfile.safeParse({ skills: { mode: "all" } }).success).toBe(false);
  });

  it("requires an immutable digest and rejects secret-like extension settings", () => {
    expect(
      BotRuntimeExtensionReference.safeParse({
        extensionId: "calendar",
        version: "1.0.0",
        digest,
        settings: { timezone: "UTC" },
      }).success,
    ).toBe(true);
    expect(
      BotRuntimeExtensionReference.safeParse({
        extensionId: "calendar",
        version: "1.0.0",
        digest: "latest",
      }).success,
    ).toBe(false);
    expect(
      BotRuntimeExtensionReference.safeParse({
        extensionId: "calendar",
        version: "1.0.0",
        digest,
        settings: { apiToken: "not-allowed" },
      }).success,
    ).toBe(false);
    expect(
      BotRuntimeExtensionReference.safeParse({
        extensionId: "calendar",
        version: "1.0.0",
        digest,
        command: "run",
      }).success,
    ).toBe(false);
  });

  it("rejects deeply nested extension settings with a bounded schema", () => {
    let nested: unknown = "value";
    for (let index = 0; index < 30; index += 1) nested = { nested };
    expect(
      BotRuntimeExtensionReference.safeParse({
        extensionId: "calendar",
        version: "1.0.0",
        digest,
        settings: { nested },
      }).success,
    ).toBe(false);
  });

  it("requires finite nonnegative learning and initiative budgets", () => {
    expect(
      BotRuntimeProfile.safeParse({ learning: { mode: "automatic-private", maxReviewsPerDay: 2 } })
        .success,
    ).toBe(false);
    expect(
      BotRuntimeProfile.safeParse({
        learning: {
          mode: "automatic-private",
          maxReviewsPerDay: 2,
          maxCandidatesPerReview: 3,
          maxTokensPerReview: 2000,
          maxReviewSeconds: 60,
        },
      }).success,
    ).toBe(true);
    expect(BotRuntimeProfile.safeParse({ initiative: { enabled: true } }).success).toBe(false);
    expect(BotRuntimeProfile.safeParse({ routing: { enabled: true } }).success).toBe(false);
    expect(
      BotRuntimeProfile.safeParse({
        learning: { mode: "automatic-private", maxTokensPerReview: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
    expect(
      BotRuntimeProfile.safeParse({ initiative: { enabled: true, maxRunsPerDay: -1 } }).success,
    ).toBe(false);
  });

  it("accepts fixed-label route references and rejects arbitrary labels or extra fields", () => {
    expect(
      BotRuntimeRouteReference.safeParse({
        label: "fast",
        modelRef: "model-1",
        effort: "low",
        execution: "inline",
      }).success,
    ).toBe(true);
    expect(
      BotRuntimeRouteReference.safeParse({
        label: "fast",
        modelRef: "model-1",
        effort: "low",
        execution: "inline",
        endpoint: "https://example.test",
      }).success,
    ).toBe(false);
    expect(
      BotRuntimeProfile.safeParse({
        routing: {
          enabled: true,
          routes: [
            { label: "fast", modelRef: "model-1", effort: "low", execution: "inline" },
            { label: "fast", modelRef: "model-2", effort: "high", execution: "background" },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
