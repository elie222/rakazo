import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import { parseModelSecret, serializeModelSecret } from "./pi-oauth.js";

describe("modelCredentialDto", () => {
  it("returns stored baseUrl and modelId for openai-compatible credentials", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
    });
    expect(
      modelCredentialDto(
        {
          id: "cred-1",
          provider: "openai-compatible",
          label: "Local MLX",
          isDefault: true,
          defaultModel: "qwen3-4b",
        },
        plaintext,
      ),
    ).toEqual({
      id: "cred-1",
      provider: "openai-compatible",
      label: "Local MLX",
      hasKey: true,
      isDefault: true,
      supportsImages: false,
      baseUrl: "https://example.invalid/v1",
      modelId: "qwen3-4b",
      reasoning: false,
      thinkingLevels: ["off"],
    });
  });

  it("projects image support for the selected model only", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      visionModelIds: ["vision-model", "another-vision-model"],
    });
    const row = {
      id: "cred-vision",
      provider: "openai-compatible",
      label: "Vision server",
      isDefault: true,
      supportsImages: false,
    };

    expect(modelCredentialDto({ ...row, defaultModel: "vision-model" }, plaintext)).toMatchObject({
      supportsImages: true,
      modelId: "vision-model",
    });
    expect(modelCredentialDto({ ...row, defaultModel: "text-model" }, plaintext)).toMatchObject({
      supportsImages: false,
      modelId: "text-model",
    });
  });

  it("projects the configured image limit for an OpenAI-compatible connection", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      maxImagesPerPrompt: 1,
    });

    expect(
      modelCredentialDto(
        {
          id: "cred-one-image",
          provider: "openai-compatible",
          label: "Single-image server",
          isDefault: true,
          defaultModel: "custom-vision-model",
        },
        plaintext,
      ),
    ).toMatchObject({ maxImagesPerPrompt: 1 });
  });

  it("projects the configured output-token limit for an OpenAI-compatible connection", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      maxTokens: 8192,
    });

    expect(
      modelCredentialDto(
        {
          id: "cred-output-tokens",
          provider: "openai-compatible",
          label: "Reasoning server",
          isDefault: true,
          defaultModel: "qwen-model",
        },
        plaintext,
      ),
    ).toMatchObject({ maxTokens: 8192 });
  });

  it("projects the configured context window for an OpenAI-compatible connection", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      contextWindow: 65536,
    });

    expect(
      modelCredentialDto(
        {
          id: "cred-context-window",
          provider: "openai-compatible",
          label: "Long-context server",
          isDefault: true,
          defaultModel: "qwen-model",
        },
        plaintext,
      ),
    ).toMatchObject({ contextWindow: 65536 });
  });

  it("exposes defaultModel as modelId for provider credentials", () => {
    expect(
      modelCredentialDto({
        id: "cred-2",
        provider: "xai",
        label: "xAI",
        isDefault: false,
        defaultModel: "grok-4.6",
      }),
    ).toEqual({
      id: "cred-2",
      provider: "xai",
      label: "xAI",
      hasKey: true,
      isDefault: false,
      modelId: "grok-4.6",
    });
  });
});

it.each([true, false])(
  "persists generic reasoning capability %s with the connection",
  (reasoning) => {
    const plaintext = buildModelConnectPlaintext({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      reasoning,
    });
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://localhost:8000/v1",
      reasoning,
    });
    expect(
      modelCredentialDto(
        {
          id: "cred",
          provider: "openai-compatible",
          label: "Server",
          isDefault: true,
          defaultModel: "arbitrary-model",
        },
        plaintext,
      ),
    ).toMatchObject({
      reasoning,
      thinkingLevels: reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"],
    });
  },
);

it.each([null, "low", "high"] as const)(
  "round-trips the nullable custom reasoning effort %s",
  (thinkingLevel) => {
    const plaintext = buildModelConnectPlaintext({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      reasoning: true,
      thinkingLevel,
    });
    expect(parseModelSecret(plaintext)).toMatchObject({
      kind: "openai_compatible",
      thinkingLevel,
    });
    expect(
      modelCredentialDto(
        {
          id: "cred",
          provider: "openai-compatible",
          label: "Server",
          isDefault: true,
          defaultModel: "arbitrary-model",
        },
        plaintext,
      ),
    ).toMatchObject({ thinkingLevel });
  },
);

