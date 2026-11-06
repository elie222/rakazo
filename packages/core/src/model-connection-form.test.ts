import type { ModelCredential } from "@rakazo/contracts";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { ConnectionFormDraft } from "./model-connection-form.js";
import {
  compatibleConnectionReady,
  connectionFormFields,
  connectionFormModelId,
  isSavedCompatibleModel,
  modelConnectRequest,
  pickedCompatibleModelFields,
  probedModelFields,
} from "./model-connection-form.js";

const catalog = [
  {
    provider: "anthropic",
    id: "opus",
    thinkingLevels: ["low", "high"] as ModelCredential["thinkingLevels"],
  },
  { provider: "anthropic", id: "sonnet", recommended: true },
  { provider: "openrouter", id: "jev" },
];
const COMPATIBLE = "openai-compatible";

function credential(overrides: Partial<ModelCredential> = {}): ModelCredential {
  return {
    id: "credential-fixture",
    provider: "anthropic",
    label: "Anthropic",
    hasKey: true,
    isDefault: true,
    ...overrides,
  };
}

function draft(overrides: Partial<ConnectionFormDraft> = {}): ConnectionFormDraft {
  return {
    apiKey: "",
    modelId: "",
    enabledModelIds: [],
    baseUrl: "",
    apiProtocol: "chat-completions",
    headerRows: null,
    reasoning: false,
    thinkingLevel: null,
    maxTokens: "",
    contextWindow: "262144",
    supportsImages: false,
    maxImagesPerPrompt: "",
    accountId: "",
    gatewayId: "",
    ...overrides,
  };
}

describe("connectionFormModelId", () => {
  it("keeps the model on screen while the catalog lists it", () => {
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        credential: credential({ modelId: "sonnet" }),
        current: "opus",
      }),
    ).toBe("opus");
  });

  it("falls back to the connection's model, then the default, then the recommended one", () => {
    const defaults = { defaultProvider: "anthropic", defaultModel: "opus" };
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        credential: credential({ modelId: "sonnet" }),
        defaults,
        current: "gone",
      }),
    ).toBe("sonnet");
    expect(connectionFormModelId({ catalog, provider: "anthropic", defaults })).toBe("opus");
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        defaults: { defaultProvider: "openrouter", defaultModel: "jev" },
      }),
    ).toBe("sonnet");
  });

  it("opens a new OpenAI-compatible connection empty instead of on another server's model", () => {
    const defaults = { defaultProvider: COMPATIBLE, defaultModel: "local-model" };
    expect(connectionFormModelId({ catalog, provider: COMPATIBLE, defaults })).toBe("");
    expect(
      connectionFormModelId({
        catalog,
        provider: COMPATIBLE,
        credential: credential({ provider: COMPATIBLE, modelId: "saved-model" }),
        defaults,
        current: "typed-model",
      }),
    ).toBe("saved-model");
  });
});

