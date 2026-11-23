import type { ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { newestModelsFirst } from "./model-providers.js";
import {
  catalogEntryFor,
  connectionModels,
  connectionServesModel,
  credentialModelSettings,
  modelCapabilitiesConfigurable,
  modelSettingsDefaults,
  modelSettingsEditable,
  modelSettingsFields,
  modelSettingsRequest,
  modelThinkingLevels,
} from "./model-settings-form.js";

const COMPATIBLE = "openai-compatible";

function credential(overrides: Partial<ModelCredential> = {}): ModelCredential {
  return {
    id: "credential-fixture",
    provider: "zai",
    label: "Z.AI",
    hasKey: true,
    isDefault: true,
    ...overrides,
  };
}

const fields = {
  contextWindow: "",
  maxTokens: "",
  images: false,
  maxImagesPerPrompt: "",
  reasoning: false,
};

describe("modelCapabilitiesConfigurable", () => {
  it("lets image input and thinking be set only where the catalog cannot describe the model", () => {
    expect(modelCapabilitiesConfigurable("zai", { live: true })).toBe(true);
    expect(modelCapabilitiesConfigurable("zai", undefined)).toBe(true);
    expect(modelCapabilitiesConfigurable(COMPATIBLE, {})).toBe(true);
    expect(modelCapabilitiesConfigurable("zai", {})).toBe(false);
  });
});

describe("modelSettingsDefaults", () => {
  it("shows the model card's limits, or what an OpenAI-compatible model runs with", () => {
    expect(modelSettingsDefaults("zai", { contextWindow: 200_000, maxTokens: 32_000 })).toEqual({
      contextWindow: 200_000,
      maxTokens: 32_000,
    });
    expect(modelSettingsDefaults(COMPATIBLE, undefined)).toEqual({
      contextWindow: 262_144,
      maxTokens: 4_096,
    });
  });
});

describe("credentialModelSettings", () => {
  it("prefers the model's own settings over what was saved for the whole connection", () => {
    const saved = credential({
      maxTokens: 2_048,
      contextWindow: 100_000,
      modelSettings: { "glm-5.3-flashx": { images: true } },
    });
    expect(credentialModelSettings(saved, "glm-5.3-flashx")).toEqual({ images: true });
    expect(credentialModelSettings(saved, "glm-5.3")).toEqual({
      maxTokens: 2_048,
      contextWindow: 100_000,
    });
  });

  it("reads an OpenAI-compatible connection's older settings per model", () => {
    const saved = credential({
      provider: COMPATIBLE,
      reasoning: true,
      visionModelIds: ["vision"],
      maxImagesPerPrompt: 4,
    });
    expect(credentialModelSettings(saved, "vision")).toEqual({
      reasoning: true,
      images: true,
      maxImagesPerPrompt: 4,
    });
    expect(credentialModelSettings(saved, "text")).toEqual({
      reasoning: true,
      maxImagesPerPrompt: 4,
    });
  });
});

describe("modelSettingsFields", () => {
  it("starts unset switches from what the model already does, so a limit save keeps them", () => {
    const fields = modelSettingsFields({ maxTokens: 1_024 }, { images: true, reasoning: true });
    expect(fields).toMatchObject({ images: true, reasoning: true });
    expect(
      modelSettingsRequest({
        fields: { ...fields, maxTokens: "2048" },
        provider: "zai",
        entry: { live: true },
      }),
    ).toEqual({
      status: "ready",
      settings: { maxTokens: 2_048, images: true, reasoning: true },
    });
    expect(modelSettingsFields({ images: false }, { images: true }).images).toBe(false);
  });

  it("shows unset limits as empty fields", () => {
    expect(modelSettingsFields({ maxTokens: 1_024, images: true })).toEqual({
      ...fields,
      maxTokens: "1024",
      images: true,
    });
  });
});

describe("modelSettingsRequest", () => {
  const live = { live: true as const, contextWindow: 128_000, maxTokens: 16_000 };

  it("saves empty fields as the model card's values", () => {
    expect(modelSettingsRequest({ fields, provider: "zai", entry: {} })).toEqual({
      status: "ready",
      settings: {},
    });
  });

  it("saves capabilities only where they can be set, and an image limit wherever images are read", () => {
    const on = { ...fields, images: true, reasoning: true, maxImagesPerPrompt: " 8 " };
    expect(modelSettingsRequest({ fields: on, provider: "zai", entry: live })).toEqual({
      status: "ready",
      settings: { images: true, reasoning: true, maxImagesPerPrompt: 8 },
    });
    expect(modelSettingsRequest({ fields: on, provider: "zai", entry: {} })).toEqual({
      status: "ready",
      settings: { maxImagesPerPrompt: 8 },
    });
  });

  it("names the field that is out of range", () => {
    expect(
      modelSettingsRequest({
        fields: { ...fields, contextWindow: "0" },
        provider: "zai",
        entry: live,
      }),
    ).toEqual({ status: "invalid", field: "contextWindow" });
    expect(
      modelSettingsRequest({
        fields: { ...fields, maxTokens: "1.5" },
        provider: "zai",
        entry: live,
      }),
    ).toEqual({ status: "invalid", field: "maxTokens" });
    expect(
      modelSettingsRequest({
        fields: { ...fields, images: true, maxImagesPerPrompt: "2000" },
        provider: "zai",
        entry: live,
      }),
    ).toEqual({ status: "invalid", field: "maxImagesPerPrompt" });
  });

  it("keeps the output below the context the model runs with", () => {
    expect(
      modelSettingsRequest({
        fields: { ...fields, contextWindow: "16000" },
        provider: "zai",
        entry: { contextWindow: 128000, maxTokens: 32000 },
      }),
    ).toEqual({ status: "invalid", field: "outputRoom" });
    expect(
      modelSettingsRequest({
        fields: { ...fields, maxTokens: "128000" },
        provider: "zai",
        entry: live,
      }),
    ).toEqual({ status: "invalid", field: "outputRoom" });
    expect(
      modelSettingsRequest({
        fields: { ...fields, contextWindow: "200000", maxTokens: "128000" },
        provider: "zai",
        entry: live,
      }),
    ).toMatchObject({ status: "ready", settings: { contextWindow: 200_000, maxTokens: 128_000 } });
  });
});

describe("connectionModels", () => {
  const catalog = [
    { provider: "zai", id: "a", label: "A" },
    { provider: "zai", id: "b", label: "B", credentialIds: ["other"] },
    { provider: "zai", id: "c", label: "C" },
    { provider: "zai", id: "custom", label: "Custom", placeholder: true },
    { provider: "elsewhere", id: "d", label: "D" },
  ];

  it("lists only the provider's models the catalog cannot describe, and customized ones", () => {
    expect(
      connectionModels(credential({ modelSettings: { c: { images: true }, a: {} } }), [
        ...catalog,
        { provider: "zai", id: "listed", label: "Listed", live: true as const },
      ]),
    ).toEqual([
      { id: "c", label: "C", settings: { images: true } },
      { id: "listed", label: "Listed" },
    ]);
  });

  it("lists every catalog model while older connection-wide limits apply", () => {
    expect(
      connectionModels(credential({ maxTokens: 4096 }), catalog).map((model) => model.id),
    ).toEqual(["a", "c"]);
  });

  it("still serves a catalog model once it has no settings to show", () => {
    expect(connectionModels(credential(), catalog)).toEqual([]);
    expect(connectionServesModel(credential(), catalog, "a")).toBe(true);
    expect(connectionServesModel(credential(), catalog, "b")).toBe(false);
  });

  it("lists an OpenAI-compatible connection's enabled models", () => {
    expect(
      connectionModels(
        credential({ provider: COMPATIBLE, modelId: "x", enabledModelIds: ["x", "y"] }),
        catalog,
      ).map((model) => model.id),
    ).toEqual(["x", "y"]);
    expect(
      connectionModels(credential({ provider: COMPATIBLE, modelId: "x" }), catalog).map(
        (model) => model.id,
      ),
    ).toEqual(["x"]);
  });
});

describe("catalogEntryFor", () => {
  it("finds a model under any alias of its provider", () => {
    const catalog = [
      { provider: "zai", id: "glm-5.3" },
      { provider: "azure", id: "deployment" },
    ];
    expect(catalogEntryFor(catalog, "azure-openai-responses", "deployment")).toBe(catalog[1]);
    expect(catalogEntryFor(catalog, "zai", "missing")).toBeUndefined();
    expect(catalogEntryFor(catalog, "elsewhere", "glm-5.3")).toBeUndefined();
  });
});

describe("connection-specific live capabilities", () => {
  it("uses sibling defaults instead of another connection's overlay", () => {
    const entry = {
      images: true,
      reasoning: true,
      thinkingLevels: ["low", "high"] as const,
      defaultCapabilities: {
        images: false,
        reasoning: false,
        thinkingLevels: ["low", "high"] as ("low" | "high")[],
      },
    };
    const other = credential();
    expect(modelSettingsFields(credentialModelSettings(other, "live-model"), entry)).toMatchObject({
      images: false,
      reasoning: false,
    });
    expect(
      modelThinkingLevels(other, { ...entry, thinkingLevels: ["low", "high"] }, "live-model"),
    ).toEqual(["off"]);
    const customized = credential({ modelSettings: { "live-model": { reasoning: true } } });
    expect(
      modelThinkingLevels(customized, { ...entry, thinkingLevels: ["low", "high"] }, "live-model"),
    ).toEqual(["low", "high"]);
  });
});

describe("newestModelsFirst", () => {
  it("orders by the version in each id, keeping the catalog's order on ties", () => {
    const ids = [
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-6-astra",
      "gpt-6.1-sol",
      "claude-sonnet-4-20250514",
      "claude-opus-5-5",
      "gpt-4o-2024-08-06",
      "gpt-4.1",
      "llama-3-8b",
      "llama-3.1-8b",
      "unversioned",
    ].map((id) => ({ id }));
    expect(newestModelsFirst(ids).map((model) => model.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "claude-opus-5-5",
      "gpt-4.1",
      "claude-sonnet-4-20250514",
      "gpt-4o-2024-08-06",
      "llama-3.1-8b",
      "llama-3-8b",
      "unversioned",
    ]);
  });
});

describe("modelSettingsEditable", () => {
  it("opens settings only where the catalog cannot describe the model or it has its own", () => {
    expect(modelSettingsEditable(credential(), { live: undefined }, "a")).toBe(false);
    expect(modelSettingsEditable(credential(), undefined, "a")).toBe(false);
    expect(modelSettingsEditable(credential({ maxTokens: 4096 }), {}, "a")).toBe(true);
    expect(modelSettingsEditable(credential(), { live: true }, "a")).toBe(true);
    expect(modelSettingsEditable(credential({ provider: COMPATIBLE }), undefined, "a")).toBe(true);
    expect(
      modelSettingsEditable(credential({ modelSettings: { a: { maxTokens: 10 } } }), {}, "a"),
    ).toBe(true);
  });
});
