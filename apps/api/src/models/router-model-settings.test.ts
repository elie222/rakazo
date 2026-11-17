import { RPCHandler } from "@orpc/server/fetch";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { listPiCatalog } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { MAX_MODEL_SETTINGS_PER_CONNECTION, REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import type { RouterHandler } from "../router-test-support.js";
import { appHandler, createRouter, handle } from "../router-test-support.js";
import { createModelConnector, prepareModelReconnectSettings } from "./model-credentials.js";

describe("model setup gate", () => {
  function modelGateDeps(options: {
    agentRuntime: string;
    maxUploadSizeBytes?: number;
    maxAttachmentsPerMessage?: number;
    deploymentModelConfigured?: boolean;
    deploymentModelHostCredentials?: boolean;
    deploymentModelCredentialCipher?: string;
  }) {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
          secrets: [],
        }),
      },
      // A bot that follows the main model.
      bot: {
        findFirst: vi.fn().mockResolvedValue({ id: "bot-1", thread: { id: "thread-1" } }),
        findMany: vi
          .fn()
          .mockResolvedValue([{ modelProvider: null, modelId: null, thinkingLevel: null }]),
      },
      userModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            options.deploymentModelCredentialCipher
              ? { deploymentModelCredentialCipher: options.deploymentModelCredentialCipher }
              : null,
          ),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        agentRuntime: options.agentRuntime,
        maxUploadSizeBytes: options.maxUploadSizeBytes,
        maxAttachmentsPerMessage: options.maxAttachmentsPerMessage,
        defaultProvider: "openrouter",
        defaultModel: "test-model",
        deploymentModelConfigured: options.deploymentModelConfigured,
        deploymentModelHostCredentials: options.deploymentModelHostCredentials,
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { actor, handler: new RPCHandler(createRouter(deps)) };
  }

  async function call(handler: RouterHandler, actor: Actor, path: string, body: unknown) {
    const response = await handle(
      handler,
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it.each([undefined, 1, 8, 100])(
    "advertises the effective attachment count (%s)",
    async (maxAttachmentsPerMessage) => {
      const { actor, handler } = modelGateDeps({
        agentRuntime: "scripted",
        maxAttachmentsPerMessage,
      });
      const response = await call(handler, actor, "me", null);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        json: { maxAttachmentsPerMessage: maxAttachmentsPerMessage ?? 4 },
      });
    },
  );

  it.each([undefined, 25 * 1024 * 1024])(
    "advertises the effective upload limit in me (%s)",
    async (maxUploadSizeBytes) => {
      const { actor, handler } = modelGateDeps({ agentRuntime: "scripted", maxUploadSizeBytes });
      const response = await call(handler, actor, "me", null);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        json: { maxUploadSizeBytes: maxUploadSizeBytes ?? 10 * 1024 * 1024 },
      });
    },
  );

  it("refuses to start a run when no model is configured", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "pi" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Connect a model to start a run.",
      }),
    });
  });

  it("does not require a model credential for the scripted test runtime", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: false }),
    });
  });

  it("accepts a configured deployment model as model configuration", async () => {
    const { actor, handler } = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelConfigured: true,
    });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: false }),
    });
  });

  it("names the provider the deployment default runs on with host credentials", async () => {
    const hostCredentials = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelConfigured: true,
      deploymentModelHostCredentials: true,
    });
    const keyed = modelGateDeps({ agentRuntime: "pi", deploymentModelConfigured: true });

    const withHost = await call(hostCredentials.handler, hostCredentials.actor, "me", null);
    const withKey = await call(keyed.handler, keyed.actor, "me", null);

    await expect(withHost.json()).resolves.toEqual({
      json: expect.objectContaining({
        hostCredentialProvider: "openrouter",
        hostCredentialSource: "host",
      }),
    });
    await expect(withKey.json()).resolves.toEqual({
      json: expect.objectContaining({ hostCredentialProvider: null, hostCredentialSource: null }),
    });
  });

  it("does not accept a stored deployment cipher the executor cannot use", async () => {
    const { actor, handler } = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelCredentialCipher: "legacy-ciphertext",
    });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: true }),
    });
  });

  it("rejects a reply quote without a reply target", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
      replyQuote: "just this span",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        data: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ path: ["replyQuote"] })]),
        }),
      }),
    });
  });

  it("rejects an over-length reply quote", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
      replyToMessageId: "parent-1",
      replyQuote: "x".repeat(REPLY_QUOTE_MAX_LENGTH + 1),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        data: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ path: ["replyQuote"] })]),
        }),
      }),
    });
  });
});

