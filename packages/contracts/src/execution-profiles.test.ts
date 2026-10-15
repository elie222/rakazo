import { describe, expect, it } from "vitest";
import {
  CreateExecutionProfileInput,
  EXECUTION_HARNESS_PROTOCOLS,
  EXECUTION_HARNESS_VERSIONS,
  ExecutionProfileSnapshotSchema,
  executionProfileMediaCapabilities,
  runExecutionProfileSummary,
  supportedExecutionInputModalities,
} from "./execution-profiles.js";

const input = {
  name: "Coding",
  harness: "claude",
  provider: "anthropic",
  credentialId: "account-a",
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  modelId: "test-model",
  runtimeVersion: "0.3.300",
  computerId: null,
};

describe("execution profile contract", () => {
  it("defaults old profiles to no declared native media", () => {
    const profile = CreateExecutionProfileInput.parse(input);
    expect(profile.inputModalities).toEqual([]);
    expect(executionProfileMediaCapabilities(profile)).toEqual({
      imageInput: false,
      audioInput: false,
    });
  });

  it.each(["claude", "codex", "kimi"] as const)(
    "requires model-scoped image support for %s",
    (harness) => {
      const profile = CreateExecutionProfileInput.parse({
        ...input,
        harness,
        protocol: EXECUTION_HARNESS_PROTOCOLS[harness][0],
        runtimeVersion: EXECUTION_HARNESS_VERSIONS[harness],
        inputModalities: ["image"],
      });
      expect(executionProfileMediaCapabilities(profile).imageInput).toBe(true);
      expect(
        executionProfileMediaCapabilities({ ...profile, inputModalities: [] }).imageInput,
      ).toBe(false);
      expect(
        supportedExecutionInputModalities({ ...profile, runtimeVersion: "unsupported" }),
      ).toEqual([]);
    },
  );

  it.each(["pi", "claude", "kimi"] as const)("rejects native uploaded audio on %s", (harness) => {
    expect(
      CreateExecutionProfileInput.safeParse({
        ...input,
        harness,
        protocol: EXECUTION_HARNESS_PROTOCOLS[harness][0],
        runtimeVersion: EXECUTION_HARNESS_VERSIONS[harness],
        inputModalities: ["audio"],
      }).success,
    ).toBe(false);
  });

  it("allows declared Codex audio only for an explicit compatible Responses endpoint", () => {
    const codex = {
      ...input,
      harness: "codex",
      protocol: "openai-responses",
      runtimeVersion: EXECUTION_HARNESS_VERSIONS.codex,
      inputModalities: ["audio"],
    };
    for (const endpoint of [
      null,
      "https://api.openai.com/v1",
      "https://API.OPENAI.COM./v1",
      "https://chatgpt.com/backend-api/codex",
      "https://custom.openai.com/v1",
    ]) {
      expect(
        CreateExecutionProfileInput.safeParse({ ...codex, provider: "alias", endpoint }).success,
      ).toBe(false);
    }
    const profile = CreateExecutionProfileInput.parse({
      ...codex,
      endpoint: "https://api.example.test/v1",
    });
    expect(executionProfileMediaCapabilities(profile)).toEqual({
      imageInput: false,
      audioInput: true,
    });
    expect(
      CreateExecutionProfileInput.safeParse({ ...profile, inputModalities: ["audio", "audio"] })
        .success,
    ).toBe(false);
  });

  it("requires an explicit new Kimi revision instead of upgrading a legacy profile", () => {
    expect(EXECUTION_HARNESS_VERSIONS.kimi).toBe("2.2.0");
    expect(
      CreateExecutionProfileInput.safeParse({
        ...input,
        harness: "kimi",
        protocol: "openai-chat-completions",
        runtimeVersion: "1.51.0",
      }).success,
    ).toBe(false);
  });
  it("requires an explicit account and runtime version", () => {
    expect(CreateExecutionProfileInput.safeParse(input).success).toBe(true);
    expect(
      CreateExecutionProfileInput.safeParse({ ...input, credentialId: undefined }).success,
    ).toBe(false);
    expect(
      CreateExecutionProfileInput.safeParse({ ...input, runtimeVersion: undefined }).success,
    ).toBe(false);
  });

  it("shares a protocol matrix and rejects incompatible harness protocols", () => {
    for (const [harness, protocols] of Object.entries(EXECUTION_HARNESS_PROTOCOLS)) {
      for (const protocol of ["anthropic", "openai-responses", "openai-chat-completions"]) {
        expect(
          CreateExecutionProfileInput.safeParse({
            ...input,
            harness,
            protocol,
            runtimeVersion:
              EXECUTION_HARNESS_VERSIONS[harness as keyof typeof EXECUTION_HARNESS_VERSIONS],
          }).success,
        ).toBe((protocols as readonly string[]).includes(protocol));
      }
    }
  });

  it("requires explicit routing for native harnesses", () => {
    expect(CreateExecutionProfileInput.safeParse({ ...input, endpoint: null }).success).toBe(false);
    expect(
      CreateExecutionProfileInput.safeParse({
        ...input,
        harness: "pi",
        runtimeVersion: EXECUTION_HARNESS_VERSIONS.pi,
        endpoint: null,
      }).success,
    ).toBe(true);
  });

  it("rejects credential-bearing or non-HTTP endpoint URLs", () => {
    for (const endpoint of [
      "file:///tmp/key",
      "https://user:password@example.test",
      "https://example.test?api_key=secret",
      "https://example.test/#secret",
    ]) {
      expect(CreateExecutionProfileInput.safeParse({ ...input, endpoint }).success).toBe(false);
    }
  });

  it("pins secret identity but strips all credential values", () => {
    const snapshot = ExecutionProfileSnapshotSchema.parse({
      ...input,
      profileId: "profile",
      revision: 1,
      spaceId: "space",
      userId: "user",
      credentialSecretId: "secret-id",
      apiKey: "fake-value",
      ciphertext: "fake-ciphertext",
    });
    expect(snapshot).not.toHaveProperty("apiKey");
    expect(snapshot).not.toHaveProperty("ciphertext");
  });
});

