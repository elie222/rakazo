import { describe, expect, it, vi } from "vitest";
import {
  catalogProviderProbeBaseUrl,
  classifyModelConnectionFailure,
  runModelConnectionPreflight,
  sanitizeModelConnectionError,
} from "./model-connection-preflight.js";

describe("sanitizeModelConnectionError", () => {
  it("redacts api key patterns", () => {
    expect(sanitizeModelConnectionError("Invalid sk-secretkey1234567890")).not.toContain(
      "sk-secretkey1234567890",
    );
  });
});

describe("classifyModelConnectionFailure", () => {
  it("detects rate limits and timeouts", () => {
    expect(classifyModelConnectionFailure(new Error("429 rate limit")).outcome).toBe("rate_limit");
    expect(classifyModelConnectionFailure(new Error("probe timed out")).outcome).toBe("timeout");
  });
});

describe("runModelConnectionPreflight", () => {
  it("probes catalog providers with api keys", async () => {
    const probe = vi.fn().mockResolvedValue({ models: ["gpt-test"] });
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
      modelId: "gpt-test",
      probe,
    });
    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledWith({
      baseUrl: catalogProviderProbeBaseUrl("openrouter"),
      apiKey: "sk-test-key-12345678",
    });
  });

  it("reports oauth when not connected", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "openai-codex",
      oauthConnected: false,
      probe: vi.fn(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.outcome).toBe("needs_sign_in");
  });
});
