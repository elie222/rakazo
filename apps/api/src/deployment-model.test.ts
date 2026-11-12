import { environmentDeploymentModels, parseModelSecret } from "@rakazo/adapters";
import type { ModelCatalogEntry } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectDeploymentModel,
  currentDeploymentModels,
  disconnectDeploymentModel,
  getDeploymentModelSettings,
  probeDeploymentModels,
  updateDeploymentModelSettings,
} from "./deployment-model.js";
import { assertNoDanglingModelPins } from "./model-pins.js";
import { createRouterContext } from "./routes/context.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "admin@example.com" } as never;
// A public HTTPS endpoint, such as a provider's in-region API. No real key is used.
const ENDPOINT = "https://eu.openrouter.ai/api/v1";

type Connection = { provider: string; ciphertext: string; models: string[] };

/** An in-memory settings row, its connections and a secret store behind the admin calls. */
function makeDeps(options: { admin?: boolean; env?: NodeJS.ProcessEnv; keyStatus?: number } = {}) {
  const state = {
    settings: { id: "default" } as Record<string, unknown>,
    connections: new Map<string, Connection>(),
    secrets: new Map<string, string>(),
  };
  let nextSecret = 0;
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        ...state.settings,
        modelConnections: [...state.connections.values()],
      })),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
        state.settings = { ...state.settings, ...update };
        return state.settings;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { defaultModelProvider: string; defaultModelId?: { notIn: string[] } };
          data: object;
        }) => {
          if (
            state.settings.defaultModelProvider !== where.defaultModelProvider ||
            where.defaultModelId?.notIn.includes(String(state.settings.defaultModelId))
          )
            return { count: 0 };
          state.settings = { ...state.settings, ...data };
          return { count: 1 };
        },
      ),
    },
    deploymentModelConnection: {
      findUnique: vi.fn(
        async ({ where }: { where: { provider: string } }) =>
          state.connections.get(where.provider) ?? null,
      ),
      upsert: vi.fn(
        async ({ where, create }: { where: { provider: string }; create: Connection }) => {
          state.connections.set(where.provider, create);
        },
      ),
      delete: vi.fn(async ({ where }: { where: { provider: string } }) => {
        state.connections.delete(where.provider);
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${ENDPOINT}/models`)
      return Response.json({ data: [{ id: "fixture/first" }, { id: "fixture/second" }] });
    return new Response(null, { status: options.keyStatus ?? 200 });
  });
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: {
      put: vi.fn(async (plaintext: string) => {
        const id = `cipher-${++nextSecret}`;
        state.secrets.set(id, plaintext);
        return { id, ref: id, ciphertext: id };
      }),
      load: vi.fn(async (ciphertext: string) => state.secrets.get(ciphertext) ?? ""),
      delete: vi.fn(async (ciphertext: string) => {
        state.secrets.delete(ciphertext);
      }),
    },
    modelConnectionFetch: fetch as unknown as typeof globalThis.fetch,
    env: {
      adminEmails: options.admin === false ? [] : ["admin@example.com"],
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-haiku-5.5",
      deploymentModels: environmentDeploymentModels(options.env ?? {}),
    },
  };
  return { deps, state, fetch };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("deployment model settings", () => {
  it("is for admins only", async () => {
    const { deps } = makeDeps({ admin: false });
    await expect(getDeploymentModelSettings(deps, actor)).rejects.toThrow("Admins only");
    await expect(
      updateDeploymentModelSettings(deps, actor, { allowedModels: ["*"] }),
    ).rejects.toThrow("Admins only");
    await expect(
      connectDeploymentModel(deps, actor, { provider: "deepseek", apiKey: "fixture-key" }),
    ).rejects.toThrow("Admins only");
    await expect(disconnectDeploymentModel(deps, actor, { provider: "deepseek" })).rejects.toThrow(
      "Admins only",
    );
    await expect(
      probeDeploymentModels(deps, actor, { baseUrl: ENDPOINT, apiKey: "" }),
    ).rejects.toThrow("Admins only");
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it("checks and encrypts a key, and never returns it", async () => {
    const { deps, state, fetch } = makeDeps();
    const view = await connectDeploymentModel(deps, actor, {
      provider: "deepseek",
      apiKey: "fixture-deepseek-key",
    });
    expect(fetch).toHaveBeenCalled();
    expect(deps.secrets.put).toHaveBeenCalledWith("fixture-deepseek-key", expect.anything(), {
      recordId: "deployment-model:deepseek",
    });
    expect([...state.connections.values()]).toEqual([
      { provider: "deepseek", ciphertext: "cipher-1", models: [] },
    ]);
    expect(view.connections).toEqual([
      expect.objectContaining({ provider: "deepseek", name: "DeepSeek", saved: true }),
    ]);
    expect(JSON.stringify(view)).not.toContain("fixture-deepseek-key");

    // A blank key keeps the saved one.
    await connectDeploymentModel(deps, actor, { provider: "deepseek", apiKey: "" });
    expect(deps.secrets.put).toHaveBeenCalledOnce();
    expect(state.secrets.get("cipher-1")).toBe("fixture-deepseek-key");

    // A replaced key is removed from the store.
    await connectDeploymentModel(deps, actor, {
      provider: "deepseek",
      apiKey: "fixture-next-key",
    });
    expect(deps.secrets.delete).toHaveBeenCalledWith("cipher-1", "deployment-model:deepseek");
  });

  it("saves nothing for a key the provider rejects", async () => {
    const { deps, state } = makeDeps({ keyStatus: 401 });
    await expect(
      connectDeploymentModel(deps, actor, { provider: "deepseek", apiKey: "fixture-bad-key" }),
    ).rejects.toThrow();
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(state.connections.size).toBe(0);
  });

  it("checks a catalog key as a member's is, and takes only one that reads back as a key", async () => {
    const { deps, state } = makeDeps();
    const endpoint = JSON.stringify({
      kind: "openai_compatible",
      baseUrl: "https://elsewhere.example.test/v1",
    });
    await expect(
      connectDeploymentModel(deps, actor, { provider: "deepseek", apiKey: endpoint }),
    ).rejects.toThrow("Enter an API key");
    await expect(
      connectDeploymentModel(deps, actor, { provider: "deepseek", apiKey: "short" }),
    ).rejects.toThrow("at least 8 characters");
    expect(state.connections.size).toBe(0);
    await connectDeploymentModel(deps, actor, { provider: "deepseek", apiKey: " fixture-key " });
    const [stored] = [...state.secrets.values()];
    expect(parseModelSecret(stored!)).toEqual({ kind: "api_key", key: "fixture-key" });
  });

  it("asks for a key on a new connection", async () => {
    const { deps } = makeDeps();
    await expect(
      connectDeploymentModel(deps, actor, { provider: "deepseek", apiKey: "" }),
    ).rejects.toThrow("Enter an API key");
  });

  it("checks a default against the connections its own save reads", async () => {
    const { deps, state } = makeDeps();
    await connectDeploymentModel(deps, actor, { provider: "deepseek", apiKey: "fixture-key" });
    // Another admin's disconnect commits just before this save's transaction starts.
    vi.mocked(deps.prisma.$transaction).mockImplementationOnce((async (
      callback: (tx: unknown) => unknown,
    ) => {
      state.connections.delete("deepseek");
      return callback(deps.prisma);
    }) as never);
    await expect(
      updateDeploymentModelSettings(deps, actor, {
        defaultModel: { provider: "deepseek", modelId: "deepseek-v4-pro" },
      }),
    ).rejects.toThrow("Connect that model provider first");
    expect(state.settings.defaultModelProvider).toBeUndefined();
  });

  it("sets a default only a connection runs, and falls back to the environment when cleared", async () => {
    const { deps, state } = makeDeps({ env: { OPENROUTER_API_KEY: "fixture-openrouter-key" } });
    await expect(
      updateDeploymentModelSettings(deps, actor, {
        defaultModel: { provider: "deepseek", modelId: "deepseek-v4-pro" },
      }),
    ).rejects.toThrow("Connect that model provider first");
    await connectDeploymentModel(deps, actor, { provider: "deepseek", apiKey: "fixture-key" });
    const saved = await updateDeploymentModelSettings(deps, actor, {
      defaultModel: { provider: "deepseek", modelId: "deepseek-v4-pro" },
      allowedModels: ["deepseek:*"],
    });
    expect(saved).toMatchObject({
      defaultModel: { provider: "deepseek", modelId: "deepseek-v4-pro" },
      effectiveDefault: { provider: "deepseek", modelId: "deepseek-v4-pro" },
      allowedModels: ["deepseek:*"],
      effectiveAllowedModels: ["deepseek:*"],
    });
    const models = await currentDeploymentModels(deps);
    expect(models.default).toMatchObject({ provider: "deepseek", configured: true });

    // Removing the only connection that ran the default brings the environment's back.
    const removed = await disconnectDeploymentModel(deps, actor, { provider: "deepseek" });
    expect(removed.defaultModel).toBeNull();
    expect(removed.effectiveDefault).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-haiku-5.5",
    });
    expect(deps.secrets.delete).toHaveBeenCalledWith("cipher-1", "deployment-model:deepseek");

    const cleared = await updateDeploymentModelSettings(deps, actor, { allowedModels: null });
    expect(cleared.allowedModels).toBeNull();
    expect(state.settings.allowedModels).toBeNull();
  });

  it("connects a public HTTPS compatible endpoint with the member connection's limits", async () => {
    const { deps, state } = makeDeps();
    const view = await connectDeploymentModel(deps, actor, {
      provider: "openai-compatible",
      apiKey: "fixture-endpoint-key",
      baseUrl: ENDPOINT,
      enabledModelIds: ["fixture/first", "fixture/second"],
      contextWindow: 65_536,
      maxTokens: 8_192,
    });
    const stored = parseModelSecret(state.secrets.get("cipher-1")!);
    expect(stored).toMatchObject({
      kind: "openai_compatible",
      baseUrl: ENDPOINT,
      apiKey: "fixture-endpoint-key",
      contextWindow: 65_536,
      maxTokens: 8_192,
    });
    expect(state.connections.get("openai-compatible")?.models).toEqual([
      "fixture/first",
      "fixture/second",
    ]);
    expect(view.connections).toEqual([
      expect.objectContaining({
        provider: "openai-compatible",
        baseUrl: ENDPOINT,
        contextWindow: 65_536,
        maxTokens: 8_192,
        models: [
          { id: "fixture/first", label: "fixture/first" },
          { id: "fixture/second", label: "fixture/second" },
        ],
      }),
    ]);
    expect(JSON.stringify(view)).not.toContain("fixture-endpoint-key");
  });

  it("drops a saved default the endpoint no longer lists", async () => {
    const { deps } = makeDeps({ env: { OPENROUTER_API_KEY: "fixture-openrouter-key" } });
    const endpoint = (models: string[]) =>
      connectDeploymentModel(deps, actor, {
        provider: "openai-compatible",
        apiKey: "",
        baseUrl: ENDPOINT,
        enabledModelIds: models,
      });
    await endpoint(["fixture/first", "fixture/second"]);
    await updateDeploymentModelSettings(deps, actor, {
      defaultModel: { provider: "openai-compatible", modelId: "fixture/first" },
    });
    // Keeping the default's model keeps the default.
    expect((await endpoint(["fixture/first"])).defaultModel).toEqual({
      provider: "openai-compatible",
      modelId: "fixture/first",
    });
    const dropped = await endpoint(["fixture/second"]);
    expect(dropped.defaultModel).toBeNull();
    expect(dropped.effectiveDefault).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-haiku-5.5",
    });
  });

  it("opens and closes one connection's models on the server", async () => {
    const { deps, state } = makeDeps({
      env: { DEEPSEEK_API_KEY: "fixture-key", ANTHROPIC_API_KEY: "fixture-key" },
    });
    const opened = await updateDeploymentModelSettings(deps, actor, {
      open: { provider: "deepseek", open: true },
    });
    expect(opened.effectiveAllowedModels).toEqual(["deepseek:*"]);
    expect(opened.connections).toEqual([
      expect.objectContaining({ provider: "anthropic", open: false }),
      expect.objectContaining({ provider: "deepseek", open: true }),
    ]);
    await updateDeploymentModelSettings(deps, actor, { allowedModels: ["*"] });
    // Closing one connection of "every model" keeps the others open.
    const closed = await updateDeploymentModelSettings(deps, actor, {
      open: { provider: "anthropic", open: false },
    });
    expect(state.settings.allowedModels).toBe("deepseek:*");
    expect(closed.connections.map((connection) => connection.open)).toEqual([false, true]);
  });

  it("refuses limits that leave no room for input", async () => {
    const { deps } = makeDeps();
    await expect(
      connectDeploymentModel(deps, actor, {
        provider: "openai-compatible",
        apiKey: "fixture-endpoint-key",
        baseUrl: ENDPOINT,
        enabledModelIds: ["fixture/first"],
        contextWindow: 4_096,
        maxTokens: 4_096,
      }),
    ).rejects.toThrow("Maximum output tokens must leave room for input");
  });

  it("lists a public endpoint's models, with the saved key for the same URL", async () => {
    const { deps, fetch } = makeDeps();
    await connectDeploymentModel(deps, actor, {
      provider: "openai-compatible",
      apiKey: "fixture-endpoint-key",
      baseUrl: ENDPOINT,
      enabledModelIds: ["fixture/first"],
    });
    await expect(
      probeDeploymentModels(deps, actor, { baseUrl: ENDPOINT, apiKey: "" }),
    ).resolves.toEqual({ models: ["fixture/first", "fixture/second"] });
    const [url, init] = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${ENDPOINT}/models`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-endpoint-key");
  });
});

