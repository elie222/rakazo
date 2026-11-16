import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { COMMANDCODE_PROVIDER_ID, commandCodeCatalogProvider } from "./pi-commandcode-provider.js";
import { catalogProviderProbeBaseUrl, listPiCatalog } from "./pi-models.js";

const provider = commandCodeCatalogProvider(builtinModels());
const models = provider.getModels();
const model = (id: string) => {
  const found = models.find((entry) => entry.id === id);
  if (!found) throw new Error(`CommandCode catalogue is missing ${id}`);
  return found;
};

describe("commandcode catalogue", () => {
  it("publishes the gateway's ids once each, with labels and context windows", () => {
    expect(provider.id).toBe(COMMANDCODE_PROVIDER_ID);
    expect(models.length).toBeGreaterThan(90);
    expect(new Set(models.map((entry) => entry.id)).size).toBe(models.length);
    for (const entry of models) {
      expect(entry.provider).toBe(COMMANDCODE_PROVIDER_ID);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("routes Claude on Anthropic Messages and everything else on Chat Completions", () => {
    expect(model("claude-sonnet-5-5")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.commandcode.ai/provider",
    });
    expect(model("claude-haiku-4-5-20251001")).toMatchObject({ contextWindow: 200_000 });
    expect(model("gpt-5.5")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      contextWindow: 400_000,
    });
    expect(model("moonshotai/Kimi-K3")).toMatchObject({ api: "openai-completions" });
  });

  it("inherits Claude thinking support from the Anthropic catalogue", () => {
    const sonnet = model("claude-sonnet-5-5");
    expect(sonnet.reasoning).toBe(true);
    expect(sonnet.input).toContain("image");
    expect(sonnet.compat).toMatchObject({ forceAdaptiveThinking: true });
    expect(sonnet.thinkingLevelMap).toBeDefined();
  });

  it("inherits thinking support for a Claude generation the catalogue has not caught up on", () => {
    const fable = model("claude-fable-5-2");
    const known = builtinModels()
      .getProvider("anthropic")
      ?.getModels()
      .some((entry) => entry.id === fable.id);
    expect(known).toBe(false);
    expect(fable.reasoning).toBe(true);
    expect(fable.compat).toMatchObject({ forceAdaptiveThinking: true });
  });

  it("never inherits Anthropic fallback models, which would route work away from the gateway", () => {
    for (const entry of models.filter((candidate) => candidate.api === "anthropic-messages")) {
      expect(entry.compat).not.toHaveProperty("allowedFallbackModels");
    }
  });

  it("keeps Chat Completions requests on proxy-safe defaults", () => {
    const chat = model("gpt-5.5");
    expect(chat.reasoning).toBe(false);
    expect(chat.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    });
  });

  it("authenticates only from the saved connection, never from a vendor env var", async () => {
    const auth = provider.auth.apiKey;
    if (!auth) throw new Error("CommandCode must accept an API key");
    const signal = new AbortController().signal;
    // A key in the environment must not stand in for the connection: the shared connection
    // settings are the only place a provider's key is configured.
    const ctx = {
      env: async (name: string) => (name === "COMMANDCODE_API_KEY" ? "env-key" : undefined),
      fileExists: async () => false,
    };

    await expect(
      auth.resolve({ ctx, credential: { type: "api_key", key: " saved-key " }, signal }),
    ).resolves.toMatchObject({ auth: { apiKey: "saved-key" } });

    await expect(auth.resolve({ ctx, signal })).resolves.toBeUndefined();
  });

  it("registers in the app catalogue without a key and without the single-URL probe", () => {
    const entry = listPiCatalog().find(
      (candidate) => candidate.provider === COMMANDCODE_PROVIDER_ID,
    );
    expect(entry?.providerName).toBe("CommandCode");
    // The Chat Completions models do share one https root, so the probe is refused by the trait the
    // adapter declares, not by the URL shapes the shared probe happens to reject.
    const chatRoots = new Set(
      models.filter((m) => m.api === "openai-completions").map((m) => m.baseUrl),
    );
    expect([...chatRoots]).toEqual(["https://api.commandcode.ai/provider/v1"]);
    expect(catalogProviderProbeBaseUrl(COMMANDCODE_PROVIDER_ID)).toBeNull();
  });

  it("inherits thinking support from the matched Anthropic entry instead of assuming it", () => {
    const withAnthropic = (reasoning: boolean) => {
      const anthropic = { id: "anthropic", getModels: () => [{ id: "claude-fable-5", reasoning }] };
      const base = {
        getProviders: () => [anthropic],
        getProvider: (id: string) => (id === "anthropic" ? anthropic : undefined),
      } as unknown as MutableModels;
      // claude-fable-5-2 has no entry of its own, so it inherits from claude-fable-5 by prefix.
      return commandCodeCatalogProvider(base)
        .getModels()
        .find((model) => model.id === "claude-fable-5-2");
    };

    expect(withAnthropic(true)?.reasoning).toBe(true);
    expect(withAnthropic(false)?.reasoning).toBe(false);
  });
});
