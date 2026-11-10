import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentDeploymentModels } from "./deployment-model.js";
import { createRunExecutor } from "./executor.js";
import { serializeModelSecret } from "./model-secret.js";
import { validateBotModelChange } from "./model-selection.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";
import { autoReviewCheckerProvider } from "./run-auto-review.js";

const scope = { userId: "fixture-user", spaceId: "fixture-space" };
// A public HTTPS endpoint, such as a provider's in-region API, with a placeholder key.
const ENDPOINT = "https://eu.openrouter.ai/api/v1";
const endpointSecret = serializeModelSecret({
  kind: "openai_compatible",
  baseUrl: ENDPOINT,
  apiKey: "fixture-endpoint-key",
  enabledModelIds: ["fixture/endpoint-model"],
});

/** A member with no connections of their own, on a deployment with the given admin settings. */
function executorWith(
  settings: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = {},
  billingEnabled = false,
) {
  const load = vi.fn(async (ciphertext: string) =>
    ciphertext === "cipher-endpoint" ? endpointSecret : "fixture-admin-key",
  );
  const executor = createRunExecutor({
    billingEnabled,
    deploymentModels: environmentDeploymentModels(environment),
    prisma: {
      user: { findUnique: vi.fn(async () => null) },
      userModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => settings) },
    },
    secretStore: { load, put: vi.fn() },
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { executor, load };
}