describe("connectionFormFields", () => {
  it("fills a new connection with defaults and the endpoint preset", () => {
    expect(
      connectionFormFields({
        catalog,
        provider: COMPATIBLE,
        modelId: "",
        presetBaseUrl: "https://ollama.com/v1",
      }),
    ).toEqual({
      enabledModelIds: [],
      baseUrl: "https://ollama.com/v1",
      apiProtocol: "chat-completions",
      reasoning: false,
      thinkingLevel: null,
      maxTokens: "4096",
      contextWindow: "262144",
      supportsImages: false,
      maxImagesPerPrompt: "",
      accountId: "",
      gatewayId: "",
    });
  });

  it("shows a saved OpenAI-compatible connection, with effort only for its saved model", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local",
      enabledModelIds: ["local", "other"],
      reasoning: true,
      thinkingLevel: "high",
      maxTokens: 2048,
      contextWindow: 32_000,
      supportsImages: true,
      maxImagesPerPrompt: 4,
    });
    const fields = connectionFormFields({
      catalog,
      provider: COMPATIBLE,
      modelId: "local",
      credential: saved,
      presetBaseUrl: "https://ignored.example/v1",
    });
    expect(fields).toMatchObject({
      enabledModelIds: ["local", "other"],
      baseUrl: "http://127.0.0.1:8000/v1",
      apiProtocol: "chat-completions",
      reasoning: true,
      thinkingLevel: "high",
      maxTokens: "2048",
      contextWindow: "32000",
      supportsImages: true,
      maxImagesPerPrompt: "4",
    });
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "other", credential: saved })
        .thinkingLevel,
    ).toBeNull();
  });

  it("keeps a saved protocol and clamps its effort levels to what the protocol runs", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local",
      reasoning: true,
      thinkingLevel: "max",
      apiProtocol: "anthropic-messages",
    });
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "local", credential: saved })
        .apiProtocol,
    ).toBe("anthropic-messages");
    // Anthropic Messages has no budget above high, so a saved max clamps down.
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "local", credential: saved })
        .thinkingLevel,
    ).toBe("high");
    const request = modelConnectRequest({
      form: draft({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "local",
        apiProtocol: "anthropic-messages",
        reasoning: true,
        thinkingLevel: "xhigh",
        maxTokens: "4096",
      }),
      selected: {
        provider: COMPATIBLE,
        id: "openai-compatible",
        providerName: "OpenAI-compatible",
      },
      credentialId: null,
    });
    expect(request.status === "ready" && request.input).toMatchObject({
      apiProtocol: "anthropic-messages",
      thinkingLevel: "high",
    });
  });

  it("clamps a catalog connection's effort to its model and leaves the endpoint empty", () => {
    const fields = connectionFormFields({
      catalog,
      provider: "anthropic",
      modelId: "opus",
      credential: credential({ modelId: "opus", thinkingLevel: "medium", baseUrl: "x" }),
    });
    expect(fields.thinkingLevel).toBe("high");
    expect(fields.baseUrl).toBe("");
    expect(fields.maxTokens).toBe("");
  });
});

describe("compatibleConnectionReady", () => {
  const ready = { apiKey: "", baseUrl: " http://h/v1 ", modelId: "m", headerRows: null };

  it("needs a URL and a model", () => {
    expect(compatibleConnectionReady(ready)).toBe(true);
    expect(compatibleConnectionReady({ ...ready, modelId: "" })).toBe(false);
    expect(compatibleConnectionReady({ ...ready, baseUrl: " " })).toBe(false);
  });

  it("refuses invalid header rows", () => {
    expect(
      compatibleConnectionReady({ ...ready, headerRows: [{ name: "bad name", value: "v" }] }),
    ).toBe(false);
  });

  it("waits for a required key, from the typed one or the saved one", () => {
    const atPreset = { ...ready, baseUrl: " https://hosted.example.test/v1 ", keyRequired: true };
    expect(compatibleConnectionReady(atPreset)).toBe(false);
    expect(compatibleConnectionReady({ ...atPreset, apiKey: "fake-key" })).toBe(true);
    expect(
      compatibleConnectionReady({
        ...atPreset,
        credential: { hasKey: true, baseUrl: "https://hosted.example.test/v1" },
      }),
    ).toBe(true);
    expect(compatibleConnectionReady({ ...atPreset, keyRequired: false })).toBe(true);
  });
});

