import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentModels } from "./deployment-model.js";
import {
  allowlistOpens,
  allowlistWithProvider,
  applyDeploymentModelSettings,
  defaultOnlyDeploymentModels,
  deploymentConnection,
  deploymentConnectionSecret,
  deploymentServedModels,
  deploymentServes,
  environmentDeploymentModels,
  parseModelAllowlist,
  resolveDeploymentModel,
} from "./deployment-model.js";

// Host credentials come from the process, so blank the ones a developer machine or CI
// host may carry; each case states its own.
const HOST_CREDENTIAL_ENV = [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
];

describe("resolveDeploymentModel", () => {
  beforeEach(() => {
    for (const name of HOST_CREDENTIAL_ENV) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pairs the deployment model key with the provider it belongs to", () => {
    const both = {
      OPENROUTER_API_KEY: "or-key",
      ANTHROPIC_API_KEY: "sk-ant-key",
      DEEPSEEK_API_KEY: "sk-deepseek-key",
    };
    expect(resolveDeploymentModel(both)).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-5.5",
      key: "or-key",
      configured: true,
      hostCredentials: false,
    });
    // Switching the provider switches the key with it.
    expect(resolveDeploymentModel({ ...both, PI_DEFAULT_PROVIDER: "anthropic" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      key: "sk-ant-key",
      configured: true,
      hostCredentials: false,
    });
    expect(resolveDeploymentModel({ ...both, PI_DEFAULT_PROVIDER: "deepseek" })).toEqual({
      provider: "deepseek",
      model: "deepseek-flash",
      key: "sk-deepseek-key",
      configured: true,
      hostCredentials: false,
    });
    expect(
      resolveDeploymentModel({
        ...both,
        PI_DEFAULT_PROVIDER: "deepseek",
        PI_DEFAULT_MODEL: "deepseek-v4-pro",
      }),
    ).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      key: "sk-deepseek-key",
      configured: true,
      hostCredentials: false,
    });
    // A provider with no key configured yields no key — never another vendor's.
    expect(
      resolveDeploymentModel({ OPENROUTER_API_KEY: "or-key", PI_DEFAULT_PROVIDER: "anthropic" }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      key: undefined,
      configured: false,
      hostCredentials: false,
    });
  });

  it("runs a provider that authenticates from the host without a key", () => {
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/example");
    const taskRole = {
      PI_DEFAULT_PROVIDER: "amazon-bedrock",
      PI_DEFAULT_MODEL: "eu.anthropic.claude-sonnet-5",
      PI_DEFAULT_CREDENTIALS: "host",
    };
    expect(resolveDeploymentModel(taskRole)).toEqual({
      provider: "amazon-bedrock",
      model: "eu.anthropic.claude-sonnet-5",
      key: undefined,
      configured: true,
      hostCredentials: true,
    });
  });

  it("leaves a deployment that did not opt in unchanged, even with host credentials", () => {
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/example");
    const withoutOptIn = {
      PI_DEFAULT_PROVIDER: "amazon-bedrock",
      PI_DEFAULT_MODEL: "eu.anthropic.claude-sonnet-5",
    };
    expect(resolveDeploymentModel(withoutOptIn).configured).toBe(false);
    expect(
      resolveDeploymentModel({ ...withoutOptIn, PI_DEFAULT_CREDENTIALS: "true" }).configured,
    ).toBe(false);
  });

  it("allows Bedrock instance roles without environment credentials, but requires an explicit model", () => {
    const provider = { PI_DEFAULT_PROVIDER: "amazon-bedrock", PI_DEFAULT_CREDENTIALS: "host" };
    expect(resolveDeploymentModel(provider).configured).toBe(false);
    expect(
      resolveDeploymentModel({ ...provider, PI_DEFAULT_MODEL: "eu.anthropic.claude-sonnet-5" }),
    ).toMatchObject({
      configured: true,
      hostCredentials: true,
      key: undefined,
    });
  });

  it("does not assume host authentication for other providers", () => {
    expect(
      resolveDeploymentModel({
        PI_DEFAULT_PROVIDER: "unknown",
        PI_DEFAULT_MODEL: "example-model",
        PI_DEFAULT_CREDENTIALS: "host",
      }).configured,
    ).toBe(false);
  });

  it("allows an explicitly declared keyless local model as the deployment default", () => {
    expect(
      resolveDeploymentModel({
        PI_DEFAULT_PROVIDER: " local ",
        PI_DEFAULT_MODEL: " example-model ",
        PI_DEFAULT_CREDENTIALS: " host ",
        RAKAZO_LOCAL_MODELS: "other-model, , example-model ,",
        OPENROUTER_API_KEY: "or-key",
      }),
    ).toEqual({
      provider: "local",
      model: "example-model",
      key: undefined,
      configured: true,
      hostCredentials: true,
    });
  });

  it.each([
    { RAKAZO_LOCAL_MODELS: undefined },
    { RAKAZO_LOCAL_MODELS: " , , " },
    { RAKAZO_LOCAL_MODELS: "example-model-extra,other-example-model" },
    { RAKAZO_LOCAL_MODELS: "EXAMPLE-MODEL" },
    { PI_DEFAULT_MODEL: undefined },
    { PI_DEFAULT_MODEL: " " },
    { PI_DEFAULT_CREDENTIALS: undefined },
    { PI_DEFAULT_CREDENTIALS: "true" },
    { PI_DEFAULT_PROVIDER: "unknown" },
  ])("rejects a keyless local default without declaration and opt-in: %j", (overrides) => {
    expect(
      resolveDeploymentModel({
        PI_DEFAULT_PROVIDER: "local",
        PI_DEFAULT_MODEL: "example-model",
        PI_DEFAULT_CREDENTIALS: "host",
        RAKAZO_LOCAL_MODELS: "example-model",
        ...overrides,
      }),
    ).toMatchObject({ key: undefined, configured: false, hostCredentials: false });
  });
});