describe("model settings", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;

  it.each(["settings", "connection"])(
    "rejects a connection save when its source %s changes before commit",
    async (change) => {
      let secretId = "secret-original";
      let ciphertext = "sealed-original";
      const connection = () => ({ id: "connection-1", provider: "zai", secretId });
      const readSecret = vi.fn(async () => ({ ciphertext }));
      const create = vi.fn();
      const tx = {
        userModelCredential: { findFirst: vi.fn(async () => connection()) },
        secret: { findFirst: readSecret, create },
      };
      const deps = {
        prisma: {
          userModelCredential: { findFirst: vi.fn(async () => connection()) },
          secret: { findFirst: readSecret },
          $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        },
        secrets: {
          load: vi.fn(async () =>
            JSON.stringify({
              kind: "api_key",
              key: "fake-original-key",
              models: { "model-fixture": { maxTokens: 2000 } },
            }),
          ),
          put: vi.fn(async () => {
            if (change === "settings") ciphertext = "sealed-new-settings";
            else secretId = "secret-new-connection";
            return { id: "secret-prepared", ciphertext: "sealed-stale-replacement" };
          }),
        },
        env: { defaultModel: "model-fixture" },
      } as unknown as RouterDeps;
      const connector = createModelConnector(deps, { read: vi.fn() } as never);
      await expect(
        connector.connectModelCredential(
          actor,
          { provider: "zai", credentialId: "connection-1", modelId: "model-fixture" },
          undefined,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(create).not.toHaveBeenCalled();
    },
  );

  function settingsDeps(stored: string, defaultModel = "served", provider = "zai") {
    let plaintext = stored;
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      secret: {
        findFirst: vi.fn(async () => ({ ciphertext: "sealed" })),
        update: vi.fn(async () => ({})),
      },
    };
    const deps = {
      prisma: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        userModelCredential: {
          findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
            where.id === "connection-1"
              ? {
                  id: "connection-1",
                  secretId: "secret-1",
                  provider,
                  userPreferences: [{ modelId: defaultModel }],
                }
              : null,
          ),
        },
      },
      secrets: {
        load: vi.fn(async () => plaintext),
        put: vi.fn(async (next: string) => {
          plaintext = next;
          return { id: "secret-1", ciphertext: "sealed-again" };
        }),
      },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        agentRuntime: "pi",
      },
    } as unknown as RouterDeps;
    const handler = appHandler(deps);
    const call = (body: unknown) =>
      handle(
        handler,
        new Request("http://127.0.0.1/rpc/models/saveModelSettings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: body }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    return { deps, tx, call, stored: () => JSON.parse(plaintext) as Record<string, unknown> };
  }

  it("reports a secret store outage as unavailable and keeps settings it could not read", async () => {
    const { deps, call } = settingsDeps("sk-synthetic-key");
    deps.secrets.load = vi.fn(async () => {
      throw new SecretStoreUnavailableError();
    });
    expect(
      (
        await call({
          credentialId: "connection-1",
          modelId: "glm-5.3-flashx",
          settings: { images: true },
        })
      ).status,
    ).toBe(503);
    Object.assign(deps.prisma, {
      secret: { findFirst: vi.fn(async () => ({ ciphertext: "sealed" })) },
    });
    await expect(
      prepareModelReconnectSettings(deps, actor, { secretId: "secret-1" }),
    ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    deps.secrets.load = vi.fn(async () => "not json {");
    await expect(
      prepareModelReconnectSettings(deps, actor, { secretId: "secret-1" }),
    ).resolves.toEqual({
      settings: {},
      expectedSecret: { id: "secret-1", ciphertext: "sealed" },
    });
  });

  it("saves one model's settings on the connection without touching its key", async () => {
    const { tx, call, stored } = settingsDeps("sk-synthetic-key");
    const response = await call({
      credentialId: "connection-1",
      modelId: "glm-5.3-flashx",
      settings: { images: true, maxTokens: 8000 },
    });
    expect(response.status).toBe(200);
    expect(stored()).toEqual({
      kind: "api_key",
      key: "sk-synthetic-key",
      models: { "glm-5.3-flashx": { images: true, maxTokens: 8000 } },
    });
    expect(tx.secret.update).toHaveBeenCalledWith({
      where: { id: "secret-1" },
      data: { ciphertext: "sealed-again" },
    });
  });

  it("rejects output-only overrides that fill the model's default context", async () => {
    const known = listPiCatalog().find((entry) => entry.provider === "zai" && entry.contextWindow)!;
    for (const input of [
      {
        provider: "zai",
        modelId: known.id,
        window: known.contextWindow!,
        secret: "sk-synthetic-key",
      },
      {
        provider: "openai-compatible",
        modelId: "served",
        window: 262144,
        secret: JSON.stringify({
          kind: "openai_compatible",
          apiKey: "fake-key",
          baseUrl: "https://example.com/v1",
        }),
      },
    ]) {
      const { call, deps } = settingsDeps(input.secret, input.modelId, input.provider);
      const response = await call({
        credentialId: "connection-1",
        modelId: input.modelId,
        settings: { maxTokens: input.window },
      });
      expect(response.status).toBe(400);
      expect(deps.secrets.put).not.toHaveBeenCalled();
    }
  });

  it("rejects a context-only override below the model's default output cap", async () => {
    const known = listPiCatalog().find(
      (entry) => entry.provider === "zai" && entry.contextWindow && entry.maxTokens,
    )!;
    for (const input of [
      { provider: "zai", modelId: known.id, secret: "sk-synthetic-key" },
      {
        provider: "openai-compatible",
        modelId: "served",
        secret: JSON.stringify({
          kind: "openai_compatible",
          apiKey: "fake-key",
          baseUrl: "https://example.com/v1",
        }),
      },
    ]) {
      const { call, deps } = settingsDeps(input.secret, input.modelId, input.provider);
      const response = await call({
        credentialId: "connection-1",
        modelId: input.modelId,
        settings: { contextWindow: 1 },
      });
      expect(response.status).toBe(400);
      expect(deps.secrets.put).not.toHaveBeenCalled();
    }
  });

  it("caps how many models on one connection keep their own settings", async () => {
    const models = Object.fromEntries(
      Array.from({ length: MAX_MODEL_SETTINGS_PER_CONNECTION }, (_, index) => [
        `model-${index}`,
        { images: true },
      ]),
    );
    const { call } = settingsDeps(
      JSON.stringify({ kind: "api_key", key: "sk-synthetic-key", models }),
    );
    expect(
      (
        await call({
          credentialId: "connection-1",
          modelId: "model-new",
          settings: { images: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          credentialId: "connection-1",
          modelId: "model-0",
          settings: { maxTokens: 10 },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call({ credentialId: "connection-1", modelId: "model-new", settings: {} })).status,
    ).toBe(200);
  });

  it("refuses another member's connection, a model the server does not serve, and no room for input", async () => {
    const compatible = JSON.stringify({
      kind: "openai_compatible",
      baseUrl: "https://models.example.test/v1",
      enabledModelIds: ["served"],
    });
    const { call } = settingsDeps(compatible);
    expect(
      (await call({ credentialId: "connection-2", modelId: "served", settings: {} })).status,
    ).toBe(404);
    expect(
      (
        await call({
          credentialId: "connection-1",
          modelId: "unlisted",
          settings: { images: true },
        })
      ).status,
    ).toBe(400);
    // Clearing a model that left the connection still works.
    expect(
      (await call({ credentialId: "connection-1", modelId: "unlisted", settings: {} })).status,
    ).toBe(200);
    expect(
      (
        await call({
          credentialId: "connection-1",
          modelId: "served",
          settings: { contextWindow: 1000, maxTokens: 1000 },
        })
      ).status,
    ).toBe(400);
  });
});

describe("model set default auth", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";
  const oauth = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  const apiKey = "sk-test-api-key-12345678";

  async function call(handler: RouterHandler, path: string, body: unknown) {
    const response = await handle(
      handler,
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("sets Spark from the API-key preference when a newer ChatGPT credential exists", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-02-01T00:00:00.000Z");
    const apiCredential = {
      id: "cred-api",
      userId: actor.userId,
      provider: "openai-codex",
      label: "API key",
      secretId: "secret-api",
      createdAt: older,
      updatedAt: older,
    };
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: newer,
      updatedAt: newer,
    };
    const secretFindFirst = vi.fn(async (args: { where: { id?: string } }) => {
      if (args.where.id === "secret-api") return { id: "secret-api", ciphertext: "cipher-api" };
      if (args.where.id === "secret-oauth") {
        return { id: "secret-oauth", ciphertext: "cipher-oauth" };
      }
      return null;
    });
    const upsert = vi.fn(async () => ({ id: "pref-spark" }));
    const tx = {
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([oauthCredential, apiCredential]),
      },
      userModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-spark",
            modelId: spark,
            updatedAt: older,
            credential: apiCredential,
          },
          {
            id: "pref-luna",
            modelId: luna,
            updatedAt: newer,
            credential: oauthCredential,
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        upsert,
      },
      secret: { findFirst: secretFindFirst },
    };
    const load = vi.fn((ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey));
    const handler = new RPCHandler(
      createRouter({
        prisma: {
          ...tx,
          $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        },
        secrets: { load },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
    );

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(secretFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "secret-api", userId: actor.userId, spaceId: null }),
      }),
    );
    expect(load).toHaveBeenCalledWith("cipher-api", "secret-api");
    expect(load).not.toHaveBeenCalledWith("cipher-oauth", "secret-oauth");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_credentialId: {
            userId: actor.userId,
            credentialId: "cred-api",
          },
        },
        update: { modelId: spark, thinkingLevel: null },
      }),
    );
  });

  it("keeps the effort the main list has for the model on the chosen connection", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const connection = (id: string) => ({
      id,
      userId: actor.userId,
      provider: "openai-codex",
      label: id,
      secretId: `secret-${id}`,
      createdAt: at,
      updatedAt: at,
    });
    const [work, personal] = [connection("cred-work"), connection("cred-personal")];
    const tx = {
      userModelCredential: { findMany: vi.fn().mockResolvedValue([work, personal]) },
      userModelPreference: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "pref-personal", modelId: luna, updatedAt: at, credential: personal },
          ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        upsert: vi.fn(async () => ({ id: "pref-personal" })),
      },
      secret: {
        findFirst: vi.fn(async (args: { where: { id?: string } }) =>
          args.where.id ? { id: args.where.id, ciphertext: `cipher-${args.where.id}` } : null,
        ),
      },
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const handler = new RPCHandler(
      createRouter({
        prisma,
        secrets: { load: vi.fn(() => apiKey) },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
    );
    const roles = (
      prisma as unknown as {
        userModelRoleChoice: {
          createMany: (args: { data: unknown[] }) => Promise<unknown>;
          findMany: (args: { where: Record<string, string> }) => Promise<unknown[]>;
        };
      }
    ).userModelRoleChoice;
    const row = (position: number, credentialId: string, thinkingLevel: string) => ({
      userId: actor.userId,
      spaceId: actor.spaceId,
      role: "main",
      position,
      provider: "openai-codex",
      modelId: luna,
      thinkingLevel,
      credentialId,
    });
    // The same model runs first on another connection with a different effort.
    await roles.createMany({ data: [row(0, work.id, "low"), row(1, personal.id, "high")] });

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: luna,
    });

    expect(response.status).toBe(200);
    const main = await roles.findMany({
      where: { userId: actor.userId, spaceId: actor.spaceId, role: "main" },
    });
    expect(main[0]).toMatchObject({ credentialId: personal.id, thinkingLevel: "high" });
  });

  it("rebinds a Spark API-key preference when another Codex model becomes the default", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-02-01T00:00:00.000Z");
    const apiCredential = {
      id: "cred-api",
      userId: actor.userId,
      provider: "openai-codex",
      label: "API key",
      secretId: "secret-api",
      createdAt: older,
      updatedAt: older,
    };
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: newer,
      updatedAt: newer,
    };
    const secretFindFirst = vi.fn(async (args: { where: { id?: string } }) => {
      if (args.where.id === "secret-api") return { id: "secret-api", ciphertext: "cipher-api" };
      if (args.where.id === "secret-oauth") {
        return { id: "secret-oauth", ciphertext: "cipher-oauth" };
      }
      return null;
    });
    const upsert = vi.fn(async () => ({ id: "pref-luna" }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([oauthCredential, apiCredential]),
      },
      userModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-spark",
            modelId: spark,
            updatedAt: older,
            credential: apiCredential,
          },
        ]),
        updateMany,
        upsert,
      },
      secret: { findFirst: secretFindFirst },
    };
    const load = vi.fn((ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey));
    const handler = new RPCHandler(
      createRouter({
        prisma: {
          ...tx,
          $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        },
        secrets: { load },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
    );

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: luna,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(load).toHaveBeenCalledWith("cipher-oauth", "secret-oauth");
    expect(upsert).toHaveBeenCalledTimes(1);
    // Pi no longer bundles Spark for Codex, so its binding is no longer an auth-restricted
    // model to protect and the older credential takes the new default.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_credentialId: {
            userId: actor.userId,
            credentialId: "cred-api",
          },
        },
        create: expect.objectContaining({ modelId: luna }),
        update: { modelId: luna, thinkingLevel: null },
      }),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("keeps the working space credential when the other Codex secret cannot be read", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-02-01T00:00:00.000Z");
    const apiCredential = {
      id: "cred-api",
      userId: actor.userId,
      provider: "openai-codex",
      label: "API key",
      secretId: "secret-api",
      createdAt: older,
      updatedAt: older,
    };
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: newer,
      updatedAt: newer,
    };
    const upsert = vi.fn(async () => ({ id: "pref-luna" }));
    const tx = {
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([oauthCredential, apiCredential]),
      },
      userModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-spark",
            modelId: spark,
            updatedAt: older,
            credential: apiCredential,
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        upsert,
      },
      secret: {
        findFirst: vi.fn(async (args: { where: { id?: string } }) => {
          if (args.where.id === "secret-api") return { id: "secret-api", ciphertext: "cipher-api" };
          if (args.where.id === "secret-oauth") {
            return { id: "secret-oauth", ciphertext: "cipher-oauth" };
          }
          return null;
        }),
      },
    };
    const load = vi.fn((ciphertext: string) => {
      if (ciphertext === "cipher-oauth") throw new Error("unreadable");
      return apiKey;
    });
    const handler = new RPCHandler(
      createRouter({
        prisma: {
          ...tx,
          $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        },
        secrets: { load },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
    );

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: luna,
    });

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_credentialId: {
            userId: actor.userId,
            credentialId: "cred-api",
          },
        },
        update: { modelId: luna, thinkingLevel: null },
      }),
    );
  });
});