describe("probedModelFields", () => {
  it("prefills only the fields the listing publishes", () => {
    expect(probedModelFields(undefined, "4096")).toEqual({});
    expect(probedModelFields({ id: "a" }, "4096")).toEqual({});
    expect(
      probedModelFields(
        { id: "a", supportsImages: false, reasoning: true, contextWindow: 131072 },
        "4096",
      ),
    ).toEqual({ supportsImages: false, reasoning: true, contextWindow: "131072" });
  });

  it("ignores cache pricing, which rides on the connect request instead", () => {
    expect(
      probedModelFields(
        { id: "a", cacheCapabilities: { scope: "account", retentionMode: "short" } },
        "4096",
      ),
    ).toEqual({});
  });

  it.each([
    [4096, "4096", "2048"],
    [8192, "9000", "4096"],
    [2, "4096", "1"],
    [3, "3", "1"],
  ])(
    "lowers the output limit when a %i-token context would not leave it room (was %s)",
    (contextWindow, current, lowered) => {
      expect(probedModelFields({ id: "a", contextWindow }, current)).toEqual({
        contextWindow: String(contextWindow),
        maxTokens: lowered,
      });
    },
  );

  it("keeps an output limit that already fits", () => {
    expect(probedModelFields({ id: "a", contextWindow: 8192 }, "4096")).toEqual({
      contextWindow: "8192",
    });
  });

  it.each(["", "lots", "4096.5"])(
    "leaves an output limit it cannot read as a whole number (%j) to the form's own validation",
    (current) => {
      expect(probedModelFields({ id: "a", contextWindow: 4096 }, current)).toEqual({
        contextWindow: "4096",
      });
    },
  );

  it("does not prefill a one-token context limit, which no output limit can fit under", () => {
    expect(probedModelFields({ id: "a", reasoning: true, contextWindow: 1 }, "4096")).toEqual({
      reasoning: true,
    });
  });

  it("keeps every prefilled pair valid down to the smallest context limit", () => {
    for (const contextWindow of [2, 3, 4096]) {
      const fields = probedModelFields({ id: "a", contextWindow }, "4096");
      expect(Number(fields.contextWindow)).toBe(contextWindow);
      expect(Number(fields.maxTokens ?? "4096")).toBeLessThan(contextWindow);
      expect(Number(fields.maxTokens ?? "4096")).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("pickedCompatibleModelFields", () => {
  const endpoint = "https://models.example.test/v1";
  const saved = credential({
    provider: COMPATIBLE,
    baseUrl: endpoint,
    modelId: "saved",
    apiProtocol: "chat-completions",
    reasoning: true,
    thinkingLevel: "high",
    maxTokens: 2048,
    contextWindow: 32_000,
    supportsImages: false,
    maxImagesPerPrompt: 2,
  });
  const listing = new Map([
    ["saved", { id: "saved", supportsImages: true, reasoning: false, contextWindow: 8192 }],
    ["other", { id: "other", supportsImages: true, reasoning: false, contextWindow: 1024 }],
  ]);
  const savedFields = {
    reasoning: true,
    supportsImages: false,
    maxImagesPerPrompt: "2",
    maxTokens: "2048",
    contextWindow: "32000",
    thinkingLevel: "high",
  };

  /** A form that writes every returned field, as both apps do. */
  function pick(form: Record<string, unknown>, modelId: string, baseUrl = endpoint) {
    const fields = pickedCompatibleModelFields({
      credential: saved,
      baseUrl,
      modelId,
      probed: listing.get(modelId),
      form: {
        reasoning: form.reasoning as boolean,
        maxTokens: form.maxTokens as string,
        apiProtocol: "chat-completions",
      },
    });
    return { ...form, ...fields };
  }

  it("tells the saved model on its saved endpoint from the same id elsewhere", () => {
    expect(isSavedCompatibleModel(saved, `${endpoint}/`, "saved")).toBe(true);
    expect(isSavedCompatibleModel(saved, endpoint, "other")).toBe(false);
    expect(isSavedCompatibleModel(saved, "https://elsewhere.example.test/v1", "saved")).toBe(false);
    expect(isSavedCompatibleModel(undefined, endpoint, "saved")).toBe(false);
  });

  it("restores the saved model's settings after another model's listing values were filled in", () => {
    const other = pick(savedFields, "other");
    expect(other).toEqual({
      reasoning: false,
      supportsImages: true,
      maxImagesPerPrompt: "2",
      maxTokens: "512",
      contextWindow: "1024",
      thinkingLevel: null,
    });
    expect(pick(other, "saved")).toEqual(savedFields);
  });

  it("takes the listing's values for the saved id on another endpoint", () => {
    expect(pick(savedFields, "saved", "https://elsewhere.example.test/v1")).toEqual({
      ...savedFields,
      reasoning: false,
      supportsImages: true,
      contextWindow: "8192",
      thinkingLevel: null,
    });
  });

  it("keeps the form's own values for a model the listing does not describe", () => {
    expect(pick(savedFields, "unlisted")).toEqual({ ...savedFields, thinkingLevel: null });
  });
});

describe("modelConnectRequest", () => {
  const anthropic = {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "opus",
    thinkingLevels: ["low", "high"] as ModelCredential["thinkingLevels"],
  };

  it("waits for a key, or a saved connection for a limits-only save", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: "short" }),
        selected: anthropic,
        credentialId: null,
      }).status,
    ).toBe("incomplete");
    expect(
      modelConnectRequest({ form: draft(), selected: anthropic, credentialId: null }).status,
    ).toBe("incomplete");
  });

  it("names the out-of-range field", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: "sk-long-enough", maxTokens: "0" }),
        selected: anthropic,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "maxTokens" });
    const compatible = { provider: COMPATIBLE, id: "openai-compatible" };
    const form = draft({ baseUrl: "http://h/v1", modelId: "m", maxTokens: "4096" });
    expect(
      modelConnectRequest({
        form: { ...form, supportsImages: true, maxImagesPerPrompt: "2000" },
        selected: compatible,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "maxImagesPerPrompt" });
    expect(
      modelConnectRequest({
        form: { ...form, contextWindow: "" },
        selected: compatible,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "contextWindow" });
  });

  it("connects a catalog key with the clamped effort and the makeDefault target", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: " sk-long-enough ", thinkingLevel: "medium" }),
        selected: anthropic,
        credentialId: null,
        makeDefault: { makeDefault: true, scope: "account" },
      }),
    ).toEqual({
      status: "ready",
      savingLimitOnly: false,
      activeModelId: "opus",
      input: {
        provider: "anthropic",
        apiKey: "sk-long-enough",
        modelId: "opus",
        thinkingLevel: "high",
        makeDefault: true,
        scope: "account",
        maxTokens: null,
        label: "Anthropic",
        credentialId: null,
      },
    });
  });

  it("leaves the stored effort alone on a limits-only save unless model or effort changed", () => {
    const saved = credential({ modelId: "opus", thinkingLevel: "high" });
    const limits = modelConnectRequest({
      form: draft({ apiKey: "sk-ignored-here", maxTokens: "1024", thinkingLevel: "high" }),
      selected: anthropic,
      credential: saved,
      credentialId: saved.id,
      settingsOnly: true,
    });
    expect(limits).toMatchObject({ status: "ready", savingLimitOnly: true });
    expect(limits.status === "ready" && limits.input).toEqual({
      provider: "anthropic",
      modelId: "opus",
      maxTokens: 1024,
      label: "Anthropic",
      credentialId: saved.id,
    });
    const effort = modelConnectRequest({
      form: draft({ thinkingLevel: "low" }),
      selected: anthropic,
      credential: saved,
      credentialId: saved.id,
    });
    expect(effort.status === "ready" && effort.input.thinkingLevel).toBe("low");
    const model = modelConnectRequest({
      form: draft(),
      selected: anthropic,
      credential: credential({ modelId: "sonnet" }),
      credentialId: saved.id,
    });
    expect(model.status === "ready" && "thinkingLevel" in model.input).toBe(true);
  });

  it("sends routing ids trimmed when the provider asks for them", () => {
    const request = modelConnectRequest({
      form: draft({ apiKey: "cf-long-enough", accountId: " acct ", gatewayId: " gw " }),
      selected: {
        provider: "example-gateway",
        id: "model",
        routingFields: ["accountId", "gatewayId"],
      },
      credentialId: null,
    });
    expect(request.status === "ready" && request.input).toMatchObject({
      accountId: "acct",
      gatewayId: "gw",
    });
  });

  it("saves an OpenAI-compatible connection without repeating its default in the enabled list", () => {
    const request = modelConnectRequest({
      form: draft({
        apiKey: " key ",
        baseUrl: " http://h/v1 ",
        modelId: " m ",
        enabledModelIds: ["m", "n"],
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: "4096",
        supportsImages: true,
        headerRows: [{ name: " X-Team ", value: "v" }],
      }),
      selected: {
        provider: COMPATIBLE,
        id: "openai-compatible",
        providerName: "OpenAI-compatible",
      },
      credentialId: "credential-fixture",
    });
    expect(request).toEqual({
      status: "ready",
      savingLimitOnly: false,
      activeModelId: "m",
      input: {
        provider: COMPATIBLE,
        baseUrl: "http://h/v1",
        apiProtocol: "chat-completions",
        headers: { "X-Team": "v" },
        modelId: "m",
        enabledModelIds: ["n"],
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: 4096,
        contextWindow: 262_144,
        supportsImages: true,
        maxImagesPerPrompt: null,
        apiKey: "key",
        label: "OpenAI-compatible",
        credentialId: "credential-fixture",
      },
    });
  });

  describe("OpenAI-compatible limits and prompt caching", () => {
    const compatible = { provider: COMPATIBLE, id: "openai-compatible" };
    const form = (overrides: Partial<ConnectionFormDraft> = {}) =>
      draft({ baseUrl: "http://h/v1", modelId: "m", maxTokens: "4096", ...overrides });
    const cached = { scope: "account" as const, readCostPerMillion: 0.1 };
    const pricier = { scope: "account" as const, readCostPerMillion: 0.9 };

    it("refuses an output limit that leaves no room for input", () => {
      for (const [maxTokens, contextWindow] of [
        ["8192", "8192"],
        ["8192", "4096"],
        ["1", "1"],
      ]) {
        expect(
          modelConnectRequest({
            form: form({ maxTokens, contextWindow }),
            selected: compatible,
            credentialId: null,
          }),
        ).toEqual({ status: "invalid", field: "maxTokensExceedsContext" });
      }
    });

    it("accepts an output limit one below the context limit", () => {
      expect(
        modelConnectRequest({
          form: form({ maxTokens: "1", contextWindow: "2" }),
          selected: compatible,
          credentialId: null,
        }).status,
      ).toBe("ready");
    });

    it("sends the cache capabilities of every enabled model the listing described", () => {
      const request = modelConnectRequest({
        form: form({ enabledModelIds: ["n", "plain", "unlisted"] }),
        selected: compatible,
        credentialId: null,
        probedModels: new Map([
          ["m", { id: "m", cacheCapabilities: cached }],
          ["n", { id: "n", cacheCapabilities: pricier }],
          ["plain", { id: "plain", supportsImages: true }],
          ["elsewhere", { id: "elsewhere", cacheCapabilities: cached }],
        ]),
      });
      expect(request.status === "ready" && request.input.cacheCapabilitiesByModel).toEqual({
        m: cached,
        n: pricier,
        plain: null,
      });
    });

    it("builds a request the server accepts when the selected model and 500 enabled ones are described", () => {
      const enabledModelIds = Array.from({ length: 500 }, (_, i) => `model-${i}`);
      const request = modelConnectRequest({
        form: form({ enabledModelIds }),
        selected: compatible,
        credentialId: null,
        probedModels: new Map(
          ["m", ...enabledModelIds].map((id) => [id, { id, cacheCapabilities: cached }]),
        ),
      });
      expect(request.status).toBe("ready");
      if (request.status !== "ready") return;
      expect(Object.keys(request.input.cacheCapabilitiesByModel ?? {})).toHaveLength(501);
      expect(ModelConnectInputSchema.safeParse(request.input).success).toBe(true);
    });

    it("sends no cache capabilities when the listing described none of the models", () => {
      const request = modelConnectRequest({
        form: form(),
        selected: compatible,
        credentialId: null,
        probedModels: new Map([["elsewhere", { id: "elsewhere", cacheCapabilities: cached }]]),
      });
      expect(request.status === "ready" && request.input).not.toHaveProperty(
        "cacheCapabilitiesByModel",
      );
    });
  });
});