describe("deployment models", () => {
  beforeEach(() => {
    for (const name of HOST_CREDENTIAL_ENV) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const keys = {
    OPENROUTER_API_KEY: "fixture-openrouter-key",
    ANTHROPIC_API_KEY: "fixture-anthropic-key",
    DEEPSEEK_API_KEY: "fixture-deepseek-key",
  };

  it("serves only the default model without an allowlist, as before it existed", () => {
    const models = environmentDeploymentModels({ ...keys, PI_DEFAULT_PROVIDER: "deepseek" });
    expect(models.connections.map((connection) => connection.provider)).toEqual([
      "openrouter",
      "anthropic",
      "deepseek",
    ]);
    expect(deploymentServes(models, "deepseek", "deepseek-flash")).toBe(true);
    // Another model of the default's provider, or another keyed provider, needs an allowlist.
    expect(deploymentServes(models, "deepseek", "deepseek-v4-pro")).toBe(false);
    expect(deploymentServes(models, "anthropic", "claude-haiku-5-5")).toBe(false);
    expect(deploymentServedModels(models)).toEqual([
      { provider: "deepseek", id: "deepseek-flash" },
    ]);
  });

  it("opens models a deployment connection runs only as the allowlist names them", () => {
    const models = environmentDeploymentModels({
      ...keys,
      OPENROUTER_API_KEY: "",
      PI_DEFAULT_PROVIDER: "deepseek",
      PI_DEPLOYMENT_MODELS: "anthropic:claude-haiku-5-5, deepseek:*, openrouter:*, bogus",
    });
    expect(models.allowed).toEqual(["anthropic:claude-haiku-5-5", "deepseek:*", "openrouter:*"]);
    expect(deploymentServes(models, "anthropic", "claude-haiku-5-5")).toBe(true);
    expect(deploymentServes(models, "anthropic", "claude-opus-4-5")).toBe(false);
    expect(deploymentServes(models, "deepseek", "deepseek-v4-pro")).toBe(true);
    // Listed, but the deployment has no key for it.
    expect(deploymentServes(models, "openrouter", "anthropic/claude-haiku-5.5")).toBe(false);
    // Only models of the provider's catalog, never an arbitrary id.
    expect(deploymentServes(models, "deepseek", "not-a-catalog-model")).toBe(false);
    expect(
      deploymentServes(
        environmentDeploymentModels({ ...keys, PI_DEPLOYMENT_MODELS: "*" }),
        "anthropic",
        "claude-opus-4-5",
      ),
    ).toBe(true);
  });

  it("serves the local model server's own models when listed, keyless", () => {
    const models = environmentDeploymentModels({
      ...keys,
      RAKAZO_LOCAL_MODELS: "fixture-local-a,fixture-local-b",
      PI_DEPLOYMENT_MODELS: "local:*",
    });
    expect(deploymentConnection(models, "local")).toMatchObject({
      keyless: true,
      models: ["fixture-local-a", "fixture-local-b"],
    });
    expect(deploymentServes(models, "local", "fixture-local-b")).toBe(true);
    expect(deploymentServes(models, "local", "fixture-local-c")).toBe(false);
  });

  it("puts an admin's connections, default and list over the environment's, and clearing restores it", () => {
    const environment = environmentDeploymentModels({
      ...keys,
      PI_DEPLOYMENT_MODELS: "deepseek:*",
    });
    const saved = {
      defaultModelProvider: "anthropic",
      defaultModelId: "claude-haiku-5-5",
      allowedModels: "anthropic:claude-opus-4-5",
      modelConnections: [{ provider: "anthropic", ciphertext: "fixture-ciphertext" }],
    };
    const models = applyDeploymentModelSettings(environment, saved);
    expect(models.default).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      configured: true,
      hostCredentials: false,
    });
    expect(deploymentConnection(models, "anthropic")).toEqual({
      provider: "anthropic",
      source: "settings",
      ciphertext: "fixture-ciphertext",
    });
    expect(deploymentServes(models, "anthropic", "claude-opus-4-5")).toBe(true);
    // The admin's list replaces the environment's rather than adding to it.
    expect(deploymentServes(models, "deepseek", "deepseek-v4-pro")).toBe(false);
    // An empty list serves only the default; no list at all follows the environment again.
    expect(
      applyDeploymentModelSettings(environment, { ...saved, allowedModels: "" }).allowed,
    ).toEqual([]);
    expect(applyDeploymentModelSettings(environment, null)).toEqual(environment);
    expect(
      applyDeploymentModelSettings(environment, {
        defaultModelProvider: null,
        defaultModelId: null,
        allowedModels: null,
        modelConnections: [],
      }),
    ).toEqual(environment);
  });

  it("keeps a default only a missing connection could run from running", () => {
    const models = applyDeploymentModelSettings(environmentDeploymentModels({}), {
      defaultModelProvider: "anthropic",
      defaultModelId: "claude-haiku-5-5",
    });
    expect(models.default.configured).toBe(false);
    expect(deploymentServes(models, "anthropic", "claude-haiku-5-5")).toBe(false);
  });

  it("lets an admin's key run the environment's default provider", () => {
    const models = applyDeploymentModelSettings(environmentDeploymentModels({}), {
      modelConnections: [{ provider: "openrouter", ciphertext: "fixture-ciphertext" }],
    });
    expect(models.default).toMatchObject({ provider: "openrouter", configured: true });
  });

  it("reads an admin's key only through the secret store, and the environment's as it is", async () => {
    const load = vi.fn(async () => "fixture-admin-key");
    const models = applyDeploymentModelSettings(environmentDeploymentModels(keys), {
      modelConnections: [{ provider: "anthropic", ciphertext: "fixture-ciphertext" }],
    });
    await expect(
      deploymentConnectionSecret({ load }, deploymentConnection(models, "anthropic")),
    ).resolves.toEqual({ kind: "api_key", key: "fixture-admin-key" });
    expect(load).toHaveBeenCalledWith("fixture-ciphertext", "deployment-model:anthropic");
    await expect(
      deploymentConnectionSecret({ load }, deploymentConnection(models, "deepseek")),
    ).resolves.toEqual({ kind: "api_key", key: "fixture-deepseek-key" });
  });

  it("derives a default-only view for callers that hold just the default", () => {
    const models = defaultOnlyDeploymentModels(resolveDeploymentModel(keys));
    expect(models.allowed).toEqual([]);
    expect(models.connections).toEqual([
      {
        provider: "openrouter",
        source: "environment",
        key: "fixture-openrouter-key",
        keyless: false,
      },
    ]);
  });

  it("gives a saved default no connection runs way to the environment's", () => {
    const environment = environmentDeploymentModels(keys);
    const models = applyDeploymentModelSettings(environment, {
      defaultModelProvider: "openai-compatible",
      defaultModelId: "dropped",
      modelConnections: [
        { provider: "openai-compatible", ciphertext: "fixture", models: ["kept"] },
      ],
    });
    expect(models.default).toEqual(environment.default);
  });

  it("runs the environment's default on an admin's endpoint only if the endpoint lists it", () => {
    const environment: DeploymentModels = {
      default: {
        provider: "openai-compatible",
        model: "fixture/env-model",
        key: "fixture-env-key",
        configured: true,
        hostCredentials: false,
      },
      connections: [
        {
          provider: "openai-compatible",
          source: "environment",
          key: "fixture-env-key",
          models: ["fixture/env-model"],
        },
      ],
      allowed: [],
    };
    const replaced = (models: string[]) =>
      applyDeploymentModelSettings(environment, {
        modelConnections: [{ provider: "openai-compatible", ciphertext: "fixture", models }],
      });
    const without = replaced(["fixture/admin-model"]);
    expect(without.default.configured).toBe(false);
    expect(deploymentServes(without, "openai-compatible", "fixture/env-model")).toBe(false);
    const listing = replaced(["fixture/admin-model", "fixture/env-model"]);
    expect(listing.default.configured).toBe(true);
    expect(deploymentServes(listing, "openai-compatible", "fixture/env-model")).toBe(true);
  });

  it("keeps the environment's default while model credits bill", () => {
    const environment = environmentDeploymentModels(keys);
    const saved = {
      defaultModelProvider: "anthropic",
      defaultModelId: "claude-opus-4-5",
      modelCreditsEnabled: true,
    };
    expect(applyDeploymentModelSettings(environment, saved).default).toEqual(environment.default);
    expect(
      applyDeploymentModelSettings(environment, saved, { creditsOnly: false }).default,
    ).toMatchObject({ provider: "anthropic", model: "claude-opus-4-5" });
  });

  it("opens or closes one provider's models in the list", () => {
    expect(allowlistOpens(["anthropic:claude-opus-4-5"], "anthropic")).toBe(true);
    expect(allowlistOpens(["*"], "deepseek")).toBe(true);
    expect(allowlistOpens(["deepseek:*"], "anthropic")).toBe(false);
    const providers = ["anthropic", "deepseek"];
    expect(
      allowlistWithProvider(["anthropic:claude-opus-4-5"], providers, "anthropic", true),
    ).toEqual(["anthropic:*"]);
    expect(allowlistWithProvider(["*"], providers, "anthropic", false)).toEqual(["deepseek:*"]);
    expect(
      allowlistWithProvider(
        ["deepseek:*", "anthropic:claude-opus-4-5"],
        providers,
        "anthropic",
        false,
      ),
    ).toEqual(["deepseek:*"]);
  });

  it("parses allowlist entries with canonical providers", () => {
    expect(parseModelAllowlist(" * ,\nopenrouter:meta/llama:free,:x,openrouter:")).toEqual([
      "*",
      "openrouter:meta/llama:free",
    ]);
  });
});
