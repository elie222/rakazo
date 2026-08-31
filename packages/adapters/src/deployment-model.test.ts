import { describe, expect, it } from "vitest";
import { resolveDeploymentModel } from "./deployment-model.js";

describe("resolveDeploymentModel", () => {
  it("pairs the deployment model key with the provider it belongs to", () => {
    const both = { OPENROUTER_API_KEY: "or-key", ANTHROPIC_API_KEY: "sk-ant-key" };
    expect(resolveDeploymentModel(both)).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-0731",
      key: "or-key",
    });
    // The whole point: switching the provider switches the key with it.
    expect(resolveDeploymentModel({ ...both, PI_DEFAULT_PROVIDER: "anthropic" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      key: "sk-ant-key",
    });
    // A provider with no key configured yields no key — never another vendor's.
    expect(
      resolveDeploymentModel({ OPENROUTER_API_KEY: "or-key", PI_DEFAULT_PROVIDER: "anthropic" }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-5", key: undefined });
  });

  it("pairs the OrcaRouter deployment key with the orcarouter provider", () => {
    const env = { ORCAROUTER_API_KEY: "orc-key", OPENROUTER_API_KEY: "or-key" };
    expect(resolveDeploymentModel({ ...env, PI_DEFAULT_PROVIDER: "orcarouter" })).toEqual({
      provider: "orcarouter",
      model: "orcarouter/auto",
      key: "orc-key",
    });
    // OpenRouter keeps its own key when it is the default provider.
    expect(resolveDeploymentModel(env)).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-0731",
      key: "or-key",
    });
  });
});
