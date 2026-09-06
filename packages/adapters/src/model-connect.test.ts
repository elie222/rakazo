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
      baseUrl: "https://example.invalid/v1",
      modelId: "qwen3-4b",
      reasoning: false,
      thinkingLevels: ["off"],
    });
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
  it.each(["", "fake-replacement-key"])(
    "honors an explicit key replacement or removal",
    (apiKey) => {
      const saved = parseModelSecret(buildModelConnectPlaintext({ ...input, apiKey }, previous));
      if (apiKey) expect(saved).toHaveProperty("apiKey", apiKey);
      else expect(saved).not.toHaveProperty("apiKey");
    },
  );
  it("revalidates inherited keys against the public-HTTPS policy", () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
    const baseUrl = "http://example.invalid/v1";
    const legacy = serializeModelSecret({ kind: "openai_compatible", baseUrl, apiKey: "fake-key" });
    expect(() => buildModelConnectPlaintext({ ...input, baseUrl }, legacy)).toThrow(/HTTPS/);
  });
});