describe("bot model auth on save", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";
  const oauth = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  const apiKey = "sk-test-api-key-12345678";

  async function call(handler: RouterHandler, path: string, body: unknown) {
    const response = await handle(
      handler,
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  function storedBot(modelId: string) {
    const now = new Date("2026-01-01T00:00:00.000Z");
    return {
      id: "bot-1",
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: "Ada",
      title: "",
      description: "",
      instructions: "",
      color: "ink",
      notifyOnFinish: true,
      pinned: false,
      position: 0,
      sectionId: null,
      archivedAt: null,
      parentBotId: null,
      memoryScope: null,
      createdAt: now,
      updatedAt: now,
      voiceId: null,
      autoSpeak: false,
      modelProvider: "openai-codex",
      modelId,
      thinkingLevel: null,
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      webhookSecretId: null,
      spawnKey: null,
      thread: { id: "thread-1", reads: [], messages: [], runs: [] },
      computer: null,
      runs: [],
    };
  }

  function credentialRow(id: string, secretId: string) {
    return {
      id,
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  function saveDeps(options: {
    modelId: string;
    preferences: (args: { where: { modelId?: string; credential?: { provider?: string } } }) => {
      credential: ReturnType<typeof credentialRow>;
      modelId: string;
    } | null;
  }) {
    const bot = storedBot(options.modelId);
    const preferenceFindFirst = vi.fn(options.preferences);
    const secretFindFirst = vi.fn(async (args: { where: { id?: string } }) => {
      if (args.where.id === "secret-api") {
        return { id: "secret-api", ciphertext: "cipher-api" };
      }
      if (args.where.id === "secret-oauth") {
        return { id: "secret-oauth", ciphertext: "cipher-oauth" };
      }
      return null;
    });
    const botUpdate = vi.fn(async () => ({
      id: bot.id,
      name: "Ada renamed",
      title: bot.title,
      description: bot.description,
    }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      bot: { update: botUpdate },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 2 })) },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const prisma = {
      $queryRaw: vi.fn(async () => []),
      bot: {
        findFirst: vi.fn(async () => bot),
        findMany: vi.fn(async () => [{ ...bot, name: "Ada renamed" }]),
        update: botUpdate,
      },
      userModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      secret: { findFirst: secretFindFirst },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const deps = {
      prisma,
      secrets: {
        load: (ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey),
      },
      events: { notify: vi.fn().mockResolvedValue(undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps;
    return {
      preferenceFindFirst,
      secretFindFirst,
      botUpdate,
      handler: appHandler(deps),
    };
  }

  it("persists the daily check-in preference through the bot update route", async () => {
    const { botUpdate, handler } = saveDeps({ modelId: spark, preferences: () => null });
    const response = await call(handler, "bots/update", { botId: "bot-1", dailyCheckIns: false });
    expect(response.status).toBe(200);
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dailyCheckIns: false }) }),
    );
  });

  it("saves a rename while resending an existing Spark override", async () => {
    const { preferenceFindFirst, secretFindFirst, botUpdate, handler } = saveDeps({
      modelId: spark,
      preferences: () => null,
    });

    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      name: "Ada renamed",
      modelProvider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ id: "bot-1", name: "Ada renamed", modelId: spark }),
    });
    expect(preferenceFindFirst).not.toHaveBeenCalled();
    expect(secretFindFirst).not.toHaveBeenCalled();
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Ada renamed", modelId: spark }),
      }),
    );
  });

  it("rejects setting Codex Spark, which Pi no longer bundles, on the space's ChatGPT credential", async () => {
    const oauthCredential = credentialRow("cred-oauth", "secret-oauth");
    const { preferenceFindFirst, handler } = saveDeps({
      modelId: luna,
      preferences: (args) => {
        if (args.where.modelId) return null;
        if (args.where.credential?.provider === "openai-codex") {
          return { credential: oauthCredential, modelId: luna };
        }
        return null;
      },
    });

    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      modelProvider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Unknown model for that provider",
      }),
    });
    expect(preferenceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          modelId: spark,
          credential: { provider: "openai-codex" },
        }),
      }),
    );
  });

  it("accepts Spark when the preference that owns that model is an API key", async () => {
    const apiCredential = credentialRow("cred-api", "secret-api");
    const oauthCredential = credentialRow("cred-oauth", "secret-oauth");
    const { secretFindFirst, handler } = saveDeps({
      modelId: luna,
      preferences: (args) => {
        if (args.where.modelId === spark) {
          return { credential: apiCredential, modelId: spark };
        }
        if (args.where.credential?.provider === "openai-codex") {
          return { credential: oauthCredential, modelId: luna };
        }
        return null;
      },
    });

    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      modelProvider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(200);
    expect(secretFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "secret-api", userId: actor.userId, spaceId: null }),
      }),
    );
  });

  it("undoes a chat-made settings change only while it still holds", async () => {
    const { botUpdate, handler } = saveDeps({ modelId: luna, preferences: () => null });
    const undo = { botId: "bot-1", autoSpeak: false, expectedSettings: { autoSpeak: true } };

    expect((await call(handler, "bots/update", undo)).status).toBe(200);
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bot-1", autoSpeak: true },
        data: expect.objectContaining({ autoSpeak: false }),
      }),
    );

    botUpdate.mockRejectedValueOnce(Object.assign(new Error("No record"), { code: "P2025" }));
    const changed = await call(handler, "bots/update", undo);
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "CONFLICT",
        message: "Settings changed; review the current settings first.",
      }),
    });
  });
});
