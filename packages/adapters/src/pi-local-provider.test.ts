import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_PROVIDER_ID,
  localBaseUrl,
  localProvider,
  registerLocalProvider,
} from "./pi-local-provider.js";

const ENV_KEYS = [
  "RAKAZO_LOCAL_MODELS",
  "RAKAZO_LOCAL_MODELS_URL",
  "RAKAZO_LOCAL_CONTEXT_WINDOW",
  "RAKAZO_LOCAL_MAX_TOKENS",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setModels(value: string | undefined) {
  if (value === undefined) delete process.env.RAKAZO_LOCAL_MODELS;
  else process.env.RAKAZO_LOCAL_MODELS = value;
}

describe("local model provider", () => {
  it("stays absent when no local models are configured", () => {
    setModels(undefined);
    expect(localProvider()).toBeUndefined();

    // Blank and whitespace-only values are configuration noise, not a model id.
    setModels("");
    expect(localProvider()).toBeUndefined();
    setModels("  ,  ,");
    expect(localProvider()).toBeUndefined();
  });

  it("exposes each configured model id verbatim", () => {
    setModels("qwen3:4b, llama3.1:8b");
    const provider = localProvider();
    expect(provider?.id).toBe(LOCAL_PROVIDER_ID);
    expect(provider?.getModels().map((model) => model.id)).toEqual(["qwen3:4b", "llama3.1:8b"]);
  });

  it("bills nothing, because the model runs on the operator's own hardware", () => {
    setModels("qwen3:4b");
    const model = localProvider()?.getModels()[0];
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("defaults to the Ollama endpoint and honours an override", () => {
    delete process.env.RAKAZO_LOCAL_MODELS_URL;
    expect(localBaseUrl()).toBe("http://127.0.0.1:11434/v1");

    process.env.RAKAZO_LOCAL_MODELS_URL = "http://127.0.0.1:1234/v1";
    setModels("some-local-model");
    expect(localBaseUrl()).toBe("http://127.0.0.1:1234/v1");
    expect(localProvider()?.getModels()[0]?.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("registers onto a Models collection only when configured", () => {
    setModels(undefined);
    const bare = registerLocalProvider(builtinModels());
    expect(bare.getProviders().some((p) => p.id === LOCAL_PROVIDER_ID)).toBe(false);

    setModels("qwen3:4b");
    const withLocal = registerLocalProvider(builtinModels());
    expect(withLocal.getModel(LOCAL_PROVIDER_ID, "qwen3:4b")).toBeDefined();
  });
});
