import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
} from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import { parseModelSecret, serializeModelSecret } from "./pi-oauth.js";

describe("built-in provider output limits", () => {
  const row = {
    id: "cred-builtin",
    provider: "anthropic",
    label: "Anthropic",
    isDefault: true,
  };

  it("stores an output-token limit with an API key", () => {
    const plaintext = buildModelConnectPlaintext({
      provider: "anthropic",
      apiKey: "sk-test-key",
      maxTokens: 16384,
    });
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "api_key",
      key: "sk-test-key",
      maxTokens: 16384,
    });
    expect(modelCredentialDto(row, plaintext)).toMatchObject({
      maxTokens: 16384,
      hasKey: true,
      authKind: "api_key",
    });
    expect(JSON.stringify(modelCredentialDto(row, plaintext))).not.toContain("sk-test-key");
  });

  it("keeps a raw API key when no limit is configured", () => {
    expect(
      buildModelConnectPlaintext({
        provider: "anthropic",
        apiKey: "sk-test-key",
      }),
    ).toBe("sk-test-key");
  });

  it("updates the limit without replacing the key", () => {
    const previous = buildModelConnectPlaintext({
      provider: "anthropic",
      apiKey: "sk-test-key",
      maxTokens: 8192,
    });
    const updated = buildModelConnectPlaintext(
      { provider: "anthropic", maxTokens: 16384 },
      previous,
    );
    expect(parseModelSecret(updated)).toEqual({
      kind: "api_key",
      key: "sk-test-key",
      maxTokens: 16384,
    });
  });

  it("validates an output-only update against the saved context window", () => {
    const previous = buildModelConnectPlaintext({
      provider: "openrouter",
      apiKey: "fake-api-key",
      contextWindow: 16_384,
      maxTokens: 4096,
    });
    expect(() =>
      buildModelConnectPlaintext({ provider: "openrouter", maxTokens: 20_000 }, previous),
    ).toThrow("Maximum output tokens must leave room for input");
    expect(
      parseModelSecret(
        buildModelConnectPlaintext({ provider: "openrouter", maxTokens: 12_288 }, previous),
      ),
    ).toMatchObject({ contextWindow: 16_384, maxTokens: 12_288 });
  });

  it("validates a context-only update against the saved output limit", () => {
    const previous = buildModelConnectPlaintext({
      provider: "openrouter",
      apiKey: "fake-api-key",
      contextWindow: 32_768,
      maxTokens: 8192,
    });
    expect(() =>
      buildModelConnectPlaintext({ provider: "openrouter", contextWindow: 4096 }, previous),
    ).toThrow("Maximum output tokens must leave room for input");
  });

  it("clears the limit without replacing the key", () => {
    const previous = buildModelConnectPlaintext({
      provider: "anthropic",
      apiKey: "sk-test-key",
      maxTokens: 8192,
    });
    expect(buildModelConnectPlaintext({ provider: "anthropic", maxTokens: null }, previous)).toBe(
      "sk-test-key",
    );
  });

  it("preserves the limit when a replacement key omits it", () => {
    const previous = buildModelConnectPlaintext({
      provider: "anthropic",
      apiKey: "sk-test-key",
      maxTokens: 8192,
    });
    expect(
      parseModelSecret(
        buildModelConnectPlaintext({ provider: "anthropic", apiKey: "sk-new-key-value" }, previous),
      ),
    ).toEqual({ kind: "api_key", key: "sk-new-key-value", maxTokens: 8192 });
  });

  it("updates an OAuth connection limit without dropping the credential", () => {
    const credential = {
      type: "oauth" as const,
      access: "access",
      refresh: "refresh",
      expires: 10,
    };
    const previous = serializeModelSecret({ kind: "oauth", credential });
    expect(
      parseModelSecret(
        buildModelConnectPlaintext({ provider: "openai-codex", maxTokens: 8192 }, previous),
      ),
    ).toEqual({ kind: "oauth", credential, maxTokens: 8192 });
    expect(
      modelCredentialDto(
        {
          id: "cred-oauth",
          provider: "openai-codex",
          label: "ChatGPT",
          isDefault: false,
        },
        previous,
      ).authKind,
    ).toBe("oauth");
  });

  it("rejects a limit update when no credential exists", () => {
    expect(() => buildModelConnectPlaintext({ provider: "anthropic", maxTokens: 8192 })).toThrow(
      /API key/,
    );
  });
});

