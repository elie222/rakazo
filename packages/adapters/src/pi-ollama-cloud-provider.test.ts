import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_CLOUD_PROVIDER_ID,
  ollamaCloudProvider,
  ollamaThinkingLevelMap,
  registerOllamaCloudProvider,
} from "./pi-ollama-cloud-provider.js";

describe("Ollama Cloud provider", () => {
  it("serves every model from the fixed public endpoint over the OpenAI wire", () => {
    const provider = ollamaCloudProvider();
    expect(provider.id).toBe(OLLAMA_CLOUD_PROVIDER_ID);
    expect(provider.name).toBe("Ollama Cloud");
    const models = provider.getModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.api).toBe("openai-completions");
      expect(model.baseUrl).toBe(OLLAMA_CLOUD_BASE_URL);
      expect(model.provider).toBe(OLLAMA_CLOUD_PROVIDER_ID);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.maxTokens).toBeLessThanOrEqual(model.contextWindow);
    }
  });

  it("uses the API id Ollama's cloud list returns, not the app's :cloud tag", () => {
    const ids = ollamaCloudProvider()
      .getModels()
      .map((model) => model.id);
    expect(ids).toContain("gemma4:31b");
    expect(ids).toContain("gpt-oss:120b");
    expect(ids.some((id) => id.endsWith(":cloud"))).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares vision and thinking as Ollama reports them", () => {
    const byId = new Map(
      ollamaCloudProvider()
        .getModels()
        .map((model) => [model.id, model]),
    );
    expect(byId.get("gemma4:31b")?.input).toEqual(["text", "image"]);
    expect(byId.get("gpt-oss:120b")?.input).toEqual(["text"]);
    expect(byId.get("mistral-large-3:675b")).toMatchObject({ reasoning: false });
    expect(byId.get("mistral-large-3:675b")?.thinkingLevelMap).toBeUndefined();
    expect(byId.get("kimi-k3")).toMatchObject({
      reasoning: true,
      compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
    });
  });

  it("resolves auth only from the stored credential", async () => {
    const auth = ollamaCloudProvider().auth.apiKey;
    expect(auth).toBeDefined();
    const ctx = { env: async () => undefined } as never;
    const signal = new AbortController().signal;
    await expect(auth!.resolve({ ctx, signal })).resolves.toBeUndefined();
    await expect(
      auth!.resolve({ ctx, signal, credential: { type: "api_key", key: "fixture-key" } }),
    ).resolves.toMatchObject({ auth: { apiKey: "fixture-key" } });
  });

  it("registers onto a Models collection", () => {
    const models = registerOllamaCloudProvider(builtinModels());
    expect(models.getModel(OLLAMA_CLOUD_PROVIDER_ID, "gemma4:31b")).toBeDefined();
  });
});

describe("Ollama thinking levels", () => {
  const levels = (values: Parameters<typeof ollamaThinkingLevelMap>[0]) =>
    getSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: ollamaThinkingLevelMap(values),
    } as never);

  it("offers exactly the named levels a model lists, with off when it can be disabled", () => {
    expect(ollamaThinkingLevelMap([false, "low", "high", "max"])).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
    expect(levels([false, "low", "high", "max"])).toEqual(["off", "low", "high", "max"]);
  });

  it("keeps thinking on for a model that cannot turn it off", () => {
    expect(levels(["low", "medium", "high", "xhigh", "max"])).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(levels([true])).toEqual(["medium"]);
  });

  it("reduces a switch-only model to off and one on level", () => {
    expect(levels([false, true])).toEqual(["off", "medium"]);
  });
});
