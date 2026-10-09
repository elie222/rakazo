import { describe, expect, it, vi } from "vitest";
import {
  classifyModelConnectionFailure,
  loadStoredModelAuth,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
  sanitizeModelConnectionError,
  unavailableSelectedModel,
} from "./model-connection-preflight.js";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  plural: (value: number, forms: { one: string; other: string }) =>
    (value === 1 ? forms.one : forms.other).replaceAll("#", String(value)),
}));

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
    expect(classifyModelConnectionFailure(new Error("The operation was aborted")).outcome).toBe(
      "unknown",
    );
  });

  it("keeps manual model entry for custom servers and catalog picks for catalog providers", () => {
    expect(unavailableSelectedModel("gpt-missing", ["gpt-test"])?.nextAction).toMatch(
      /enter a model id/,
    );
    expect(
      unavailableSelectedModel("gpt-missing", ["gpt-test"], { manualEntry: false })?.nextAction,
    ).toBe("Pick a model from the catalog.");
  });
});

describe("unavailableSelectedModel", () => {
  it("fails only when a non-empty list omits the selected id", () => {
    expect(unavailableSelectedModel("gpt-missing", ["gpt-test"])?.outcome).toBe(
      "unavailable_model",
    );
    expect(unavailableSelectedModel("gpt-test", ["gpt-test"])).toBeNull();
    expect(unavailableSelectedModel("", ["gpt-test"])).toBeNull();
    expect(unavailableSelectedModel("gpt-missing", [])).toBeNull();
  });
});

describe("loadStoredModelAuth", () => {
  it("keeps lookup failures distinct from a missing credential", async () => {
    await expect(loadStoredModelAuth("anthropic", async () => [])).resolves.toEqual({
      storedAuthKind: null,
      credentialLookupFailed: false,
      credentialUnreadable: false,
    });
    await expect(
      loadStoredModelAuth("anthropic", async () => {
        throw new Error("offline");
      }),
    ).resolves.toEqual({
      storedAuthKind: null,
      credentialLookupFailed: true,
      credentialUnreadable: false,
    });
  });

  it("reads the stored kind and flags a row whose kind is missing", async () => {
    await expect(
      loadStoredModelAuth("anthropic", async () => [
        { provider: "openai", authKind: "oauth" },
        { provider: "anthropic", authKind: "api_key" },
      ]),
    ).resolves.toMatchObject({ storedAuthKind: "api_key", credentialUnreadable: false });
    await expect(
      loadStoredModelAuth("anthropic", async () => [{ provider: "anthropic" }]),
    ).resolves.toMatchObject({ storedAuthKind: null, credentialUnreadable: true });
  });

  it("uses the credential that owns the selected model, not the newest provider row", async () => {
    const credentials = async () => [
      { provider: "anthropic", authKind: "oauth" as const, modelId: "claude-new" },
      {
        provider: "anthropic",
        authKind: "api_key" as const,
        modelId: "claude-saved",
        isDefault: true,
      },
    ];
    await expect(
      loadStoredModelAuth("anthropic", credentials, "claude-saved"),
    ).resolves.toMatchObject({ storedAuthKind: "api_key", credentialUnreadable: false });
    await expect(
      loadStoredModelAuth("anthropic", credentials, "claude-new"),
    ).resolves.toMatchObject({ storedAuthKind: "oauth" });
    await expect(
      loadStoredModelAuth("anthropic", credentials, "claude-other"),
    ).resolves.toMatchObject({ storedAuthKind: "api_key" });
  });

  it("prefers a saved provider credential over a newer unused row", async () => {
    await expect(
      loadStoredModelAuth(
        "anthropic",
        async () => [
          { provider: "anthropic", authKind: "oauth" },
          { provider: "anthropic", authKind: "api_key", modelId: "claude-saved" },
        ],
        "claude-other",
      ),
    ).resolves.toMatchObject({ storedAuthKind: "api_key" });
    await expect(
      loadStoredModelAuth("anthropic", async () => [
        { provider: "anthropic", authKind: "oauth" },
        { provider: "anthropic", authKind: "api_key" },
      ]),
    ).resolves.toMatchObject({ storedAuthKind: "oauth" });
  });

  it("reports the selected row unreadable even when a newer row has a kind", async () => {
    await expect(
      loadStoredModelAuth(
        "anthropic",
        async () => [
          { provider: "anthropic", authKind: "oauth", modelId: "claude-new" },
          { provider: "anthropic", modelId: "claude-saved", isDefault: true },
        ],
        "claude-saved",
      ),
    ).resolves.toEqual({
      storedAuthKind: null,
      credentialLookupFailed: false,
      credentialUnreadable: true,
    });
  });
});

describe("runModelConnectionPreflight", () => {
  it("probes catalog providers through the pinned catalog endpoint", async () => {
    const probeCatalog = vi.fn().mockResolvedValue({ models: ["gpt-test"] });
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
      modelId: "gpt-test",
      catalogProbe: true,
      probeCatalog,
    });
    expect(result.ok).toBe(true);
    expect(probeCatalog).toHaveBeenCalledWith({
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
    });
  });

  it("rejects a selected model the catalog probe did not list", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
      modelId: "missing-model",
      catalogProbe: true,
      probeCatalog: async () => ({ models: ["gpt-test"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.outcome).toBe("unavailable_model");
      expect(result.failure.message).toBe('Model "missing-model" was not listed.');
      expect(result.failure.nextAction).toBe("Pick a model from the catalog.");
    }
  });

  it("rejects providers without a pinned catalog endpoint", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: "anthropic",
      apiKey: "sk-test-key-12345678",
      catalogProbe: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toMatch(/cannot be tested without saving/);
  });

  it("reports oauth when not connected", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "openai-codex",
      storedAuthKind: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.outcome).toBe("needs_sign_in");
  });

  it("does not treat a stored api key as subscription sign-in", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "anthropic",
      storedAuthKind: "api_key",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.outcome).toBe("needs_sign_in");
      expect(result.failure.message).toMatch(/API key is stored/);
    }
  });

  it("accepts a stored subscription credential", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "openai-codex",
      storedAuthKind: "oauth",
    });
    expect(result.ok).toBe(true);
  });

  it("does not treat an unreadable credential as a missing sign-in", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "anthropic",
      credentialUnreadable: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.outcome).toBe("unknown");
      expect(result.failure.message).toMatch(/Could not check stored credentials/);
    }
  });

  it("keeps credential lookup failures distinct from a missing sign-in", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "openai-codex",
      credentialLookupFailed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.outcome).toBe("unknown");
      expect(result.failure.message).toMatch(/Could not check stored credentials/);
    }
  });
});

describe("modelPreflightSuccessMessage", () => {
  it("reports a models-list check and does not ask catalog users to type an id", () => {
    expect(modelPreflightSuccessMessage(1)).toBe(
      "Models list OK. 1 model available. Chat was not tested.",
    );
    expect(modelPreflightSuccessMessage(466)).toBe(
      "Models list OK. 466 models available. Chat was not tested.",
    );
    expect(modelPreflightSuccessMessage(0)).toBe("No models listed.");
    expect(modelPreflightSuccessMessage(0)).not.toMatch(/model id/i);
  });
});