describe("openai-codex API key guard", () => {
  const codexOauth = serializeModelSecret({
    kind: "oauth",
    credential: { type: "oauth", access: "access", refresh: "refresh", expires: 10 },
  });

  it("rejects an API key because the Codex transport needs the sign-in JWT", () => {
    expect(() =>
      buildModelConnectPlaintext({ provider: "openai-codex", apiKey: "sk-test-key-123" }),
    ).toThrow(/ChatGPT subscription sign-in is required/);
  });

  it("rejects replacing a ChatGPT sign-in with an API key", () => {
    expect(() =>
      buildModelConnectPlaintext(
        { provider: "openai-codex", apiKey: "sk-test-key-123" },
        codexOauth,
      ),
    ).toThrow(/ChatGPT subscription sign-in is required/);
  });

  it("points a keyless first connect at subscription sign-in instead of asking for a key", () => {
    expect(() => buildModelConnectPlaintext({ provider: "openai-codex", maxTokens: 8192 })).toThrow(
      /ChatGPT subscription sign-in is required/,
    );
  });

  it("rejects re-saving a legacy stored API key on a keyless connect", () => {
    const legacyKey = buildModelConnectPlaintext({
      provider: "anthropic",
      apiKey: "sk-legacy-key",
    });
    expect(() =>
      buildModelConnectPlaintext({ provider: "openai-codex", maxTokens: 8192 }, legacyKey),
    ).toThrow(/ChatGPT subscription sign-in is required/);
  });

  it("carries a previous ChatGPT sign-in forward when only the output limit changes", () => {
    expect(
      parseModelSecret(
        buildModelConnectPlaintext({ provider: "openai-codex", maxTokens: 8192 }, codexOauth),
      ),
    ).toEqual({
      kind: "oauth",
      credential: { type: "oauth", access: "access", refresh: "refresh", expires: 10 },
      maxTokens: 8192,
    });
  });

  it("keeps other providers' API keys working", () => {
    expect(buildModelConnectPlaintext({ provider: "anthropic", apiKey: "sk-test-key-123" })).toBe(
      "sk-test-key-123",
    );
    expect(
      buildModelConnectPlaintext({
        provider: "openai",
        apiKey: "sk-test-key-123",
        accountId: "acct1234",
        gatewayId: "gateway-1",
      }),
    ).toBe("sk-test-key-123");
  });

  it("stores Cloudflare AI Gateway routing with the key and keeps it on a limit update", () => {
    const input = {
      provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
      apiKey: "cf-test-key-value",
      accountId: "acct1234",
      gatewayId: "gateway-1",
    };
    const plaintext = buildModelConnectPlaintext(input);
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "api_key",
      key: "cf-test-key-value",
      accountId: "acct1234",
      gatewayId: "gateway-1",
    });
    expect(
      parseModelSecret(
        buildModelConnectPlaintext(
          { provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID, maxTokens: 4096 },
          plaintext,
        ),
      ),
    ).toEqual({
      kind: "api_key",
      key: "cf-test-key-value",
      maxTokens: 4096,
      accountId: "acct1234",
      gatewayId: "gateway-1",
    });
    expect(
      modelCredentialDto(
        {
          id: "cred-cf",
          provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
          label: "Cloudflare AI Gateway",
          isDefault: false,
        },
        plaintext,
      ),
    ).toMatchObject({ accountId: "acct1234", gatewayId: "gateway-1" });
    expect(() =>
      buildModelConnectPlaintext({
        provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
        apiKey: "cf-test-key-value",
      }),
    ).toThrow(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
    expect(
      parseModelSecret(
        buildModelConnectPlaintext(
          { provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID, accountId: "acct9999" },
          plaintext,
        ),
      ),
    ).toEqual({
      kind: "api_key",
      key: "cf-test-key-value",
      accountId: "acct9999",
      gatewayId: "gateway-1",
    });
    expect(
      parseModelSecret(
        buildModelConnectPlaintext(
          { provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID, gatewayId: "gateway-2" },
          plaintext,
        ),
      ),
    ).toEqual({
      kind: "api_key",
      key: "cf-test-key-value",
      accountId: "acct1234",
      gatewayId: "gateway-2",
    });
    expect(() =>
      buildModelConnectPlaintext(
        { provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID, accountId: "acct/secret" },
        plaintext,
      ),
    ).toThrow(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
  });
});

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
      hasKey: false,
      isDefault: true,
      supportsImages: false,
      authKind: "openai_compatible",
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

  it("reports a stored API key without returning the secret", () => {
    const deepseek = buildModelConnectPlaintext({
      provider: "deepseek",
      apiKey: "sk-deepseek-test",
    });
    const row = {
      id: "cred-deepseek",
      provider: "deepseek",
      label: "DeepSeek",
      isDefault: true,
      defaultModel: "deepseek-chat",
    };
    expect(modelCredentialDto(row, deepseek)).toMatchObject({ hasKey: true });
    expect(JSON.stringify(modelCredentialDto(row, deepseek))).not.toContain("sk-deepseek-test");

    const compatible = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek-test",
    });
    const compatibleDto = modelCredentialDto({ ...row, provider: "openai-compatible" }, compatible);
    expect(compatibleDto.hasKey).toBe(true);
    expect(JSON.stringify(compatibleDto)).not.toContain("sk-deepseek-test");

    const keyless = buildModelConnectPlaintext({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local-model",
    });
    expect(
      modelCredentialDto(
        { ...row, provider: "openai-compatible", defaultModel: "local-model" },
        keyless,
      ).hasKey,
    ).toBe(false);

    const oauth = serializeModelSecret({
      kind: "oauth",
      credential: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 10 },
    });
    expect(modelCredentialDto({ ...row, provider: "openai-codex" }, oauth).hasKey).toBe(false);
    expect(modelCredentialDto(row).hasKey).toBe(false);
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
      hasKey: false,
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
