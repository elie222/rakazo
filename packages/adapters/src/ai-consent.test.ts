import { afterEach, describe, expect, it, vi } from "vitest";
import { aiRecipient } from "./ai-consent.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("mobile AI recipient disclosure", () => {
  it("identifies both gateways without querying or changing their routing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const provider of ["openrouter", "vercel-ai-gateway"]) {
      const recipient = aiRecipient({ provider, use: "model", modelId: "any/model" });
      expect(recipient?.detail).toBe("any/model, forwarded to its provider");
      expect(aiRecipient({ provider, use: "model" })?.detail).toBe("Forwards to model providers");
      expect(recipient?.privacyUrl).toBeTruthy();
      expect(recipient).not.toHaveProperty("payloadFields");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses only the model ID for direct providers", () => {
    expect(
      aiRecipient({ provider: "openai", use: "model", modelId: "example-model" })?.detail,
    ).toBe("example-model");
    expect(aiRecipient({ provider: "openai", use: "model" })?.detail).toBe("");
  });
  it("supports custom endpoints without exposing secrets or inventing a provider policy", () => {
    const recipient = aiRecipient({
      provider: "openai-compatible",
      use: "model",
      baseUrl: "https://user:password@example.com/private?token=secret",
    })!;
    expect(recipient.name).toContain("https://example.com");
    expect(JSON.stringify(recipient)).not.toMatch(/password|private|token|secret/);
    expect(recipient.privacyUrl).toBeUndefined();
    expect(
      aiRecipient({
        provider: "openai-compatible",
        use: "model",
        baseUrl: "https://example.com/other",
      })?.key,
    ).not.toBe(recipient.key);
  });
  it("names the voice server and requires fresh consent when its endpoint changes", () => {
    vi.stubEnv("RAKAZO_VOICE_OPENAI_COMPAT_BASE_URL", "http://127.0.0.1:3900/private?token=secret");
    const recipient = aiRecipient({ provider: "openai-compatible", use: "voice" })!;
    expect(recipient.name).toBe("OpenAI-compatible (http://127.0.0.1:3900)");
    expect(JSON.stringify(recipient)).not.toMatch(/private|token|secret/);
    expect(recipient.privacyUrl).toBeUndefined();
    vi.stubEnv("RAKAZO_VOICE_OPENAI_COMPAT_BASE_URL", "http://127.0.0.1:4000");
    expect(aiRecipient({ provider: "openai-compatible", use: "voice" })?.key).not.toBe(
      recipient.key,
    );
    vi.stubEnv("RAKAZO_VOICE_OPENAI_COMPAT_BASE_URL", "http://127.0.0.1:3900/other");
    expect(aiRecipient({ provider: "openai-compatible", use: "voice" })?.key).not.toBe(
      recipient.key,
    );
  });
  it.each(["", "not a URL", "ftp://127.0.0.1", "https://user:password@example.com"])(
    "omits an unusable voice server without breaking other disclosures (%s)",
    (url) => {
      vi.stubEnv("RAKAZO_VOICE_OPENAI_COMPAT_BASE_URL", url);
      expect(aiRecipient({ provider: "openai-compatible", use: "voice" })).toBeNull();
      expect(aiRecipient({ provider: "openai", use: "voice" })?.name).toBe("OpenAI");
    },
  );
  it("supports local models without a hosted dependency", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      aiRecipient({ provider: "local", use: "model", baseUrl: "http://127.0.0.1:11434/v1" })?.name,
    ).toContain("http://127.0.0.1:11434");
    expect(fetch).not.toHaveBeenCalled();
  });
});
