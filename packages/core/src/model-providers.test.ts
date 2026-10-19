import type { ModelCatalogEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  canUseCompatibleModelAsDefault,
  clampCatalogThinkingLevel,
  compatibleModelRows,
  connectedModelChoices,
  credentialForModel,
  featuredModelProviders,
  filterModelCatalog,
  pickCatalogModelId,
  resolveSelectableModelId,
  savedCompatibleModelIds,
  selectedProviderOutsideSearchResults,
  toggleEnabledModelId,
} from "./model-providers.js";

function provider(provider: string): ModelCatalogEntry {
  return {
    provider,
    providerName: provider,
    id: `${provider}-model`,
    label: `${provider} model`,
    billing: "",
  };
}

describe("featuredModelProviders", () => {
  it("shows popular providers in a stable order", () => {
    const providers = [
      provider("azure"),
      provider("vercel-ai-gateway"),
      provider("google"),
      provider("openai"),
      provider("anthropic"),
      provider("openai-codex"),
      provider("openrouter"),
    ];

    expect(featuredModelProviders(providers, "openrouter").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "openai-codex",
      "anthropic",
      "openai",
      "google",
      "vercel-ai-gateway",
    ]);
  });

  it("fills missing popular slots from the catalog", () => {
    const providers = [
      provider("azure"),
      provider("openrouter"),
      provider("bedrock"),
      provider("anthropic"),
    ];

    expect(featuredModelProviders(providers, "openrouter").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "anthropic",
      "azure",
      "bedrock",
    ]);
  });

  it("keeps a non-featured selected provider visible", () => {
    const providers = [
      provider("openrouter"),
      provider("openai-codex"),
      provider("anthropic"),
      provider("openai"),
      provider("google"),
      provider("vercel-ai-gateway"),
      provider("local"),
    ];

    expect(featuredModelProviders(providers, "local").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "openai-codex",
      "anthropic",
      "openai",
      "google",
      "local",
    ]);
  });
});

