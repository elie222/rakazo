import type { ModelCatalogEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  clampCatalogThinkingLevel,
  featuredModelProviders,
  filterModelCatalog,
  pickCatalogModelId,
  selectedProviderOutsideSearchResults,
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
