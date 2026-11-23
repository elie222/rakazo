import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPiCatalog } from "../runtime/pi/models/pi-models.js";
import {
  adminDeploymentModel,
  deploymentModelProviders,
  matchingAdminDeploymentModel,
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

describe("an admin's default for everyone", () => {
  const saved = {
    deploymentModelProvider: "anthropic",
    deploymentModelId: "claude-sonnet-5",
    deploymentModelCredentialCipher: "sealed-admin-key",
    modelCreditsEnabled: false,
  };
  beforeEach(() => vi.stubEnv("RAKAZO_LOCAL_MODELS", "example-local-model"));
  afterEach(() => vi.unstubAllEnvs());

  it("applies only with its key, without credits and while the allowlist offers it", () => {
    expect(adminDeploymentModel(saved)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      cipher: "sealed-admin-key",
    });
    // A default saved without a key is the environment's own.
    expect(adminDeploymentModel({ ...saved, deploymentModelCredentialCipher: null })).toBeNull();
    expect(adminDeploymentModel({ ...saved, modelCreditsEnabled: true })).toBeNull();
    expect(
      adminDeploymentModel(saved, {
        MODEL_CREDIT_OFFERINGS: JSON.stringify({ defaultOfferingId: null, offerings: [] }),
      }),
    ).toBeNull();
    vi.stubEnv("RAKAZO_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    expect(adminDeploymentModel(saved)).toBeNull();
  });

  it("matches only the provider and model the admin selected", () => {
    expect(matchingAdminDeploymentModel(saved, "anthropic", "claude-sonnet-5")).toMatchObject({
      cipher: "sealed-admin-key",
    });
    expect(matchingAdminDeploymentModel(saved, "openrouter", "claude-sonnet-5")).toBeNull();
    expect(matchingAdminDeploymentModel(saved, "anthropic", "claude-opus-5")).toBeNull();
  });

  it("offers only providers that connect with a key alone", () => {
    expect(listPiCatalog()).toContainEqual(
      expect.objectContaining({ provider: "local", id: "example-local-model" }),
    );
    const providers = deploymentModelProviders();
    const ids = providers.map((provider) => provider.id);
    expect(ids).toContain("anthropic");
    expect(ids).not.toContain("local");
    expect(ids).not.toContain("openai-compatible");
    expect(ids).not.toContain("openai-codex");
    expect(ids).not.toContain("google-vertex");
    expect(providers.find((provider) => provider.id === "anthropic")?.models).toContainEqual(
      expect.objectContaining({ id: "claude-sonnet-5" }),
    );
  });
});