describe("the member catalog", () => {
  let lastLoad = vi.fn();
  async function contextFor(
    connections: { provider: string }[],
    options: {
      env?: NodeJS.ProcessEnv;
      allowedModels?: string;
      billing?: boolean;
      settings?: Record<string, unknown>;
    } = {},
  ) {
    const rows = connections.map((connection) => ({
      id: `own-${connection.provider}`,
      secretId: `secret-${connection.provider}`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...connection,
    }));
    const none = { findMany: vi.fn(async () => []) };
    const prisma = {
      userModelCredential: {
        findMany: vi.fn(async () => rows),
        findFirst: vi.fn(async () => rows[0] ?? null),
      },
      userModelPreference: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      secret: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => ({ id: "secret-own", ciphertext: "own-fixture" })),
      },
      bot: none,
      routine: none,
      userModelRoleChoice: none,
      spaceModelRoleChoice: none,
      deploymentSettings: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => ({
          allowedModels: options.allowedModels ?? "deepseek:*",
          modelConnections: [],
          ...options.settings,
        })),
      },
    };
    // The member's own endpoint lists only its own model.
    const load = vi.fn(async () =>
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://own.example.test/v1",
        enabledModelIds: ["own"],
      }),
    );
    lastLoad = load;
    return createRouterContext({
      prisma,
      secrets: { load },
      ...(options.billing ? { billing: { modelCreditsEnabled: true } } : {}),
      env: {
        agentRuntime: "pi",
        defaultProvider: "deepseek",
        defaultModel: "deepseek-flash",
        deploymentModels: environmentDeploymentModels(
          options.env ?? { DEEPSEEK_API_KEY: "fixture-key", PI_DEFAULT_PROVIDER: "deepseek" },
        ),
      },
    } as never);
  }
  const user = { userId: "user-1", spaceId: "space-1" } as never;
  async function catalogFor(...args: Parameters<typeof contextFor>) {
    const catalog: ModelCatalogEntry[] = await (await contextFor(...args)).chatCatalog(user);
    return catalog;
  }
  const find = (catalog: ModelCatalogEntry[], provider: string, id: string) =>
    catalog.find((entry) => entry.provider === provider && entry.id === id);

  it("marks the models the deployment serves this member as managed", async () => {
    const catalog = await catalogFor([]);
    expect(find(catalog, "deepseek", "deepseek-v4-pro")).toMatchObject({ managed: true });
    expect(find(catalog, "anthropic", "claude-opus-4-5")?.managed).toBeUndefined();
  });

  it("leaves them to the member's own connection for the provider", async () => {
    const catalog = await catalogFor([{ provider: "deepseek" }]);
    expect(find(catalog, "deepseek", "deepseek-v4-pro")?.managed).toBeUndefined();
  });

  it("offers nothing beyond hosted credits while model credits bill", async () => {
    // No credits: neither the default nor an allowed model is offered as the deployment's.
    const catalog = await catalogFor([], { billing: true });
    expect(find(catalog, "deepseek", "deepseek-flash")?.managed).toBeUndefined();
    expect(find(catalog, "deepseek", "deepseek-v4-pro")?.managed).toBeUndefined();
  });

  it("never marks decision models managed because their provider's chat models are served", async () => {
    const ctx = await contextFor([], {
      env: { OPENROUTER_API_KEY: "fixture-key" },
      allowedModels: "openrouter:*",
    });
    const catalog: ModelCatalogEntry[] = await ctx.modelRoleCatalog(user, "approval");
    const decisions = catalog.filter((entry) => entry.protocol === "decisions");
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((entry) => !entry.managed)).toBe(true);
  });

  it("decides an endpoint model by whether the member's own endpoints list it", async () => {
    const catalog = await catalogFor([{ provider: "openai-compatible" }], {
      allowedModels: "openai-compatible:*",
      settings: {
        modelConnections: [
          {
            provider: "openai-compatible",
            ciphertext: "admin-fixture",
            models: ["fixture/endpoint-model", "own"],
          },
        ],
      },
    });
    expect(find(catalog, "openai-compatible", "fixture/endpoint-model")).toMatchObject({
      managed: true,
      label: "fixture/endpoint-model",
    });
    // The member's own endpoint runs the id it lists.
    expect(find(catalog, "openai-compatible", "own")?.managed).toBeUndefined();
    // Their endpoint is read once, not once per served model.
    expect(lastLoad).toHaveBeenCalledOnce();
  });

  it("keeps hosted credits on the environment's provider whatever default an admin saves", async () => {
    const ctx = await contextFor([], {
      billing: true,
      settings: {
        defaultModelProvider: "anthropic",
        defaultModelId: "claude-opus-4-5",
        modelConnections: [{ provider: "anthropic", ciphertext: "admin-fixture", models: [] }],
      },
    });
    const validation = await ctx.botModelValidation(user);
    expect(validation.hostedProvider).toBe("deepseek");
    expect(validation.deployment.default).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
    });
  });
});