describe("deployment-served models at run time", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("runs an allowed model on the admin's key, and refuses one the list leaves out", async () => {
    const { executor, load } = executorWith({
      allowedModels: "anthropic:claude-opus-4-5",
      modelConnections: [{ provider: "anthropic", ciphertext: "cipher-anthropic", models: [] }],
    });
    await expect(
      executor.resolveConnectedModel(scope, "anthropic", "claude-opus-4-5"),
    ).resolves.toMatchObject({
      provider: "anthropic",
      id: "claude-opus-4-5",
      apiKey: "fixture-admin-key",
    });
    expect(load).toHaveBeenCalledWith("cipher-anthropic", "deployment-model:anthropic");
    await expect(
      executor.resolveConnectedModel(scope, "anthropic", "claude-haiku-5-5"),
    ).rejects.toThrow("Connect that model provider first");
  });

  it("runs a served model as a backup or fallback, and redacts the admin's key there", async () => {
    const { executor } = executorWith({
      allowedModels: "anthropic:*",
      modelConnections: [{ provider: "anthropic", ciphertext: "cipher-anthropic", models: [] }],
    });
    const registered: string[] = [];
    await expect(
      executor.resolveConnectedModel(
        scope,
        "anthropic",
        "claude-opus-4-5",
        (values) => registered.push(...values),
        true,
      ),
    ).resolves.toMatchObject({ apiKey: "fixture-admin-key" });
    expect(registered).toContain("fixture-admin-key");
  });

  it("serves nothing beyond hosted credits while model credits bill", async () => {
    const { executor } = executorWith(
      {
        allowedModels: "anthropic:*",
        modelConnections: [{ provider: "anthropic", ciphertext: "cipher-anthropic", models: [] }],
      },
      {},
      true,
    );
    await expect(
      executor.resolveConnectedModel(scope, "anthropic", "claude-opus-4-5"),
    ).rejects.toThrow("Connect that model provider first");
  });

  it("lets a member's approval model run on a model the deployment serves", async () => {
    const deps = {
      billingEnabled: false,
      deploymentModels: environmentDeploymentModels({}),
      prisma: {
        userModelPreference: { findFirst: vi.fn(async () => null) },
        userModelCredential: { findFirst: vi.fn(async () => null) },
        deploymentSettings: {
          findUnique: vi.fn(async () => ({
            allowedModels: "anthropic:*",
            modelConnections: [
              { provider: "anthropic", ciphertext: "cipher-anthropic", models: [] },
            ],
          })),
        },
      },
      secretStore: { load: vi.fn(async () => "fixture-admin-key") },
    } as unknown as Parameters<typeof autoReviewCheckerProvider>[0];
    const registerSecrets = vi.fn();
    const run = {
      runId: "run",
      spaceId: scope.spaceId,
      userId: scope.userId,
      botId: "bot",
      threadId: "thread",
    };
    await expect(
      autoReviewCheckerProvider(
        deps,
        run,
        { memberChecker: true, registerSecrets },
        {
          provider: "anthropic",
          model: "claude-opus-4-5",
        },
      ),
    ).resolves.toBeDefined();
    expect(registerSecrets).toHaveBeenCalledWith(["fixture-admin-key"]);
    // A choice pinned to a connection runs only there.
    await expect(
      autoReviewCheckerProvider(
        deps,
        run,
        { memberChecker: true, registerSecrets },
        {
          provider: "anthropic",
          model: "claude-opus-4-5",
          credentialId: "gone",
        },
      ),
    ).rejects.toThrow("Selected checker connection is unavailable");
  });

  it("keeps an upgraded deployment's environment keys to the default model", async () => {
    const { executor } = executorWith(
      {},
      {
        OPENROUTER_API_KEY: "fixture-openrouter-key",
        ANTHROPIC_API_KEY: "fixture-anthropic-key",
      },
    );
    await expect(
      executor.resolveConnectedModel(scope, "anthropic", "claude-opus-4-5"),
    ).rejects.toThrow("Connect that model provider first");
  });

  it("runs a public HTTPS compatible endpoint with the same output caps as a member's", async () => {
    const { executor } = executorWith({
      allowedModels: "openai-compatible:*",
      modelConnections: [
        {
          provider: "openai-compatible",
          ciphertext: "cipher-endpoint",
          models: ["fixture/endpoint-model"],
        },
      ],
    });
    const model = await executor.resolveConnectedModel(
      scope,
      "openai-compatible",
      "fixture/endpoint-model",
    );
    expect(model).toMatchObject({
      provider: "openai-compatible",
      id: "fixture/endpoint-model",
      baseUrl: ENDPOINT,
      apiKey: "fixture-endpoint-key",
    });
    // No limits saved: none are sent, so the runtime applies its usual defaults.
    expect(model.maxTokens).toBeUndefined();
    expect(model.contextWindow).toBeUndefined();
    const member = resolveRuntimeModel({
      provider: "openai-compatible",
      id: "fixture/endpoint-model",
      baseUrl: ENDPOINT,
      apiKey: "fixture-member-key",
      thinkingLevel: null,
    }).model;
    const deployment = resolveRuntimeModel(model).model;
    expect(deployment?.maxTokens).toBe(DEFAULT_MODEL_MAX_TOKENS);
    expect(deployment?.maxTokens).toBe(member?.maxTokens);
    expect(deployment?.contextWindow).toBe(member?.contextWindow);
  });
});

describe("bot model changes", () => {
  const deps = (allowed: string) => ({
    prisma: {
      userModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient,
    secretStore: { load: vi.fn() },
    refreshExpiredCredential: vi.fn(),
    defaultModel: async () => ({ provider: null, model: null }),
    deployment: environmentDeploymentModels({
      DEEPSEEK_API_KEY: "fixture-deepseek-key",
      PI_DEPLOYMENT_MODELS: allowed,
    }),
  });
  const change = { ...scope, provider: "deepseek", model: "deepseek-v4-pro" };

  it("accepts a model the deployment serves without the member's own connection", async () => {
    await expect(validateBotModelChange(deps("deepseek:*"), change)).resolves.toMatchObject({
      ok: true,
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
  });

  it("refuses one the deployment does not serve", async () => {
    await expect(validateBotModelChange(deps(""), change)).resolves.toEqual({
      ok: false,
      error: "Connect that model provider first",
    });
  });
});