it("publishes pinned attribution without exposing internal scope or secret references", () => {
  const summary = runExecutionProfileSummary({
    ...input,
    profileId: "profile-1",
    profileName: "Original name",
    credentialLabel: "Original account label",
    revision: 1,
    spaceId: "private-space",
    userId: "private-user",
    credentialSecretId: "private-secret-id",
  });
  expect(summary).toEqual({
    id: "profile-1",
    name: "Original name",
    revision: 1,
    harness: "claude",
    provider: "anthropic",
    modelId: "test-model",
    accountLabel: "Original account label",
  });
  expect(JSON.stringify(summary)).not.toContain("private-");
  expect(summary).not.toHaveProperty("credentialId");
});

describe("immutable Claude connection settings", () => {
  it("defaults historical profiles to API-key auth and no role overrides", () => {
    expect(CreateExecutionProfileInput.parse(input)).toMatchObject({
      authScheme: "api-key",
      modelRoles: {},
    });
  });
  it("accepts allowlisted role names and documented model identifiers", () => {
    const profile = CreateExecutionProfileInput.parse({
      ...input,
      authScheme: "bearer",
      modelRoles: { haiku: " glm-5.3[1m] ", subagent: "namespace/model" },
    });
    expect(profile.modelRoles).toEqual({ haiku: "glm-5.3[1m]", subagent: "namespace/model" });
  });
  it.each([
    { shell: "model" },
    { haiku: "model\nHOST_SECRET=x" },
    { opus: "" },
    { sonnet: "x".repeat(201) },
  ])("rejects malformed roles %j", (modelRoles) => {
    expect(CreateExecutionProfileInput.safeParse({ ...input, modelRoles }).success).toBe(false);
  });
  it.each(["pi", "codex", "kimi"] as const)("rejects Claude-only settings on %s", (harness) => {
    const profile = {
      ...input,
      harness,
      protocol: EXECUTION_HARNESS_PROTOCOLS[harness][0],
      runtimeVersion: EXECUTION_HARNESS_VERSIONS[harness],
    };
    expect(
      CreateExecutionProfileInput.safeParse({ ...profile, authScheme: "bearer" }).success,
    ).toBe(false);
    expect(
      CreateExecutionProfileInput.safeParse({ ...profile, modelRoles: { opus: "model" } }).success,
    ).toBe(false);
  });
});
