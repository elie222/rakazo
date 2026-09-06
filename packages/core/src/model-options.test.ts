import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  connectedModelOptions,
  modelCatalogLabel,
  modelOptionKey,
  parseModelOptionKey,
} from "./model-options.js";

const catalog = [
  {
    provider: "openai",
    providerName: "OpenAI",
    id: "gpt-5",
    label: "GPT-5",
    billing: "metered",
    auth: "api-key",
  },
  {
    provider: "openai",
    providerName: "OpenAI",
    id: "coming-soon",
    label: "Coming soon",
    billing: "metered",
    auth: "api-key",
    placeholder: true,
  },
] satisfies ModelCatalogEntry[];

it("round-trips model option keys", () => {
  const key = modelOptionKey("openai-compatible", "org/model::preview");
  expect(parseModelOptionKey(key)).toEqual({
    provider: "openai-compatible",
    modelId: "org/model::preview",
  });
  expect(parseModelOptionKey("missing-separator")).toBeNull();
  expect(parseModelOptionKey("provider::")).toBeNull();
});

describe("connectedModelOptions", () => {
  it("expands catalog credentials and excludes placeholders", () => {
    const credentials = [
      {
        id: "credential-1",
        provider: "openai",
        label: "OpenAI",
        hasKey: true,
        isDefault: true,
      },
    ] satisfies ModelCredential[];

    expect(connectedModelOptions(credentials, catalog)).toEqual([
      {
        key: "openai::gpt-5",
        provider: "openai",
        modelId: "gpt-5",
        label: "OpenAI · GPT-5",
      },
    ]);
  });

  it("keeps free-form credentials as their connected provider/model pair", () => {
    const credentials = [
      {
        provider: "openai-compatible",
        label: "Local server",
        hasKey: true,
        isDefault: false,
        id: "credential-2",
        modelId: "qwen3",
      },
    ] satisfies ModelCredential[];

    expect(connectedModelOptions(credentials, catalog)).toEqual([
      {
        key: "openai-compatible::qwen3",
        provider: "openai-compatible",
        modelId: "qwen3",
        label: "Local server · qwen3",
      },
    ]);
  });

  it("deduplicates credentials for the same provider", () => {
    const credentials = [
      {
        id: "credential-1",
        provider: "openai",
        label: "OpenAI",
        hasKey: true,
        isDefault: true,
      },
      {
        id: "credential-2",
        provider: "openai",
        label: "OpenAI again",
        hasKey: true,
        isDefault: false,
      },
    ] satisfies ModelCredential[];

    expect(connectedModelOptions(credentials, catalog)).toHaveLength(1);
  });
});

it("finds the catalog label for a provider/model pair", () => {
  expect(modelCatalogLabel(catalog, "openai", "gpt-5")).toBe("GPT-5");
  expect(modelCatalogLabel(catalog, "other", "gpt-5")).toBeUndefined();
});