describe("pickCatalogModelId", () => {
  const catalog = [
    { provider: "openrouter", id: "openai/gpt-6-luna" },
    { provider: "openrouter", id: "anthropic/claude-fable-5" },
    { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
    { provider: "openai-codex", id: "gpt-6-luna" },
  ];

  it("returns the provider's first entry without a preferred id", () => {
    expect(pickCatalogModelId(catalog, "openai-codex", null)).toBe("gpt-5.3-codex-spark");
    expect(pickCatalogModelId(catalog, "openai-codex")).toBe("gpt-5.3-codex-spark");
  });

  it("prefers an exact preferred id within the provider", () => {
    expect(pickCatalogModelId(catalog, "openai-codex", "gpt-6-luna")).toBe("gpt-6-luna");
    expect(pickCatalogModelId(catalog, "openrouter", "openai/gpt-6-luna")).toBe(
      "openai/gpt-6-luna",
    );
  });

  it("matches the preferred id's basename across vendor prefixes", () => {
    expect(pickCatalogModelId(catalog, "openai-codex", "openai/gpt-6-luna")).toBe("gpt-6-luna");
  });

  it("ignores a preferred id that belongs to another provider only", () => {
    expect(pickCatalogModelId(catalog, "openai-codex", "openai/gpt-6-astra")).toBe(
      "gpt-5.3-codex-spark",
    );
    expect(pickCatalogModelId(catalog, "openai-codex", "anthropic/claude-fable-5")).toBe(
      "gpt-5.3-codex-spark",
    );
  });

  it("returns an empty string for an unknown provider", () => {
    expect(pickCatalogModelId(catalog, "nope", "openai/gpt-6-luna")).toBe("");
  });
});

describe("selectedProviderOutsideSearchResults", () => {
  it("returns the active provider separately from unrelated search results", () => {
    const providers = [provider("openrouter"), provider("anthropic"), provider("bedrock")];

    expect(
      selectedProviderOutsideSearchResults(providers.slice(1), providers, "openrouter"),
    ).toMatchObject({ provider: "openrouter" });
  });

  it("returns nothing when the active provider matches the search", () => {
    const providers = [provider("openrouter"), provider("anthropic")];

    expect(
      selectedProviderOutsideSearchResults(providers, providers, "openrouter"),
    ).toBeUndefined();
  });
});

describe("clampCatalogThinkingLevel", () => {
  it("keeps a level the model supports and drops the default", () => {
    expect(clampCatalogThinkingLevel("high", ["low", "medium", "high"])).toBe("high");
    expect(clampCatalogThinkingLevel(null, ["high"])).toBeNull();
    expect(clampCatalogThinkingLevel("off", ["off", "high"])).toBeNull();
  });

  it("clamps an unsupported level to the nearest supported effort", () => {
    expect(clampCatalogThinkingLevel("xhigh", ["minimal", "low", "medium", "high"])).toBe("high");
    expect(clampCatalogThinkingLevel("minimal", ["high", "xhigh"])).toBe("high");
  });

  it("resets when the model cannot think", () => {
    expect(clampCatalogThinkingLevel("high", ["off"])).toBeNull();
    expect(clampCatalogThinkingLevel("high", [])).toBeNull();
  });

  it("keeps a concrete level when the model is outside the catalog", () => {
    expect(clampCatalogThinkingLevel("high", undefined)).toBe("high");
  });
});

describe("connected model choices", () => {
  const deepseek = [
    {
      provider: "deepseek",
      providerName: "DeepSeek",
      id: "deepseek-flash",
      label: "DeepSeek V4.1 Flash",
    },
    {
      provider: "deepseek",
      providerName: "DeepSeek",
      id: "deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
    },
  ];

  it("submits API model ids and keeps display labels out of the value", () => {
    const choices = connectedModelChoices(
      [{ provider: "deepseek", label: "DeepSeek", modelId: "DeepSeek-V4.1-Flash" }],
      deepseek,
    );
    expect(choices.map((choice) => choice.modelId)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(choices.map((choice) => choice.key)).toEqual([
      "deepseek::deepseek-flash",
      "deepseek::deepseek-v4-pro",
    ]);
    for (const choice of choices) {
      expect(choice.modelId).not.toBe(choice.label);
      expect(choice.modelId).not.toMatch(/DeepSeek/);
    }
    expect(choices.map((choice) => choice.label)).toEqual([
      "DeepSeek · DeepSeek V4.1 Flash",
      "DeepSeek · DeepSeek V4 Pro",
    ]);
  });

  it("rewrites a catalog id that is only a display label", () => {
    const choices = connectedModelChoices(
      [{ provider: "deepseek", label: "DeepSeek", modelId: "deepseek-flash" }],
      [
        {
          provider: "deepseek",
          providerName: "DeepSeek",
          id: "DeepSeek-V4.1-Flash",
          label: "DeepSeek V4.1 Flash",
        },
        ...deepseek.slice(1),
      ],
    );
    expect(choices.map((choice) => choice.modelId)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("keeps a custom model id that is not a catalog label", () => {
    expect(
      connectedModelChoices(
        [{ provider: "deepseek", label: "DeepSeek", modelId: "my-finetune" }],
        deepseek,
      ),
    ).toEqual([
      {
        key: "deepseek::my-finetune",
        provider: "deepseek",
        modelId: "my-finetune",
        label: "DeepSeek · my-finetune",
      },
    ]);
  });

  it("offers one choice per enabled model id on a compatible connection", () => {
    const choices = connectedModelChoices(
      [
        {
          provider: "openai-compatible",
          label: "Local server",
          modelId: "alpha",
          enabledModelIds: ["alpha", "beta", "gamma", "beta"],
        },
      ],
      deepseek,
    );
    expect(choices).toEqual(
      ["alpha", "beta", "gamma"].map((id) => ({
        key: `openai-compatible::${id}`,
        provider: "openai-compatible",
        modelId: id,
        label: `Local server · ${id}`,
      })),
    );
  });

  it("finds a credential by enabled model id or by its default model", () => {
    const compatible = {
      provider: "openai-compatible",
      label: "Local server",
      modelId: "alpha",
      enabledModelIds: ["alpha", "beta"],
    };
    const legacy = { provider: "deepseek", label: "DeepSeek", modelId: "my-finetune" };
    const credentials = [legacy, compatible];
    expect(credentialForModel(credentials, "openai-compatible", "beta")).toBe(compatible);
    expect(credentialForModel(credentials, "openai-compatible", "alpha")).toBe(compatible);
    expect(credentialForModel(credentials, "deepseek", "my-finetune")).toBe(legacy);
    expect(credentialForModel(credentials, "openai-compatible", "delta")).toBeUndefined();
    expect(credentialForModel(credentials, "deepseek", "beta")).toBeUndefined();
    expect(credentialForModel(credentials, null, "alpha")).toBeUndefined();
  });

  it("prefers a matching space model over a newer enabled match", () => {
    const newer = {
      provider: "openai-compatible",
      label: "Newer",
      modelId: null,
      enabledModelIds: ["Y"],
      thinkingLevels: ["off"],
    };
    const owner = {
      provider: "openai-compatible",
      label: "Owner",
      modelId: "Y",
      enabledModelIds: ["Y"],
      thinkingLevels: ["off", "high"],
    };
    expect(credentialForModel([newer, owner], "openai-compatible", "Y")).toBe(owner);
    const preferred = { ...owner, modelId: "X", isDefault: true };
    expect(credentialForModel([newer, preferred], "openai-compatible", "Y")).toBe(preferred);
  });

  it("uses server preference order without changing stable enabled-connection order", () => {
    const newest = {
      provider: "openai-compatible",
      label: "Newest",
      modelId: "Y",
      preferenceRank: 2,
      enabledModelIds: ["Y", "Z"],
    };
    const preferred = { ...newest, label: "Preferred", preferenceRank: 1 };
    const legacy = {
      provider: "openai-compatible",
      label: "Legacy",
      modelId: "X",
      isDefault: true,
      preferenceRank: 0,
    };
    const credentials = [newest, preferred, legacy];
    expect(credentialForModel(credentials, "openai-compatible", "Y")).toBe(preferred);
    expect(credentialForModel(credentials, "openai-compatible", "Z")).toBe(newest);
    expect(credentialForModel(credentials, "openai-compatible", "X")).toBe(legacy);
  });

  it("uses enabled connections before a legacy fallback for every choice", () => {
    const legacy = {
      provider: "openai-compatible",
      label: "Legacy",
      modelId: "X",
      isDefault: true,
    };
    const listed = { provider: "openai-compatible", label: "Listed", enabledModelIds: ["Y"] };
    expect(credentialForModel([listed, legacy], "openai-compatible", "Y")).toBe(listed);
    expect(credentialForModel([legacy], "openai-compatible", "Y")).toBe(legacy);
  });

  it("resolves a saved display label to the API id used on save", () => {
    expect(resolveSelectableModelId(deepseek, "deepseek", "DeepSeek-V4.1-Flash")).toBe(
      "deepseek-flash",
    );
    expect(resolveSelectableModelId(deepseek, "deepseek", "DeepSeek-V4-Pro")).toBe(
      "deepseek-v4-pro",
    );
    expect(resolveSelectableModelId(deepseek, "deepseek", "deepseek-v4-pro")).toBe(
      "deepseek-v4-pro",
    );
    expect(resolveSelectableModelId(deepseek, "deepseek", "my-finetune")).toBe("my-finetune");
  });
});

describe("filterModelCatalog", () => {
  const models: ModelCatalogEntry[] = [
    {
      provider: "openrouter",
      providerName: "OpenRouter",
      id: "anthropic/claude-sonnet",
      label: "Claude Sonnet",
      billing: "",
    },
    { provider: "openrouter", id: "openai/gpt-mini", label: "GPT Mini", billing: "" },
  ];

  it("keeps every model for a blank query", () => {
    expect(filterModelCatalog(models, "")).toBe(models);
    expect(filterModelCatalog(models, "   ")).toBe(models);
  });

  it("matches the label, id, or provider name, ignoring case and surrounding space", () => {
    expect(filterModelCatalog(models, " sonnet ").map((entry) => entry.id)).toEqual([
      "anthropic/claude-sonnet",
    ]);
    expect(filterModelCatalog(models, "OPENAI/").map((entry) => entry.id)).toEqual([
      "openai/gpt-mini",
    ]);
    expect(filterModelCatalog(models, "OpenRouter").map((entry) => entry.id)).toEqual([
      "anthropic/claude-sonnet",
      "openai/gpt-mini",
    ]);
  });

  it("falls back to the provider id when there is no provider name", () => {
    expect(filterModelCatalog([models[1]!], "router")).toHaveLength(1);
  });

  it("returns nothing when no model matches", () => {
    expect(filterModelCatalog(models, "gemini")).toEqual([]);
  });
});

describe("openai-compatible model rows", () => {
  const saved = { baseUrl: "http://127.0.0.1:8000/v1", enabledModelIds: ["a", "b"] };

  it("keeps the saved list only for the saved endpoint", () => {
    expect(savedCompatibleModelIds(saved, " http://127.0.0.1:8000/v1 ")).toEqual(["a", "b"]);
    expect(savedCompatibleModelIds(saved, "http://other.test/v1")).toEqual([]);
    expect(savedCompatibleModelIds({ baseUrl: saved.baseUrl }, saved.baseUrl)).toEqual([]);
    expect(savedCompatibleModelIds(undefined, saved.baseUrl)).toEqual([]);
  });

  it("compares endpoints the way the server stores them", () => {
    expect(savedCompatibleModelIds(saved, "http://127.0.0.1:8000/v1/")).toEqual(["a", "b"]);
    expect(savedCompatibleModelIds(saved, "http://127.0.0.1:8000")).toEqual(["a", "b"]);
    expect(savedCompatibleModelIds(saved, "http://127.0.0.2:8000/v1")).toEqual([]);
  });

  it("treats half-typed text as a different endpoint without throwing", () => {
    expect(savedCompatibleModelIds(saved, "http://")).toEqual([]);
    expect(savedCompatibleModelIds(saved, "127.0.0.1:80")).toEqual([]);
    expect(savedCompatibleModelIds({ ...saved, baseUrl: "not a url" }, " not a url ")).toEqual([
      "a",
      "b",
    ]);
  });

  it("lists saved, ticked and probed ids once each, in that order", () => {
    expect(compatibleModelRows(["a", "b"], ["b", "c"], ["d", "a"])).toEqual(["a", "b", "c", "d"]);
  });

  it("ticks and unticks an id without duplicates", () => {
    expect(toggleEnabledModelId(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleEnabledModelId(["a", "b"], "b", true)).toEqual(["a", "b"]);
    expect(toggleEnabledModelId(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("allows a default only from a saved list, and any default when the list is unread", () => {
    expect(canUseCompatibleModelAsDefault(["a", "b"], "b")).toBe(true);
    expect(canUseCompatibleModelAsDefault(["a"], "b")).toBe(false);
    expect(canUseCompatibleModelAsDefault(undefined, "b")).toBe(true);
  });
});

it("offers Azure catalog models for a credential saved with the old provider id", () => {
  const catalog = [{ provider: "azure", id: "gpt-4o", label: "GPT-4o" }];
  const choices = connectedModelChoices(
    [{ provider: "azure-openai-responses", label: "Azure", modelId: "gpt-4o" }],
    catalog,
  );
  expect(choices).toMatchObject([{ key: "azure::gpt-4o", provider: "azure", modelId: "gpt-4o" }]);
  expect(pickCatalogModelId(catalog, "azure-openai-responses", "gpt-4o")).toBe("gpt-4o");
});
