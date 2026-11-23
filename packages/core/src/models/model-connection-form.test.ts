import type { ModelCredential } from "@rakazo/contracts";
import { modelRoutingDirty, modelRoutingForm } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { ConnectionFormDraft } from "./model-connection-form.js";
import {
  compatibleConnectionReady,
  connectionFormFields,
  connectionFormModelId,
  dataRetentionDirty,
  modelConnectRequest,
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
    thinkingLevel: null,
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
      thinkingLevel: null,
      accountId: "",
      gatewayId: "",
    });
  });

  it("shows a saved OpenAI-compatible connection, whose models choose their own effort", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local",
      enabledModelIds: ["local", "other"],
      apiProtocol: "anthropic-messages",
      reasoning: true,
      thinkingLevel: "high",
    });
    expect(
      connectionFormFields({
        catalog,
        provider: COMPATIBLE,
        modelId: "local",
        credential: saved,
        presetBaseUrl: "https://ignored.example/v1",
      }),
    ).toMatchObject({
      enabledModelIds: ["local", "other"],
      baseUrl: "http://127.0.0.1:8000/v1",
      apiProtocol: "anthropic-messages",
      thinkingLevel: null,
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
});

describe("modelConnectRequest", () => {
  const anthropic = {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "opus",
    thinkingLevels: ["low", "high"] as ModelCredential["thinkingLevels"],
  };

  it("waits for a key, or a saved connection for a save without one", () => {
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
      savingWithoutKey: false,
      activeModelId: "opus",
      input: {
        provider: "anthropic",
        apiKey: "sk-long-enough",
        modelId: "opus",
        thinkingLevel: "high",
        makeDefault: true,
        scope: "account",
        label: "Anthropic",
        credentialId: null,
      },
    });
  });

  it("leaves the stored effort alone on a save without a key unless model or effort changed", () => {
    const saved = credential({ modelId: "opus", thinkingLevel: "high" });
    const settings = modelConnectRequest({
      form: draft({ apiKey: "sk-ignored-here", thinkingLevel: "high" }),
      selected: anthropic,
      credential: saved,
      credentialId: saved.id,
      settingsOnly: true,
    });
    expect(settings).toMatchObject({ status: "ready", savingWithoutKey: true });
    expect(settings.status === "ready" && settings.input).toEqual({
      provider: "anthropic",
      modelId: "opus",
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
      savingWithoutKey: false,
      activeModelId: "m",
      input: {
        provider: COMPATIBLE,
        baseUrl: "http://h/v1",
        apiProtocol: "chat-completions",
        headers: { "X-Team": "v" },
        modelId: "m",
        enabledModelIds: ["n"],
        apiKey: "key",
        label: "OpenAI-compatible",
        credentialId: "credential-fixture",
      },
    });
  });
});

describe("zero data retention form", () => {
  const gateway = { provider: "example-gateway", providerName: "Gateway", id: "jev" };
  const withControl = { ...gateway, dataRetentionControl: true as const };

  it("shows the toggle only for a provider that offers it, from the saved connection", () => {
    const catalogWithControl = [
      { provider: "example-gateway", id: "jev", dataRetentionControl: true as const },
    ];
    const fields = (credentialFixture?: ModelCredential) =>
      connectionFormFields({
        catalog: catalogWithControl,
        provider: "example-gateway",
        modelId: "jev",
        credential: credentialFixture,
      });
    expect(fields().zeroDataRetention).toBe(false);
    expect(
      fields(credential({ provider: "example-gateway", zeroDataRetention: true }))
        .zeroDataRetention,
    ).toBe(true);
    expect(
      connectionFormFields({ catalog, provider: "example-gateway", modelId: "jev" }),
    ).not.toHaveProperty("zeroDataRetention");
  });

  it("always sends an explicit value so turning it off clears it", () => {
    const saved = credential({
      provider: "example-gateway",
      modelId: "jev",
      zeroDataRetention: true,
    });
    const off = modelConnectRequest({
      form: draft({ zeroDataRetention: false }),
      selected: withControl,
      credential: saved,
      credentialId: saved.id,
    });
    expect(off.status === "ready" && off.input).toMatchObject({ zeroDataRetention: false });
    const omitted = modelConnectRequest({
      form: draft({ apiKey: "sk-long-enough" }),
      selected: withControl,
      credentialId: null,
    });
    expect(omitted.status === "ready" && omitted.input).toMatchObject({ zeroDataRetention: false });
  });

  it("sends nothing for a provider without the control, even if the form holds a value", () => {
    const request = modelConnectRequest({
      form: draft({ apiKey: "sk-long-enough", zeroDataRetention: true }),
      selected: gateway,
      credentialId: null,
    });
    expect(request.status === "ready" && request.input).not.toHaveProperty("zeroDataRetention");
  });

  it("is dirty only when the toggle differs from the saved connection", () => {
    const saved = credential({ provider: "example-gateway", zeroDataRetention: true });
    expect(dataRetentionDirty(withControl, false, saved)).toBe(true);
    expect(dataRetentionDirty(withControl, true, saved)).toBe(false);
    expect(dataRetentionDirty(withControl, true, credential({ provider: "example-gateway" }))).toBe(
      true,
    );
    expect(dataRetentionDirty(withControl, false, undefined)).toBe(false);
    expect(dataRetentionDirty({ dataRetentionControl: undefined }, true, undefined)).toBe(false);
  });
});

describe("legacy project routing", () => {
  const selected = {
    provider: "project-provider",
    id: "model",
    routingFields: ["projectId", "region"] as const,
  };
  it("keeps key-only settings and key rotation editable without adding project routing", () => {
    const saved = credential({ provider: selected.provider, modelId: selected.id });
    for (const apiKey of ["", "replacement-fixture-key"]) {
      const form = draft({ apiKey, projectId: "", region: "global" });
      expect(modelRoutingForm(selected.routingFields, form, saved).routingReady).toBe(true);
      expect(modelRoutingDirty(form, saved)).toBe(false);
      const request = modelConnectRequest({
        form,
        selected: { ...selected, routingFields: [...selected.routingFields] },
        credential: saved,
        credentialId: saved.id,
      });
      expect(request.status).toBe("ready");
      if (request.status !== "ready") throw new Error("Expected an editable legacy connection");
      expect(request.input).not.toHaveProperty("projectId");
      expect(request.input).not.toHaveProperty("region");
    }
  });
  it("still requires complete routing for new or already project-scoped connections", () => {
    const form = draft({ projectId: "", region: "global" });
    expect(modelRoutingForm(selected.routingFields, form).routingReady).toBe(false);
    expect(modelRoutingDirty({ ...form, projectId: "example-project" }, credential())).toBe(true);
    expect(
      modelRoutingDirty(
        { ...form, projectId: "example-project", region: "us-central1" },
        credential({ projectId: "example-project", region: "global" }),
      ),
    ).toBe(true);
    expect(
      modelRoutingForm(
        selected.routingFields,
        form,
        credential({ projectId: "example-project", region: "global" }),
      ).routingReady,
    ).toBe(false);
    expect(
      modelRoutingForm(selected.routingFields, { ...form, region: "us-central1" }, credential())
        .routingReady,
    ).toBe(false);
    expect(
      modelRoutingForm(
        selected.routingFields,
        { ...form, projectId: "example-project" },
        credential(),
      ).routingReady,
    ).toBe(true);
  });
});
