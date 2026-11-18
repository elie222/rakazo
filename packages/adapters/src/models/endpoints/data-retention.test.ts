import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolvedModelRunFields } from "../../runs/turn/run-model.js";
import { listPiCatalog } from "../../runtime/pi/models/pi-models.js";
import { resolveRuntimeModel } from "../../runtime/pi/pi-runtime-models.js";
import { buildModelConnectPlaintext, modelCredentialDto } from "../model-connect.js";
import { parseModelSecret, serializeModelSecret } from "../model-secret.js";
import {
  DataRetentionRefusedError,
  dataRetentionForConnect,
  providerHasDataRetentionControl,
  withDataRetention,
  withDataRetentionPayload,
} from "./data-retention.js";

const CHAT_MODEL = "~deepseek/deepseek-flash-latest";
const MESSAGES_MODEL = "~anthropic/claude-fable-latest";
const apiKey = "fake-gateway-key";

function runtime(id: string, extra: { zeroDataRetention?: boolean } = {}) {
  return resolveRuntimeModel({ provider: "openrouter", id, apiKey, ...extra }).model;
}

function routing(model: Model<Api> | undefined) {
  return (model?.compat as { openRouterRouting?: Record<string, unknown> } | undefined)
    ?.openRouterRouting;
}

describe("dataRetentionForConnect", () => {
  it("keeps the stored value when omitted and clears it only on an explicit false", () => {
    expect(dataRetentionForConnect({ provider: "openrouter" }, true)).toBe(true);
    expect(
      dataRetentionForConnect({ provider: "openrouter", zeroDataRetention: false }, true),
    ).toBe(undefined);
    expect(dataRetentionForConnect({ provider: "openrouter", zeroDataRetention: true })).toBe(true);
    expect(dataRetentionForConnect({ provider: "openrouter" })).toBe(undefined);
  });

  it("refuses to turn it on for a provider that cannot enforce it", () => {
    expect(() =>
      dataRetentionForConnect({ provider: "anthropic", zeroDataRetention: true }),
    ).toThrow(DataRetentionRefusedError);
    expect(dataRetentionForConnect({ provider: "anthropic", zeroDataRetention: false })).toBe(
      undefined,
    );
    expect(dataRetentionForConnect({ provider: "anthropic" })).toBe(undefined);
  });

  it("drops a stored flag that its provider cannot enforce instead of throwing", () => {
    expect(dataRetentionForConnect({ provider: "anthropic" }, true)).toBe(undefined);
  });
});

describe("zero data retention in the stored connection", () => {
  const input = { provider: "openrouter", apiKey, modelId: CHAT_MODEL };

  it("round trips, and survives an edit that does not mention it or a key rotation", () => {
    const saved = buildModelConnectPlaintext({ ...input, zeroDataRetention: true });
    expect(parseModelSecret(saved)).toMatchObject({ key: apiKey, zeroDataRetention: true });
    const edited = buildModelConnectPlaintext({ provider: "openrouter" }, saved);
    expect(parseModelSecret(edited)).toMatchObject({ key: apiKey, zeroDataRetention: true });
    const rotated = buildModelConnectPlaintext(
      { provider: "openrouter", apiKey: "new-fake-key" },
      saved,
    );
    expect(parseModelSecret(rotated)).toMatchObject({
      key: "new-fake-key",
      zeroDataRetention: true,
    });
  });

  it("clears on an explicit false and goes back to the bare key shape", () => {
    const saved = buildModelConnectPlaintext({ ...input, zeroDataRetention: true });
    const cleared = buildModelConnectPlaintext(
      { provider: "openrouter", zeroDataRetention: false },
      saved,
    );
    expect(parseModelSecret(cleared)).toEqual({ kind: "api_key", key: apiKey });
    expect(buildModelConnectPlaintext(input)).toBe(
      buildModelConnectPlaintext({ ...input, zeroDataRetention: false }),
    );
  });

  it("is never written for a provider without the control", () => {
    expect(() =>
      buildModelConnectPlaintext({ provider: "anthropic", apiKey, zeroDataRetention: true }),
    ).toThrow("cannot restrict data retention");
    expect(
      parseModelSecret(buildModelConnectPlaintext({ provider: "anthropic", apiKey })),
    ).not.toHaveProperty("zeroDataRetention");
  });

  it("counts a stored value that is not true as off", () => {
    for (const stored of ["yes", 1, "true", null, false]) {
      const parsed = parseModelSecret(JSON.stringify({ key: apiKey, zeroDataRetention: stored }));
      expect(parsed).not.toHaveProperty("zeroDataRetention");
    }
    expect(parseModelSecret(serializeModelSecret({ kind: "api_key", key: apiKey }))).toEqual({
      kind: "api_key",
      key: apiKey,
    });
  });

  it("is reported on the credential only while on", () => {
    const row = { id: "credential-fixture", provider: "openrouter", label: "Gateway" };
    const on = buildModelConnectPlaintext({ ...input, zeroDataRetention: true });
    expect(modelCredentialDto(row, on).zeroDataRetention).toBe(true);
    expect(modelCredentialDto(row, buildModelConnectPlaintext(input))).not.toHaveProperty(
      "zeroDataRetention",
    );
    expect(modelCredentialDto(row)).not.toHaveProperty("zeroDataRetention");
  });
});

