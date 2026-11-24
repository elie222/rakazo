import { afterEach, describe, expect, it } from "vitest";
import {
  carriedBotModelPin,
  carriedRoutineModelPin,
  modelProviderAllowed,
  modelProviderAllowlist,
} from "./model-provider-allowlist.js";

const savedAllowlist = process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;

afterEach(() => {
  if (savedAllowlist === undefined) delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
  else process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = savedAllowlist;
});

describe("model provider allowlist", () => {
  it("is unset without the environment variable, and blank counts as unset", () => {
    delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
    expect(modelProviderAllowlist()).toBeNull();
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "";
    expect(modelProviderAllowlist()).toBeNull();
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = " , ";
    expect(modelProviderAllowlist()).toBeNull();
  });

  it("splits on commas and trims each id", () => {
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = " openrouter , anthropic ,openrouter";
    expect(modelProviderAllowlist()).toEqual(new Set(["openrouter", "anthropic"]));
  });

  it("allows every provider when unset, and matches through canonical provider ids", () => {
    delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
    expect(modelProviderAllowed(modelProviderAllowlist(), "anthropic")).toBe(true);
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "azure";
    expect(modelProviderAllowed(modelProviderAllowlist(), "azure-openai-responses")).toBe(true);
    expect(modelProviderAllowed(modelProviderAllowlist(), "anthropic")).toBe(false);
  });

  it("folds and canonicalizes entries, so a renamed or capitalized id still matches", () => {
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "OpenRouter , azure-openai-responses";
    expect(modelProviderAllowed(modelProviderAllowlist(), "openrouter")).toBe(true);
    expect(modelProviderAllowed(modelProviderAllowlist(), "azure")).toBe(true);
    expect(modelProviderAllowed(modelProviderAllowlist(), "anthropic")).toBe(false);
  });
});

describe("a bot pin a copy or a restored record carries", () => {
  it("keeps the provider and model when the allowlist is unset", () => {
    delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
    expect(
      carriedBotModelPin({
        modelProvider: "anthropic",
        modelId: "claude-haiku-5-5",
        thinkingLevel: "high",
      }),
    ).toEqual({ modelProvider: "anthropic", modelId: "claude-haiku-5-5", thinkingLevel: "high" });
  });

  it("drops a refused provider and model but keeps the thinking level", () => {
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "openrouter";
    expect(
      carriedBotModelPin({
        modelProvider: "anthropic",
        modelId: "claude-haiku-5-5",
        thinkingLevel: "high",
      }),
    ).toEqual({ thinkingLevel: "high" });
  });

  it("keeps a thinking level set on a bot that follows the account main model", () => {
    for (const allowlist of [undefined, "openrouter"]) {
      if (allowlist === undefined) delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
      else process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = allowlist;
      expect(
        carriedBotModelPin({ modelProvider: null, modelId: null, thinkingLevel: "low" }),
      ).toEqual({ thinkingLevel: "low" });
    }
  });
});

describe("a routine pin a restored record carries", () => {
  it("keeps the level with the model, since a routine refuses a level without one", () => {
    delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
    expect(
      carriedRoutineModelPin({
        modelProvider: "anthropic",
        modelId: "claude-haiku-5-5",
        thinkingLevel: "high",
      }),
    ).toEqual({ modelProvider: "anthropic", modelId: "claude-haiku-5-5", thinkingLevel: "high" });
  });

  it("drops the level along with a refused pin, and with no pin at all", () => {
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "openrouter";
    expect(
      carriedRoutineModelPin({
        modelProvider: "anthropic",
        modelId: "claude-haiku-5-5",
        thinkingLevel: "high",
      }),
    ).toEqual({});
    expect(carriedRoutineModelPin({ modelProvider: null, thinkingLevel: "high" })).toEqual({});
  });
});
