import { afterEach, describe, expect, it } from "vitest";
import { modelProviderAllowed, modelProviderAllowlist } from "./model-provider-allowlist.js";

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