describe("the catalog", () => {
  it("advertises it on the model named by the deployment's default setting too", () => {
    const previous = process.env.PI_DEFAULT_MODEL;
    process.env.PI_DEFAULT_MODEL = "example/not-in-the-catalog";
    try {
      const entry = listPiCatalog().find((model) => model.id === "example/not-in-the-catalog");
      expect(entry?.dataRetentionControl).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PI_DEFAULT_MODEL;
      else process.env.PI_DEFAULT_MODEL = previous;
    }
  });

  it("advertises the control only for providers that declare it", () => {
    const entries = listPiCatalog();
    const control = new Set(
      entries.filter((entry) => entry.dataRetentionControl).map((entry) => entry.provider),
    );
    expect([...control]).toEqual(["openrouter"]);
    expect(providerHasDataRetentionControl("openrouter")).toBe(true);
    expect(providerHasDataRetentionControl("anthropic")).toBe(false);
    expect(providerHasDataRetentionControl("not-a-provider")).toBe(false);
  });
});

describe("withDataRetention", () => {
  it("restricts routing for the chat completions shape, keeping routing it already has", () => {
    const model = runtime(CHAT_MODEL, { zeroDataRetention: true });
    expect(model?.api).toBe("openai-completions");
    expect(routing(model)).toMatchObject({ zdr: true });
    const base = runtime(CHAT_MODEL) as Model<Api>;
    const merged = withDataRetention(
      {
        ...base,
        compat: { ...base.compat, openRouterRouting: { order: ["example"] } },
      } as Model<Api>,
      { zeroDataRetention: true },
    );
    expect(routing(merged)).toEqual({ order: ["example"], zdr: true });
  });

  it("leaves the model alone when off, absent, or for another provider", () => {
    const before = routing(runtime(CHAT_MODEL));
    expect(routing(runtime(CHAT_MODEL, { zeroDataRetention: false }))).toEqual(before);
    expect(routing(runtime(CHAT_MODEL))).toEqual(before);
    expect(before?.zdr).toBeUndefined();
    const other = resolveRuntimeModel({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      apiKey,
      zeroDataRetention: true,
    }).model;
    expect(routing(other)?.zdr).toBeUndefined();
  });
});

describe("withDataRetentionPayload", () => {
  const body = { model: "m", messages: [] };

  it("adds the provider field to a messages request, merging one that is there", async () => {
    const model = runtime(MESSAGES_MODEL, { zeroDataRetention: true }) as Model<Api>;
    expect(model.api).toBe("anthropic-messages");
    const options = withDataRetentionPayload(model, {} as SimpleStreamOptions);
    expect(await options.onPayload?.(body, model)).toEqual({ ...body, provider: { zdr: true } });
    expect(await options.onPayload?.({ ...body, provider: { order: ["example"] } }, model)).toEqual(
      {
        ...body,
        provider: { order: ["example"], zdr: true },
      },
    );
  });

  it("runs an earlier payload hook first and keeps what it returned", async () => {
    const model = runtime(MESSAGES_MODEL, { zeroDataRetention: true }) as Model<Api>;
    const options = withDataRetentionPayload(model, {
      onPayload: (payload: unknown) => ({ ...(payload as object), added: true }),
    } as SimpleStreamOptions);
    expect(await options.onPayload?.(body, model)).toEqual({
      ...body,
      added: true,
      provider: { zdr: true },
    });
  });

  it("changes nothing for the chat completions shape, when off, or for a body it cannot extend", async () => {
    const chat = runtime(CHAT_MODEL, { zeroDataRetention: true }) as Model<Api>;
    const options: SimpleStreamOptions = {};
    expect(withDataRetentionPayload(chat, options)).toBe(options);
    const off = runtime(MESSAGES_MODEL) as Model<Api>;
    expect(withDataRetentionPayload(off, options)).toBe(options);
    const on = runtime(MESSAGES_MODEL, { zeroDataRetention: true }) as Model<Api>;
    expect(
      await withDataRetentionPayload(on, {} as SimpleStreamOptions).onPayload?.("text", on),
    ).toBeUndefined();
  });
});

describe("the run", () => {
  it("carries the flag only for a connection that has it on", () => {
    const resolved = {
      apiKey,
      connectionId: undefined,
      redact: [] as string[],
      callObserver: undefined,
    };
    expect(resolvedModelRunFields({ ...resolved, zeroDataRetention: true })).toMatchObject({
      zeroDataRetention: true,
    });
    expect(resolvedModelRunFields(resolved)).not.toHaveProperty("zeroDataRetention");
    expect(resolvedModelRunFields({ ...resolved, zeroDataRetention: false })).not.toHaveProperty(
      "zeroDataRetention",
    );
  });
});
