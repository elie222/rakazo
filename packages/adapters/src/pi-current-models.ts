import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";

/** Fill catalog gaps until the bundled provider library includes these releases. */
export function supplementPiModels(models: MutableModels): MutableModels {
  function add(
    providerId: string,
    baseId: string,
    overrides: Partial<Model<Api>> & { id: string },
  ) {
    if (models.getModel(providerId, overrides.id)) return;
    const provider = models.getProvider(providerId);
    const base = models.getModel(providerId, baseId);
    if (!provider || !base) throw new Error(`Missing model baseline: ${providerId}/${baseId}`);
    const model = { ...base, ...overrides };
    models.setProvider({ ...provider, getModels: () => [model, ...provider.getModels()] });
  }
  add("anthropic", "claude-sonnet-5", {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
      supportsMidConvoEffort: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
    },
  });
  const haiku55Cost = {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [
      { inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    ],
  };
  const openCodeClaude55 = {
    contextWindow: 1000000,
    maxTokens: 128000,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsMidConvoSystemMessages: true,
    },
  } satisfies Partial<Model<Api>>;
  add("opencode", "claude-haiku-4-5", {
    ...openCodeClaude55,
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    cost: haiku55Cost,
  });
  add("opencode", "claude-sonnet-5", {
    ...openCodeClaude55,
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
  });
  // OpenCode Go has no Claude baseline yet; MiniMax-M3 shares its Anthropic Messages endpoint.
  add("opencode-go", "minimax-m3", {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    cost: haiku55Cost,
    maxTokens: 128000,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    compat: { forceAdaptiveThinking: true, supportsTemperature: false },
  });
  const sol = models.getModel("openai-codex", "gpt-6-sol");
  add("openai-codex", "gpt-6-sol", {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
    // Subscription transport keeps its own window; the account catalog may narrow it.
    contextWindow: sol?.contextWindow ?? 272000,
  });
  return models;
}
