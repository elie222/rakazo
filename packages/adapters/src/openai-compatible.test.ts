import { describe, expect, it } from "vitest";
import {
  errorFromOpenAICompatibleBody,
  extractChatMessageText,
  GATEWAY_PROVIDER_PREFIX,
  isGatewayProvider,
  labelForDiscoveredModels,
  normalizeOpenAICompatibleBaseUrl,
  openaiCompatibleModel,
  parseAvailableModels,
  secretIdForGatewayModel,
  serializeAvailableModels,
  textFromOpenAICompatibleBody,
  unionAvailableModels,
} from "./openai-compatible.js";

describe("openai-compatible gateways", () => {
  it("normalizes hostnames, trailing slashes, and missing protocols", () => {
    expect(normalizeOpenAICompatibleBaseUrl("localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
    expect(normalizeOpenAICompatibleBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("rejects non-http URLs", () => {
    expect(() => normalizeOpenAICompatibleBaseUrl("ftp://example.com")).toThrow(/http/);
  });

  it("round-trips model lists and recognizes gateway provider ids", () => {
    expect(parseAvailableModels("gpt-4o\nllama3, mistral")).toEqual([
      "gpt-4o",
      "llama3",
      "mistral",
    ]);
    expect(serializeAvailableModels(["gpt-4o", "gpt-4o", "llama3"])).toBe("gpt-4o\nllama3");
    expect(isGatewayProvider(`${GATEWAY_PROVIDER_PREFIX}abc`)).toBe(true);
    expect(isGatewayProvider("openai-compatible")).toBe(true);
    expect(isGatewayProvider("openrouter")).toBe(false);
  });

  it("does not require streamed finish_reason on custom endpoints", () => {
    const model = openaiCompatibleModel(
      `${GATEWAY_PROVIDER_PREFIX}abc`,
      "gemini-2.5-flash",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(model.compat).toMatchObject({
      supportsFinishReason: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    });
    expect(model.reasoning).toBe(false);
  });

  it("picks the key whose discovered models include the requested model", () => {
    const credential = {
      secretId: "active-secret",
      keys: [
        {
          secretId: "gemini-secret",
          isActive: false,
          availableModels: "gemini-2.5-pro\ngemini-2.5-flash",
        },
        {
          secretId: "active-secret",
          isActive: true,
          availableModels: "gpt-4o\no4-mini",
        },
      ],
    };
    expect(secretIdForGatewayModel(credential, "gemini-2.5-flash")).toBe("gemini-secret");
    expect(secretIdForGatewayModel(credential, "gpt-4o")).toBe("active-secret");
    expect(secretIdForGatewayModel(credential, "unknown-model")).toBe("active-secret");
    expect(secretIdForGatewayModel(credential, undefined)).toBe("active-secret");
    expect(unionAvailableModels(credential.keys)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gpt-4o",
      "o4-mini",
    ]);
    expect(labelForDiscoveredModels(["gemini-2.5-pro", "gemini-2.0-flash"])).toBe("Gemini");
    expect(labelForDiscoveredModels(["gpt-4o", "gpt-4.1"])).toBe("GPT");
    expect(labelForDiscoveredModels(["o4-mini"])).toBe("OpenAI");
    expect(labelForDiscoveredModels(["gemini-2.5-pro", "gpt-4o"])).toBe("API key");
  });

  it("reads string, array, and SSE chat completion bodies", () => {
    expect(
      extractChatMessageText({
        choices: [{ message: { content: "Hello from JSON" } }],
      }),
    ).toBe("Hello from JSON");
    expect(
      extractChatMessageText({
        choices: [
          {
            delta: {
              content: [
                { type: "text", text: "Hel" },
                { type: "text", text: "lo" },
              ],
            },
          },
        ],
      }),
    ).toBe("Hello");
    expect(
      textFromOpenAICompatibleBody(
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\ndata: [DONE]\n',
        "text/event-stream",
      ),
    ).toBe("Hi");
  });

  it("surfaces the gateway error body, not a generic status", () => {
    expect(
      errorFromOpenAICompatibleBody(
        JSON.stringify({
          error: { message: "Invalid API key provided", type: "invalid_request_error" },
        }),
        401,
      ),
    ).toBe("401: Invalid API key provided");
    expect(
      errorFromOpenAICompatibleBody(
        JSON.stringify({
          error: { errors: [{ message: "Model gemini-2.5-pro is not found" }] },
        }),
        404,
      ),
    ).toBe("404: Model gemini-2.5-pro is not found");
    expect(errorFromOpenAICompatibleBody("upstream refused the stream", 502)).toBe(
      "502: upstream refused the stream",
    );
    expect(errorFromOpenAICompatibleBody('{"choices":[{"message":{"content":""}}]}', 200)).toBe(
      "The gateway returned an empty reply",
    );
  });
});