describe("pins on a member's own endpoint", () => {
  async function save(settings: Record<string, unknown> | null) {
    const deps = {
      prisma: {
        bot: {
          findMany: vi.fn(async () => [
            { spaceId: "space-1", modelId: "fixture/endpoint-model", name: "Bot A" },
          ]),
        },
        routine: { findMany: vi.fn(async () => []) },
        userModelRoleChoice: { findMany: vi.fn(async () => []) },
        spaceModelRoleChoice: { findMany: vi.fn(async () => []) },
        userModelPreference: { findFirst: vi.fn(async () => null) },
        userModelCredential: {
          findFirst: vi.fn(async () => null),
          findMany: vi.fn(async () => []),
        },
        deploymentSettings: { findUnique: vi.fn(async () => settings) },
      },
      secrets: { load: vi.fn() },
      env: { defaultProvider: "openrouter", defaultModel: "fixture/default" },
    } as never;
    return assertNoDanglingModelPins(
      deps,
      { userId: "user-1", spaceId: "space-1" } as never,
      { id: "own" },
      {
        kind: "openai_compatible",
        baseUrl: "https://own.example.test/v1",
        enabledModelIds: ["own"],
      },
      "own",
    );
  }

  it("does not count a pin the deployment's endpoint still runs as left behind", async () => {
    await expect(
      save({
        allowedModels: "openai-compatible:*",
        modelConnections: [
          {
            provider: "openai-compatible",
            ciphertext: "admin-fixture",
            models: ["fixture/endpoint-model"],
          },
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(save(null)).rejects.toThrow("In use by Bot A");
  });
});
