import { describe, expect, it } from "vitest";
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