describe("compatible connection updates", () => {
  const input = {
    provider: "openai-compatible",
    modelId: "arbitrary-model",
    baseUrl: "http://localhost:8000/v1",
    reasoning: true,
  };
  const previous = serializeModelSecret({
    kind: "openai_compatible",
    baseUrl: input.baseUrl,
    apiKey: "fake-saved-key",
  });
  afterEach(() => vi.unstubAllEnvs());

  it("preserves a saved key on a capability-only update to the same normalized URL", () => {
    expect(
      parseModelSecret(
        buildModelConnectPlaintext({ ...input, baseUrl: "http://localhost:8000" }, previous),
      ),
    ).toMatchObject({ apiKey: "fake-saved-key", reasoning: true });
  });
  it("does not transfer a saved key to a different endpoint", () => {
    expect(
      parseModelSecret(
        buildModelConnectPlaintext({ ...input, baseUrl: "http://localhost:8001/v1" }, previous),
      ),
    ).not.toHaveProperty("apiKey");
  });

  it("keeps image capability scoped to each explicitly enabled model", () => {
    const vision = buildModelConnectPlaintext({ ...input, supportsImages: true });
    const text = buildModelConnectPlaintext(
      { ...input, modelId: "text-model", supportsImages: false },
      vision,
    );
    const nextVision = buildModelConnectPlaintext(
      { ...input, modelId: "another-vision-model", supportsImages: true },
      text,
    );

    expect(parseModelSecret(text)).toMatchObject({
      visionModelIds: ["arbitrary-model"],
    });
    expect(parseModelSecret(nextVision)).toMatchObject({
      visionModelIds: ["arbitrary-model", "another-vision-model"],
    });
  });
  it("persists the image limit while preserving it on connection updates", () => {
    const configured = buildModelConnectPlaintext({
      ...input,
      maxImagesPerPrompt: 1,
    });
    const updated = buildModelConnectPlaintext({ ...input, reasoning: false }, configured);

    expect(parseModelSecret(configured)).toMatchObject({ maxImagesPerPrompt: 1 });
    expect(parseModelSecret(updated)).toMatchObject({ maxImagesPerPrompt: 1 });
  });
  it("clears a saved image limit when explicitly requested", () => {
    const configured = buildModelConnectPlaintext({
      ...input,
      maxImagesPerPrompt: 1,
    });
    const cleared = buildModelConnectPlaintext(
      {
        ...input,
        maxImagesPerPrompt: null,
      },
      configured,
    );

    expect(parseModelSecret(cleared)).not.toHaveProperty("maxImagesPerPrompt");
  });

  it("persists the output-token limit while preserving it on connection updates", () => {
    const configured = buildModelConnectPlaintext({
      ...input,
      maxTokens: 8192,
    });
    const updated = buildModelConnectPlaintext({ ...input, reasoning: false }, configured);

    expect(parseModelSecret(configured)).toMatchObject({ maxTokens: 8192 });
    expect(parseModelSecret(updated)).toMatchObject({ maxTokens: 8192 });
  });
  it("persists the context window while preserving it on connection updates", () => {
    const configured = buildModelConnectPlaintext({
      ...input,
      contextWindow: 65536,
    });
    const updated = buildModelConnectPlaintext({ ...input, reasoning: false }, configured);

    expect(parseModelSecret(configured)).toMatchObject({ contextWindow: 65536 });
    expect(parseModelSecret(updated)).toMatchObject({ contextWindow: 65536 });
  });
  it.each(["", "fake-replacement-key"])(
    "honors an explicit key replacement or removal",
    (apiKey) => {
      const saved = parseModelSecret(buildModelConnectPlaintext({ ...input, apiKey }, previous));
      if (apiKey) expect(saved).toHaveProperty("apiKey", apiKey);
      else expect(saved).not.toHaveProperty("apiKey");
    },
  );
  it("omits visionModelIds when prior plaintext is unavailable during key replacement", () => {
    const saved = parseModelSecret(
      buildModelConnectPlaintext(
        { ...input, apiKey: "fake-replacement-key", supportsImages: true },
        undefined,
        { omitVisionModelIds: true },
      ),
    );
    expect(saved).toMatchObject({
      kind: "openai_compatible",
      apiKey: "fake-replacement-key",
    });
    expect(saved).not.toHaveProperty("visionModelIds");
  });
  it("preserves multi-model visionModelIds when prior plaintext loads during key replacement", () => {
    const prior = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: input.baseUrl,
      apiKey: "fake-saved-key",
      visionModelIds: ["bot-vision-model", "another-vision-model"],
    });
    const saved = parseModelSecret(
      buildModelConnectPlaintext(
        { ...input, apiKey: "fake-replacement-key", supportsImages: true },
        prior,
      ),
    );
    expect(saved).toMatchObject({
      apiKey: "fake-replacement-key",
      visionModelIds: ["bot-vision-model", "another-vision-model", "arbitrary-model"],
    });
  });
  it("revalidates inherited keys against the public-HTTPS policy", () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
    const baseUrl = "http://example.invalid/v1";
    const legacy = serializeModelSecret({ kind: "openai_compatible", baseUrl, apiKey: "fake-key" });
    expect(() => buildModelConnectPlaintext({ ...input, baseUrl }, legacy)).toThrow(/HTTPS/);
  });
});
