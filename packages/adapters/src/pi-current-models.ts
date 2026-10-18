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
  // Amazon Bedrock releases from the provider library's next catalog, each copied from a sibling.
  function bedrock(
    baseId: string,
    id: string,
    name: string,
    cost?: Model<Api>["cost"],
    overrides: Partial<Model<Api>> = {},
  ) {
    add("amazon-bedrock", baseId, { id, name, ...(cost ? { cost } : {}), ...overrides });
  }
  function price(
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    tier?: [number, number, number, number, number],
  ): Model<Api>["cost"] {
    const cost = { input, output, cacheRead, cacheWrite };
    if (!tier) return cost;
    const [inputTokensAbove, ...rates] = tier;
    const [tierInput, tierOutput, tierCacheRead, tierCacheWrite] = rates;
    return {
      ...cost,
      tiers: [
        {
          inputTokensAbove,
          input: tierInput,
          output: tierOutput,
          cacheRead: tierCacheRead,
          cacheWrite: tierCacheWrite,
        },
      ],
    };
  }
  bedrock(
    "anthropic.claude-sonnet-5",
    "anthropic.claude-haiku-5-5",
    "Claude Haiku 5.5",
    price(0.1, 0.5, 0.01, 0.125, [100000, 0.5, 2.5, 0.05, 0.625]),
  );
  bedrock(
    "anthropic.claude-sonnet-5",
    "anthropic.claude-sonnet-5-5",
    "Claude Sonnet 5.5",
    price(2, 10, 0.1, 2.5),
  );
  bedrock(
    "au.anthropic.claude-sonnet-5",
    "au.anthropic.claude-haiku-5-5",
    "Claude Haiku 5.5 (AU)",
    price(0.11, 0.55, 0.011, 0.1375, [100000, 0.55, 2.75, 0.055, 0.6875]),
  );
  bedrock(
    "eu.anthropic.claude-sonnet-5",
    "eu.anthropic.claude-haiku-5-5",
    "Claude Haiku 5.5 (EU)",
    price(0.11, 0.55, 0.011, 0.1375, [100000, 0.55, 2.75, 0.055, 0.6875]),
  );
  bedrock(
    "eu.anthropic.claude-sonnet-5",
    "eu.anthropic.claude-sonnet-5-5",
    "Claude Sonnet 5.5 (EU)",
    price(2.2, 11, 0.11, 2.75),
  );
  bedrock(
    "global.anthropic.claude-sonnet-5",
    "global.anthropic.claude-haiku-5-5",
    "Claude Haiku 5.5 (Global)",
    price(0.1, 0.5, 0.01, 0.125, [100000, 0.5, 2.5, 0.05, 0.625]),
  );
  bedrock(
    "global.anthropic.claude-sonnet-5",
    "global.anthropic.claude-sonnet-5-5",
    "Claude Sonnet 5.5 (Global)",
    price(2, 10, 0.1, 2.5),
  );
  bedrock(
    "moonshotai.kimi-k2.5",
    "global.moonshotai.kimi-k3",
    "Kimi K3 (Global)",
    price(3, 15, 0.3, 3.75),
    { contextWindow: 1048576, maxTokens: 128000 },
  );
  bedrock(
    "global.openai.gpt-6-astra",
    "global.openai.gpt-6-luna",
    "GPT-6 Luna (Global)",
    price(0.1, 0.5, 0.01, 0.125, [272000, 0.2, 0.75, 0.02, 0.25]),
  );
  bedrock(
    "global.openai.gpt-6-astra",
    "global.openai.gpt-6-sol",
    "GPT-6 Sol (Global)",
    price(2, 10, 0.2, 2.5, [272000, 4, 15, 0.4, 5]),
  );
  bedrock(
    "global.openai.gpt-6-astra",
    "global.openai.gpt-6.1-sol",
    "GPT-6.1 Sol (Global)",
    price(2, 10, 0.1, 2.5, [272000, 4, 15, 0.2, 5]),
  );
  bedrock("global.xai.grok-4.6", "global.xai.grok-4.7", "Grok 4.7 (Global)", undefined, {
    compat: { supportsStrictMode: true },
  });
  bedrock("zai.glm-5", "global.zai.glm-5.3", "GLM-5.3 (Global)", price(1.68, 5.28, 0.312, 2.1), {
    contextWindow: 1000000,
    maxTokens: 128000,
  });
  bedrock(
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "in.anthropic.claude-haiku-4-5-20251001-v1:0",
    "Claude Haiku 4.5 (India)",
  );
  bedrock("us.anthropic.claude-opus-5", "in.anthropic.claude-opus-5", "Claude Opus 5 (India)");
  bedrock(
    "us.anthropic.claude-sonnet-5",
    "in.anthropic.claude-sonnet-5",
    "Claude Sonnet 5 (India)",
  );
  bedrock(
    "jp.anthropic.claude-sonnet-5",
    "jp.anthropic.claude-haiku-5-5",
    "Claude Haiku 5.5 (JP)",
    price(0.11, 0.55, 0.011, 0.1375, [100000, 0.55, 2.75, 0.055, 0.6875]),
  );
  bedrock(
    "openai.gpt-6-astra",
    "openai.gpt-6-luna",
    "GPT-6 Luna",
    price(0.11, 0.55, 0.011, 0.1375, [272000, 0.22, 0.825, 0.022, 0.275]),
  );
  bedrock(
    "openai.gpt-6-astra",
    "openai.gpt-6-sol",
    "GPT-6 Sol",
    price(2.2, 11, 0.22, 2.75, [272000, 4.4, 16.5, 0.44, 5.5]),
  );
  bedrock(
    "openai.gpt-6-astra",
    "openai.gpt-6.1-sol",
    "GPT-6.1 Sol",
    price(2.2, 11, 0.11, 2.75, [272000, 4.4, 16.5, 0.22, 5.5]),
  );
  bedrock(
    "us.anthropic.claude-sonnet-5",
    "us.anthropic.claude-haiku-5-5",
    "Claude Haiku 5.5 (US)",
    price(0.11, 0.55, 0.011, 0.1375, [100000, 0.55, 2.75, 0.055, 0.6875]),
  );
  bedrock(
    "us.anthropic.claude-sonnet-5",
    "us.anthropic.claude-sonnet-5-5",
    "Claude Sonnet 5.5 (US)",
    price(2.2, 11, 0.11, 2.75),
  );
  bedrock(
    "moonshotai.kimi-k2.5",
    "us.moonshotai.kimi-k3",
    "Kimi K3 (US)",
    price(3.3, 16.5, 0.33, 4.125),
    { contextWindow: 1048576, maxTokens: 128000 },
  );
  bedrock(
    "us.openai.gpt-6-astra",
    "us.openai.gpt-6-luna",
    "GPT-6 Luna (US)",
    price(0.11, 0.55, 0.011, 0.1375, [272000, 0.22, 0.825, 0.022, 0.275]),
  );
  bedrock(
    "us.openai.gpt-6-astra",
    "us.openai.gpt-6-sol",
    "GPT-6 Sol (US)",
    price(2.2, 11, 0.22, 2.75, [272000, 4.4, 16.5, 0.44, 5.5]),
  );
  bedrock(
    "us.openai.gpt-6-astra",
    "us.openai.gpt-6.1-sol",
    "GPT-6.1 Sol (US)",
    price(2.2, 11, 0.11, 2.75, [272000, 4.4, 16.5, 0.22, 5.5]),
  );
  bedrock("us.xai.grok-4.6", "us.xai.grok-4.7", "Grok 4.7 (US)", undefined, {
    compat: { supportsStrictMode: true },
  });
  bedrock("zai.glm-5", "us.zai.glm-5.3", "GLM-5.3 (US)", price(1.848, 5.808, 0.3432, 2.31), {
    contextWindow: 1000000,
    maxTokens: 128000,
  });
  return models;
}
