import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import {
  COMPUTER_SCREEN_UNAVAILABLE,
  CodexCatalogCache,
  ComputerScreenUnavailableError,
  EncryptedSecretStore,
  IntegrationProviderSettings,
  screenLeaseIdForRun,
} from "@rakazo/adapters";
import type { Actor, Bot, ProductEvent } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { openScreenCapability } from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter, enqueueBotIntroRun, HEARTBEAT_MS, SESSION_RECHECK_MS } from "./router.js";

describe("account preferences", () => {
  function preferencesDeps(avatarStyle: string) {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      user: {
        update,
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle,
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
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
    return { update, deps, actor, handler: new RPCHandler(createRouter(deps)) };
  }

  it("reports model credential store outages as service unavailable", async () => {
    const { deps, actor } = preferencesDeps("robot");
    Object.assign(deps.prisma, {
      userModelCredential: {
        findMany: vi.fn(async () => [{ secretId: "secret", preferences: [] }]),
      },
      secret: { findMany: vi.fn(async () => [{ id: "secret", ciphertext: "ref" }]) },
    });
    deps.secrets = {
      load: vi.fn(async () => {
        throw new SecretStoreUnavailableError();
      }),
    } as never;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    await expect(client.models.credentials()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("keeps an unconfigured catalog offline unless explicitly requested", async () => {
    const { actor, deps } = preferencesDeps("robot");
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    deps.remoteConnectors = { fetch } as RouterDeps["remoteConnectors"];
    const handler = new RPCHandler(createRouter(deps));
    const request = async (usePublicCatalog?: boolean) =>
      handler.handle(
        new Request("http://127.0.0.1/rpc/capabilities/catalogSearch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { query: "notion", usePublicCatalog } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    const { response } = await request();
    await expect(response.json()).resolves.toEqual({ json: { enabled: false, results: [] } });
    expect(fetch).not.toHaveBeenCalled();
    await request(true);
    expect(fetch).toHaveBeenCalled();
  });

  it("persists and returns the selected avatar style", async () => {
    const { update, actor, handler } = preferencesDeps("organic");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "organic" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { avatarStyle: "organic" },
    });
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "organic" }),
    });
  });

  it("rejects avatar styles outside robot|organic", async () => {
    const { update, actor, handler } = preferencesDeps("robot");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "dicebear" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("coerces unknown stored avatar styles to robot on me", async () => {
    const { actor, handler } = preferencesDeps("custom-cdn");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "robot" }),
    });
  });
});

describe("billing", () => {
  function billingDeps(isDeploymentOwner: boolean, billing?: RouterDeps["billing"]) {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      billing,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
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
      isDeploymentOwner,
    } satisfies Actor;
    return createRouterClient(createRouter(deps), { context: { actor } });
  }

  it("is not found when the deployment does not bill", async () => {
    const client = billingDeps(false);
    await expect(client.billing.status()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.billing.checkout()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.me()).resolves.toMatchObject({ billingEnabled: false });
  });

  it("enables billing on me for everyone but the deployment owner", async () => {
    const billing = { status: vi.fn() } as unknown as RouterDeps["billing"];
    await expect(billingDeps(false, billing).me()).resolves.toMatchObject({
      billingEnabled: true,
    });
    await expect(billingDeps(true, billing).me()).resolves.toMatchObject({
      billingEnabled: false,
    });
  });
});

describe("model setup gate", () => {
  function modelGateDeps(options: {
    agentRuntime: string;
    deploymentModelKey?: string;
    deploymentModelCredentialCipher?: string;
  }) {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
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
        defaultProvider: "openrouter",
        defaultModel: "test-model",
        deploymentModelKey: options.deploymentModelKey,
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

  async function call(handler: RPCHandler<never>, actor: Actor, path: string, body: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

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

  it("accepts a deployment model key as model configuration", async () => {
    const { actor, handler } = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelKey: "fake-deployment-key",
    });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: false }),
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

describe("thread answer delivery", () => {
  it("accepts a durable answer when the immediate worker wake fails", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const enqueue = vi.fn().mockRejectedValue(new Error("job broker unavailable"));
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
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
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/threads/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            botId: "bot-1",
            runId: "run-1",
            messageId: "message-1",
            answer: "Paris",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(sink.events.some((event) => event.message === "thread answer enqueue")).toBe(true);
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });
});

describe("thread stream authorization", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function threadStream() {
    vi.useFakeTimers();
    const queued: ProductEvent[] = [];
    let waiting: ((result: IteratorResult<ProductEvent>) => void) | undefined;
    const follow = {
      next: () =>
        queued.length > 0
          ? Promise.resolve({ done: false as const, value: queued.shift()! })
          : new Promise<IteratorResult<ProductEvent>>((resolve) => {
              waiting = resolve;
            }),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const emit = (seq: number, text: string, extra?: Partial<ProductEvent>) => {
      const event: ProductEvent = {
        id: `event-${seq}`,
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq,
        type: "thread.message.created",
        createdAt: new Date().toISOString(),
        payload: { text },
        ...extra,
      };
      if (waiting) {
        waiting({ done: false, value: event });
        waiting = undefined;
      } else {
        queued.push(event);
      }
    };
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({ trigger: "bot_message" }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { follow: vi.fn(() => follow) },
      env: { webOrigin: "http://127.0.0.1:5173", screenProxySecret: "fake-test-secret" },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const stillAuthorized = vi.fn().mockResolvedValue(true);
    const client = createRouterClient(createRouter(deps), {
      context: { actor, stillAuthorized },
    });
    return { client, emit, follow, stillAuthorized };
  }

  it("stops delivering a busy thread once the session is revoked", async () => {
    const { client, emit, follow, stillAuthorized } = threadStream();
    const stream = await client.threads.subscribe({ botId: "bot-1", cursor: -1 });

    emit(1, "before");
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 1 } });
    expect(stillAuthorized).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + SESSION_RECHECK_MS);
    emit(2, "still signed in");
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 2 } });
    expect(stillAuthorized).toHaveBeenCalledTimes(1);

    stillAuthorized.mockResolvedValue(false);
    vi.setSystemTime(Date.now() + SESSION_RECHECK_MS);
    emit(3, "after revocation");
    await expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(follow.return).toHaveBeenCalled();
  });

  it("ends an idle stream at its next heartbeat once the session is revoked", async () => {
    const { client, follow, stillAuthorized } = threadStream();
    const stream = await client.threads.subscribe({ botId: "bot-1", cursor: -1 });

    stillAuthorized.mockResolvedValue(false);
    const ended = expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await ended;
    expect(follow.return).toHaveBeenCalled();
  });

  it("re-checks authorization before skipping filtered peer events", async () => {
    const { client, emit, follow, stillAuthorized } = threadStream();
    const stream = await client.threads.subscribe({ botId: "bot-1", cursor: -1 });

    emit(1, "before");
    await expect(stream.next()).resolves.toMatchObject({ value: { seq: 1 } });
    expect(stillAuthorized).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + SESSION_RECHECK_MS);
    stillAuthorized.mockResolvedValue(false);
    emit(2, "hidden", { type: "thread.progress", runId: "run-peer", payload: {} });
    const pending = stream.next();
    const outcome = await Promise.race([
      pending.then(
        () => "yielded" as const,
        () => "rejected" as const,
      ),
      (async () => {
        for (let step = 0; step < 30; step++) {
          await Promise.resolve();
          await vi.advanceTimersByTimeAsync(0);
        }
        return "still-open" as const;
      })(),
    ]);
    expect(outcome).toBe("rejected");
    await expect(pending).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(stillAuthorized).toHaveBeenCalledTimes(1);
    expect(follow.return).toHaveBeenCalled();
  });
});

describe("MCP server deletion", () => {
  it("does not fail when a concurrent credential rotation already removed the old secret", async () => {
    const deleteServer = vi.fn().mockResolvedValue({ id: "server-1" });
    const deleteSecrets = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({ id: "server-1", secretId: "old-secret" }),
        delete: deleteServer,
      },
      secret: { deleteMany: deleteSecrets },
      message: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
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
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/mcp/servers/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { id: "server-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(deleteServer).toHaveBeenCalledWith({ where: { id: "server-1" } });
    expect(deleteSecrets).toHaveBeenCalledWith({
      where: {
        id: "old-secret",
        spaceId: "workspace-1",
        userId: "user-1",
      },
    });
  });
});

describe("MCP prepared credential updates", () => {
  it("keeps slow secret I/O outside transactions and retries a concurrent OAuth edit", async () => {
    let clock = 0;
    let active = false;
    let writes = 0;
    const server = {
      id: "server",
      spaceId: "space",
      userId: "user",
      slug: "demo",
      name: "Demo",
      description: "",
      enabled: true,
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/mcp",
      secretId: "old",
      revision: 1,
      args: [],
      env: {},
      headers: {},
      command: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const rows = new Map([["old", { id: "old", ciphertext: "old-ref" }]]);
    const values = new Map([
      [
        "old-ref",
        JSON.stringify({ oauth: { tokens: { access_token: "old", token_type: "bearer" } } }),
      ],
    ]);
    const prisma = {
      mcpServer: {
        findFirst: async () => ({ ...server }),
        update: async ({
          data,
        }: {
          data: { secretId: string; revision: { increment: number } };
        }) => {
          Object.assign(server, data, { revision: server.revision + data.revision.increment });
          return { ...server };
        },
      },
      secret: {
        findFirst: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        create: async ({ data }: { data: { id: string; ciphertext: string } }) => {
          rows.set(data.id, data);
          return data;
        },
        deleteMany: async ({ where }: { where: { id: string } }) => {
          rows.delete(where.id);
          return { count: 1 };
        },
        count: async ({ where }: { where: { ciphertext: string } }) =>
          [...rows.values()].filter((row) => row.ciphertext === where.ciphertext).length,
      },
      botSecret: { count: async () => 0 },
      integrationProviderConfig: { count: async () => 0 },
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      async $transaction(callback: (tx: typeof prisma) => Promise<unknown>) {
        active = true;
        const start = clock;
        try {
          const result = await callback(prisma);
          if (clock - start > 5000) throw new Error("Transaction expired");
          return result;
        } finally {
          active = false;
        }
      },
    };
    const secrets = {
      load: async (ref: string) => {
        expect(active).toBe(false);
        clock += 15000;
        return values.get(ref)!;
      },
      put: async (plaintext: string) => {
        expect(active).toBe(false);
        clock += 15000;
        const id = `write-${++writes}`;
        values.set(id, plaintext);
        if (writes === 1) {
          rows.set("concurrent", { id: "concurrent", ciphertext: "concurrent-ref" });
          values.set(
            "concurrent-ref",
            JSON.stringify({
              oauth: { tokens: { access_token: "concurrent", token_type: "bearer" } },
            }),
          );
          server.secretId = "concurrent";
          server.revision++;
        }
        return { id, ref: id, ciphertext: id };
      },
      delete: vi.fn(async (ref: string) => {
        expect(active).toBe(false);
        values.delete(ref);
      }),
    };
    const deps = {
      prisma,
      secrets,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "space",
      userId: "user",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    await client.mcp.servers.update({ id: "server", secret: "updated-key" });
    expect(writes).toBe(2);
    expect(values.has("write-1")).toBe(false);
    expect(JSON.parse(values.get(server.secretId)!)).toMatchObject({
      secret: "updated-key",
      oauth: { tokens: { access_token: "concurrent" } },
    });
  });
});

describe("MCP loopback endpoints", () => {
  const LOOPBACK = "http://localhost:3100/api/auth/get-session";

  function mcpDeps() {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "server-1",
      secretId: null,
      revision: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    const prisma = {
      mcpServer: {
        create,
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "server-1", endpoint: LOOPBACK, secretId: null }),
      },
      mcpOAuthSession: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      secret: { findFirst: vi.fn() },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "owner-1" }) },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { create, handler: new RPCHandler(createRouter(deps)) };
  }

  function actor(isDeploymentOwner: boolean): Actor {
    return {
      spaceId: "workspace-1",
      userId: isDeploymentOwner ? "owner-1" : "member-1",
      email: "user@rakazo.test",
      isDeploymentOwner,
    };
  }

  function rpc(path: string, json: unknown) {
    return new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json }),
    });
  }

  const createInput = {
    transport: "streamable_http",
    slug: "local",
    name: "Local",
    endpoint: LOOPBACK,
  };

  it("refuses a loopback endpoint from a user who is not the deployment owner", async () => {
    const { create, handler } = mcpDeps();
    const { response } = await handler.handle(rpc("mcp/servers/create", createInput), {
      prefix: "/rpc",
      context: { actor: actor(false) },
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("lets the deployment owner save a loopback endpoint", async () => {
    const { create, handler } = mcpDeps();
    const { response } = await handler.handle(rpc("mcp/servers/create", createInput), {
      prefix: "/rpc",
      context: { actor: actor(true) },
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses to start OAuth against a stored loopback endpoint for a non-owner", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const { handler } = mcpDeps();
      const { response } = await handler.handle(
        rpc("mcp/oauth/begin", {
          serverId: "server-1",
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        }),
        { prefix: "/rpc", context: { actor: actor(false) } },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { json: { message: string } };
      expect(body.json.message).toMatch(/HTTPS/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("private API connectors", () => {
  function privateDeps(mcpAllowPrivateEndpoint = false) {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "install-1",
      secretId: null,
      version: "1.0.0",
      digest: "sha256:fake",
      createdAt: new Date(0),
    }));
    const prisma = {
      capabilityInstall: { create },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        mcpAllowPrivateEndpoint,
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { create, handler: new RPCHandler(createRouter(deps)) };
  }

  function actor(isDeploymentOwner: boolean): Actor {
    return {
      spaceId: "workspace-1",
      userId: isDeploymentOwner ? "owner-1" : "member-1",
      email: "user@rakazo.test",
      isDeploymentOwner,
    };
  }

  function rpc(path: string, json: unknown) {
    return new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json }),
    });
  }

  const installInput = {
    kind: "api",
    name: "Local API",
    source: "http://localhost:4000",
    config: {
      auth: { type: "none" },
      operations: [{ id: "list_items", method: "GET", path: "/items" }],
    },
  };

  it.each([
    ["the deployment owner", true, false],
    ["every user under the instance flag", false, true],
  ])("lets %s install a loopback API connector", async (_label, owner, flag) => {
    const { create, handler } = privateDeps(flag);
    const { response } = await handler.handle(rpc("capabilities/install", installInput), {
      prefix: "/rpc",
      context: { actor: actor(owner) },
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses a loopback API connector from a user who is not the deployment owner", async () => {
    const { create, handler } = privateDeps();
    const { response } = await handler.handle(rpc("capabilities/install", installInput), {
      prefix: "/rpc",
      context: { actor: actor(false) },
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("connections.begin", () => {
  it("reuses a revoked row for the same provider instead of inserting a duplicate", async () => {
    const begin = vi.fn().mockResolvedValue({ state: "gmail-state", authorizationUrl: null });
    const update = vi.fn().mockResolvedValue({
      id: "conn-old",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "pending",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn();
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          connection: {
            findMany: vi.fn().mockResolvedValue([{ id: "conn-old", status: "revoked" }]),
            update,
            updateMany,
            create,
          },
        };
        return fn(tx);
      }),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn(() => ({ begin })),
      },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
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
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/connections/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectorId: "composio",
            provider: "gmail",
            displayName: "Gmail",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "conn-old" },
      data: {
        displayName: "Gmail",
        status: "pending",
        providerRef: null,
        metadata: {},
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      json: { connectionId: "conn-old" },
    });
  });
});

describe("connections.complete", () => {
  it.each([
    ["complete", false],
    ["complete", true],
    ["revoke", false],
    ["revoke", true],
  ] as const)(
    "prepares slow configured credentials for %s (changed: %s)",
    async (operation, changed) => {
      const secrets = new EncryptedSecretStore("test-encryption-key");
      const stored = await secrets.put(
        JSON.stringify({ provider: "composio", apiKey: "fake-key" }),
        {
          operationId: "test",
          traceId: "test",
          spaceId: "workspace-1",
          userId: "user-1",
          signal: new AbortController().signal,
        },
        { recordId: "integration-provider:composio" },
      );
      let ref = stored.ref;
      let inTransaction = false;
      let elapsed = 0;
      const originalLoad = EncryptedSecretStore.prototype.load.bind(secrets);
      const load = vi.spyOn(secrets, "load").mockImplementation(async (...args) => {
        expect(inTransaction).toBe(false);
        elapsed += 15_000;
        return originalLoad(...args);
      });
      const row = {
        id: "conn-1",
        connectorId: "composio",
        provider: "gmail",
        providerRef: "gmail",
        displayName: "Gmail",
        status: "pending",
        createdAt: new Date(0),
      };
      const client = {
        integrationProviderConfig: {
          findUnique: vi.fn(async () => ({ id: "composio", ciphertext: ref })),
        },
        connection: {
          findFirst: vi.fn(async () => row),
          findMany: vi.fn(async () => []),
          count: vi.fn(async () => 0),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        $executeRaw: vi.fn(),
        $queryRaw: vi.fn(async () => []),
      };
      const prisma = {
        ...client,
        $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
          const started = elapsed;
          if (changed) ref = "replacement-ref";
          inTransaction = true;
          try {
            const result = await fn(client);
            expect(elapsed - started).toBeLessThan(5_000);
            return result;
          } finally {
            inTransaction = false;
          }
        }),
      };
      const complete = vi.fn(async () => ({ connectionRef: "gmail" }));
      const revoke = vi.fn(async () => undefined);
      const adapter = {
        complete,
        revoke,
        connectionReady: vi.fn(async () => false),
      } as unknown as ManagedConnectorProvider;
      const settings = new IntegrationProviderSettings(
        prisma as unknown as PrismaClient,
        secrets,
        "fake-identity",
        {},
        () => adapter,
      );
      const connector = settings
        .providers()
        .find((provider) => provider.describe().id === "composio");
      const handler = new RPCHandler(
        createRouter({
          prisma,
          connectors: { managed: () => connector },
          env: {
            defaultProvider: "fake",
            defaultModel: "fake-model",
            webOrigin: "http://127.0.0.1:5173",
            screenProxySecret: "fake-test-secret",
            sandboxProvider: "fake",
          },
        } as unknown as RouterDeps),
      );
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/connections/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: {
              connectionId: row.id,
              ...(operation === "complete" ? { code: "fake-code" } : {}),
            },
          }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "workspace-1",
              userId: "user-1",
              email: "user@rakazo.test",
              isDeploymentOwner: true,
            },
          },
        },
      );
      expect(response.status).toBe(changed ? 409 : 200);
      expect(elapsed).toBe(15_000);
      expect(load).toHaveBeenCalledTimes(1);
      expect(operation === "complete" ? complete : revoke).toHaveBeenCalledTimes(changed ? 0 : 1);
    },
  );

  it("forwards an optional code to the managed connector", async () => {
    const complete = vi.fn().mockResolvedValue({ connectionRef: "gmail" });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const update = vi.fn().mockResolvedValue({
      id: "conn-1",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "connected",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        }),
        findMany: vi.fn().mockResolvedValue([]),
        update,
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const row = {
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        };
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          connection: {
            findFirst: vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null),
            findMany: vi.fn().mockResolvedValue([]),
            update: vi
              .fn()
              .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
                ...row,
                ...data,
              })),
          },
        };
        return fn(tx);
      }),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn(() => ({ complete, connectionReady })),
      },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
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
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/connections/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectionId: "conn-1",
            code: "123456",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith(
      { state: "gmail-state", code: "123456" },
      expect.objectContaining({ spaceId: "workspace-1", userId: "user-1" }),
    );
    expect(connectionReady).toHaveBeenCalled();
  });
});

describe("updater owner gate", () => {
  function updaterDeps() {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        gitSha: "deadbeef",
        updaterUrl: undefined,
        updaterToken: undefined,
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { deps, handler: new RPCHandler(createRouter(deps)) };
  }

  it("forbids non-owners from updater status", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-2",
      email: "member@rakazo.test",
      isDeploymentOwner: false,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(403);
  });

  it("lets the deployment owner read status without applying git", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.json.supported).toBe(false);
    expect(["source", "compose"]).toContain(body.json.installKind);
    expect(Array.isArray(body.json.manualCommands)).toBe(true);
  });

  it("refuses apply when the sidecar is not configured", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    const message = JSON.stringify(body);
    expect(message).toMatch(/sidecar/i);
    expect(message).not.toMatch(/git (fetch|merge|pull)/i);
  });
});

describe("computer screen url", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const computerRow = {
    id: "computer-1",
    screenGeneration: 3,
    kind: "e2b",
    scope: "team",
    state: "running",
    providerRef: "sandbox-ref-1",
    homeKey: "home-1",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
  };

  const callScreenUrl = async (connectScreen: () => Promise<unknown>, updateMany = vi.fn()) => {
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          screenGeneration: 2,
          thread: { id: "thread-1" },
          computer: computerRow,
        }),
      },
      computer: { updateMany },
      computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: { connectScreen },
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "e2b",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/computer/screenUrl", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, updateMany };
  };

  it("issues lifecycle-bound capabilities for managed-provider screens too", async () => {
    const { response } = await callScreenUrl(async () => ({
      url: "https://screen.example/vnc.html?token=fake-token",
    }));
    expect(response.status).toBe(200);
    const { json } = await response.json();
    const url = new URL(json.url);
    expect(url.origin).toBe("http://127.0.0.1:5173");
    expect(openScreenCapability(url.pathname, "fake-test-secret")).toMatchObject({
      scope: {
        botId: "bot-1",
        computerId: "computer-1",
        botGeneration: 2,
        computerGeneration: 3,
        controlLeaseId: null,
      },
      target: { hostname: "screen.example", interactive: false },
    });
  });

  it("returns desktop provider screen URLs without sealing them", async () => {
    const { response } = await callScreenUrl(async () => ({
      url: "desktop://screen/computer-1",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: { url: "desktop://screen/computer-1?view_only=true" },
    });
  });

  it("clears the row instead of 500ing when the provider says the sandbox is gone", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(
        Object.assign(new Error("Sandbox is probably not running anymore"), {
          name: "SandboxNotFoundError",
        }),
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { url: null } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });
  });

  it("keeps a transport blip an error and leaves the row alone", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })),
    );
    expect(response.status).toBe(500);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns a recoverable conflict when the screen is temporarily busy", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(new ComputerScreenUnavailableError()),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "CONFLICT",
        message: COMPUTER_SCREEN_UNAVAILABLE,
      }),
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("computer terminal and file transfer", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const controlled = {
    controlHolder: "user",
    controlLeaseId: "lease-1",
    controlLeaseExpiresAt: new Date(Date.now() + 60_000),
    controlBotId: "bot-1",
  };

  function setup(computer: Record<string, unknown> = {}) {
    const sandbox = {
      connectTerminal: vi.fn().mockResolvedValue({
        url: "https://screen.example/vnc.html?path=websockify%3Ftoken%3Dterminal-1",
      }),
      readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("hello")),
      writeFile: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          screenGeneration: 2,
          thread: { id: "thread-1" },
          computer: {
            id: "computer-1",
            screenGeneration: 3,
            kind: "docker",
            scope: "team",
            state: "running",
            providerRef: "sandbox-ref-1",
            homeKey: "home-1",
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlBotId: null,
            controlRunId: null,
            ...computer,
          },
        }),
      },
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox,
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      env: {
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "docker",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const call = async (procedure: string, json: Record<string, unknown>) => {
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/computer/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: "bot-1", ...json } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return { status: response.status, body: await response.json() };
    };
    return { sandbox, prisma, call };
  }

  it("opens a terminal only for the user holding this bot's control lease", async () => {
    const released = setup();
    await expect(released.call("terminalUrl", {})).resolves.toMatchObject({ status: 403 });
    expect(released.sandbox.connectTerminal).not.toHaveBeenCalled();

    const { sandbox, call } = setup(controlled);
    const { status, body } = await call("terminalUrl", {});
    expect(status).toBe(200);
    expect(sandbox.connectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { controlToken: "lease-1", cwd: "bots/bot-1" },
      expect.anything(),
    );
    const url = new URL(body.json.url);
    expect(url.origin).toBe("http://127.0.0.1:5173");
    expect(openScreenCapability(url.pathname, "fake-test-secret")).toMatchObject({
      scope: { botId: "bot-1", controlLeaseId: "lease-1" },
      target: { hostname: "screen.example", interactive: true },
    });
  });

  it("clears the row when the provider reclaimed the sandbox before the terminal opened", async () => {
    const gone = setup(controlled);
    gone.sandbox.connectTerminal.mockRejectedValueOnce(
      Object.assign(new Error("Sandbox is probably not running anymore"), {
        name: "SandboxNotFoundError",
      }),
    );
    await expect(gone.call("terminalUrl", {})).resolves.toEqual({
      status: 200,
      body: { json: { url: null } },
    });
    expect(gone.prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });

    const blip = setup(controlled);
    blip.sandbox.connectTerminal.mockRejectedValueOnce(new Error("fetch failed"));
    await expect(blip.call("terminalUrl", {})).resolves.toMatchObject({ status: 500 });
    expect(blip.prisma.computer.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: "stopped", providerRef: null } }),
    );
  });

  it("offers no terminal on host computers", async () => {
    const { sandbox, call } = setup({ ...controlled, kind: "desktop" });
    await expect(call("terminalUrl", {})).resolves.toEqual({
      status: 200,
      body: { json: { url: null } },
    });
    expect(sandbox.connectTerminal).not.toHaveBeenCalled();
  });

  it("uploads into the bot workspace only under control", async () => {
    const contentBase64 = Buffer.from("notes").toString("base64");
    const released = setup();
    await expect(
      released.call("uploadFile", { path: "notes.txt", contentBase64 }),
    ).resolves.toMatchObject({ status: 403 });
    expect(released.sandbox.writeFile).not.toHaveBeenCalled();

    const { sandbox, call } = setup(controlled);
    await expect(call("uploadFile", { path: "notes.txt", contentBase64 })).resolves.toMatchObject({
      status: 200,
    });
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sandbox-ref-1" }),
      { path: "bots/bot-1/notes.txt", content: Buffer.from("notes") },
      expect.anything(),
    );
  });

  it("rejects team uploads into another bot workspace", async () => {
    const contentBase64 = Buffer.from("x").toString("base64");
    const { sandbox, call } = setup(controlled);
    await expect(
      call("uploadFile", { path: "bots/bot-2/secret.txt", contentBase64 }),
    ).resolves.toMatchObject({ status: 400 });
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("downloads bytes from a running computer", async () => {
    const { sandbox, call } = setup();
    await expect(call("downloadFile", { path: "notes.txt" })).resolves.toEqual({
      status: 200,
      body: { json: { path: "notes.txt", contentBase64: Buffer.from("hello").toString("base64") } },
    });
    expect(sandbox.readFile).toHaveBeenCalledWith(
      expect.anything(),
      "bots/bot-1/notes.txt",
      expect.anything(),
      { maxBytes: 10 * 1024 * 1024 },
    );
    const stopped = setup({ state: "stopped" });
    await expect(stopped.call("downloadFile", { path: "notes.txt" })).resolves.toMatchObject({
      status: 409,
    });
  });
});

describe("integration setup authorization", () => {
  it.each([
    { owner: false, configured: false, needsSetup: false },
    { owner: true, configured: false, needsSetup: true },
    { owner: true, configured: true, needsSetup: false },
  ])(
    "offers server setup only to an owner without configured providers: %j",
    async ({ owner, configured, needsSetup }) => {
      const lookup = vi.fn(async () => configured);
      const deps = {
        prisma: {},
        env: { webOrigin: "https://example.test" },
        integrationSettings: { configured: lookup },
      } as unknown as RouterDeps;
      const handler = new RPCHandler(createRouter(deps));
      const { response } = await handler.handle(
        new Request("https://example.test/rpc/integrationSetup/get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: null }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              userId: "user",
              spaceId: "space",
              email: "user@rakazo.test",
              isDeploymentOwner: owner,
            },
          },
        },
      );
      const result = (await response.json()).json;
      expect(result).toMatchObject({ canConfigure: owner, needsSetup });
      if (!owner) {
        expect(result.providers).toEqual([]);
        expect(lookup).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects provider credentials from a non-owner before verification or persistence", async () => {
    const save = vi.fn();
    const deps = {
      prisma: {},
      env: { webOrigin: "https://example.test" },
      integrationSettings: { save },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const { response } = await handler.handle(
      new Request("https://example.test/rpc/integrationSetup/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { provider: "composio", apiKey: "fake-key" } }),
      }),
      {
        prefix: "/rpc",
        context: {
          actor: {
            userId: "member",
            spaceId: "space",
            email: "member@rakazo.test",
            isDeploymentOwner: false,
          },
        },
      },
    );
    expect(response.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("interrupted computer reservation release", () => {
  function fixture() {
    const order: string[] = [];
    const computerUpdate = {
      findFirst: vi.fn(async () => ({ id: "update-1", computerId: "computer-1" })),
      updateMany: vi.fn(async () => {
        order.push("operation");
        return { count: 1 };
      }),
    };
    const computer = {
      updateMany: vi.fn(async () => {
        order.push("computer");
        return { count: 1 };
      }),
    };
    const prisma = { computer, computerUpdate, $transaction: vi.fn(async (fn) => fn(prisma)) };
    const handler = new RPCHandler(
      createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
    );
    const call = async (owner: boolean, workersStopped?: boolean) =>
      handler.handle(
        new Request("http://127.0.0.1/rpc/computer/releaseInterrupted", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { id: "update-1", workersStopped } }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "space-1",
              userId: "user-1",
              email: "user@rakazo.test",
              isDeploymentOwner: owner,
            },
          },
        },
      );
    return { prisma, computer, computerUpdate, order, call };
  }
  it.each([
    { owner: false, stopped: true, status: 403 },
    { owner: true, stopped: false, status: 400 },
    { owner: true, stopped: undefined, status: 400 },
  ])(
    "requires owner authorization and an explicit stopped-workers assertion: %j",
    async ({ owner, stopped, status }) => {
      const { call, prisma } = fixture();
      const { response } = await call(owner, stopped);
      expect(response.status).toBe(status);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it("atomically releases only an interrupted reservation in the owner's workspace", async () => {
    const { call, computer, computerUpdate, order } = fixture();
    const { response } = await call(true, true);
    expect(response.status).toBe(200);
    expect(computerUpdate.findFirst).toHaveBeenCalledWith({
      where: {
        id: "update-1",
        status: "interrupted",
        computer: { spaceId: "space-1", bots: { some: { userId: "user-1", archivedAt: null } } },
      },
    });
    expect(computerUpdate.updateMany).toHaveBeenCalledWith({
      where: { id: "update-1", status: "interrupted" },
      data: { status: "failed" },
    });
    expect(computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", maintenanceId: "update-1" },
      data: { maintenanceId: null, state: "error" },
    });
    expect(order).toEqual(["operation", "computer"]);
  });
});

describe("model credential persistence", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;

  function persistDeps(options?: { envDefaultModel?: string }) {
    const upsert = vi.fn().mockResolvedValue({ id: "preference" });
    const finish = vi.fn();
    // Connect loads any previous credential on the root client before the write transaction.
    const userModelCredential = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: { provider: string } }) => ({
        id: "cred-1",
        userId: actor.userId,
        provider: data.provider,
        label: data.provider,
        secretId: "secret-1",
        supportsImages: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })),
    };
    const spaceModelPreference = {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert,
    };
    const tx = {
      userModelCredential,
      secret: { create: vi.fn().mockResolvedValue({}) },
      spaceModelPreference,
    };
    const deps = {
      prisma: {
        userModelCredential,
        spaceModelPreference,
        $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      },
      secrets: {
        put: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
      oauthLogins: {
        finish,
      },
      env: {
        defaultProvider: "openrouter",
        defaultModel: options?.envDefaultModel ?? "openai/gpt-5.6-luna",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        agentRuntime: "pi",
      },
    } as unknown as RouterDeps;
    return { upsert, finish, deps, handler: new RPCHandler(createRouter(deps)) };
  }

  async function call(handler: RPCHandler<never>, path: string, body: unknown): Promise<Response> {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("does not persist a stringified null model id from subscription sign-in", async () => {
    const { upsert, finish, handler } = persistDeps();
    finish.mockImplementation(async (_loginId, _actor, persist) => ({
      status: "connected" as const,
      value: await persist({
        status: "connected",
        provider: "anthropic",
        modelId: "null",
        label: "Anthropic",
        credential: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        signal: new AbortController().signal,
      }),
    }));

    const response = await call(handler, "models/finishOAuth", { loginId: "login-1" });
    expect(response.status).toBe(200);
    const persisted = upsert.mock.calls[0]?.[0] as {
      create: { modelId: string | null };
      update: { modelId: string | null };
    };
    expect(persisted.create.modelId).not.toBe("null");
    expect(persisted.create.modelId).toBeTruthy();
    expect(persisted.update.modelId).toBe(persisted.create.modelId);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        provider: "anthropic",
        modelId: persisted.create.modelId,
      }),
    });
  });

  it("does not persist a missing model id as the string null", async () => {
    const { upsert, handler } = persistDeps({ envDefaultModel: "null" });

    const response = await call(handler, "models/connect", {
      provider: "test-provider",
      apiKey: "sk-test-key-123",
      modelId: undefined,
    });
    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ modelId: null }),
        update: expect.objectContaining({ modelId: null }),
      }),
    );
  });

  it("rejects an API key for ChatGPT-subscription Codex before persisting", async () => {
    const { upsert, deps, handler } = persistDeps();

    const response = await call(handler, "models/connect", {
      provider: "openai-codex",
      apiKey: "sk-test-key-123",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: expect.stringContaining("ChatGPT subscription sign-in is required"),
      }),
    });
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("still accepts an API key for other providers", async () => {
    const { deps, handler } = persistDeps();

    const response = await call(handler, "models/connect", {
      provider: "anthropic",
      apiKey: "sk-test-key-123",
    });

    expect(response.status).toBe(200);
    expect(deps.secrets.put).toHaveBeenCalledWith(
      "sk-test-key-123",
      expect.objectContaining({ userId: actor.userId }),
    );
  });

  it.each([
    ["github-copilot", "GitHub Copilot"],
    ["openai-codex", "OpenAI Codex"],
    ["anthropic", "Anthropic"],
  ])("labels a %s subscription sign-in with its own provider name", async (provider, label) => {
    const { finish, deps, handler } = persistDeps();
    finish.mockImplementation(async (_loginId, _actor, persist) => ({
      status: "connected" as const,
      value: await persist({
        status: "connected",
        provider,
        credential: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        signal: new AbortController().signal,
      }),
    }));

    const response = await call(handler, "models/finishOAuth", { loginId: "login-1" });

    expect(response.status).toBe(200);
    expect(deps.prisma.userModelCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider, label }),
      }),
    );
  });
});

describe("bot intro run", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const bot = { id: "bot-1", threadId: "thread-1" } as unknown as Bot;

  function introDeps(options: { agentRuntime?: string; hasCredential?: boolean } = {}) {
    let calls = 0;
    const create = vi.fn(({ data }: { data: object }) => {
      calls += 1;
      return Promise.resolve({ id: `record-${calls}`, ...data });
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const tx = { task: { create }, run: { create } };
    const preference =
      (options.hasCredential ?? true)
        ? { isDefault: true, modelId: "model-1", credential: { id: "cred-1", provider: "test" } }
        : null;
    const spaceModelPreference = { findFirst: vi.fn().mockResolvedValue(preference) };
    const deps = {
      prisma: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        spaceModelPreference,
        deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      },
      jobs: { enqueue },
      env: { agentRuntime: options.agentRuntime ?? "pi" },
    } as unknown as RouterDeps;
    return { create, enqueue, deps };
  }

  it("queues an invisible-prompt run so the bot states how it read its role", async () => {
    const { create, enqueue, deps } = introDeps();

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "space-1",
          botId: "bot-1",
          threadId: "thread-1",
          userId: "user-1",
          status: "queued",
        }),
      }),
    );
    const [taskCall, runCall] = create.mock.calls as Array<
      [{ data: { prompt?: string; trigger?: string; taskId?: string } }]
    >;
    expect(taskCall?.[0].data.prompt).toMatch(/understood your role/i);
    expect(runCall?.[0].data.trigger).toBe("created");
    // The Run must reference the Task this same call created, not a stale or
    // mismatched id, and the enqueued job must target that Run.
    expect(runCall?.[0].data.taskId).toBe("record-1");
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload: { runId: "record-2" } }),
    );
  });

  it("does nothing when the bot has no thread", async () => {
    const { create, enqueue, deps } = introDeps();

    await enqueueBotIntroRun(deps, actor, { id: "bot-1", threadId: null } as unknown as Bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does nothing on the scripted test/eval runtime", async () => {
    const { create, enqueue, deps } = introDeps({ agentRuntime: "scripted" });

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does nothing when no model is configured yet", async () => {
    const { create, enqueue, deps } = introDeps({ hasCredential: false });

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("codex catalog auth", () => {
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

  async function call(handler: RPCHandler<never>, path: string, body: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  function catalogDeps() {
    const load = vi.fn((ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey));
    const prisma = {
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([
          { provider: "openai-codex", secretId: "secret-api" },
          { provider: "openai-codex", secretId: "secret-oauth" },
        ]),
      },
      spaceModelPreference: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { credential: { provider: "openai-codex", secretId: "secret-oauth" } },
          ]),
      },
      secret: {
        findMany: vi.fn().mockResolvedValue([{ id: "secret-oauth", ciphertext: "cipher-oauth" }]),
      },
    };
    const deps = {
      prisma,
      secrets: { load },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps;
    return { load, prisma, handler: new RPCHandler(createRouter(deps)) };
  }

  it("hides Codex Spark for the space's ChatGPT credential when a newer key exists", async () => {
    const { load, prisma, handler } = catalogDeps();

    const response = await call(handler, "models/list", null);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      json: Array<{ provider: string; id: string }>;
    };
    expect(body.json.some((entry) => entry.provider === "openai-codex" && entry.id === spark)).toBe(
      false,
    );
    expect(body.json.some((entry) => entry.provider === "openai-codex" && entry.id === luna)).toBe(
      true,
    );
    expect(prisma.spaceModelPreference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: actor.userId, spaceId: actor.spaceId },
      }),
    );
    expect(load).toHaveBeenCalledWith("cipher-oauth", "secret-oauth");
    expect(load).not.toHaveBeenCalledWith("cipher-api", "secret-api");
  });
});

describe("codex live catalog", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";
  const sol = "gpt-6-sol";
  const oauth = (accountId?: string) =>
    JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      ...(accountId ? { accountId } : {}),
    });
  const apiKey = "sk-test-api-key-12345678";

  function liveModel(slug: string) {
    return {
      slug,
      reasoningEfforts: ["low", "medium", "high"],
      contextWindow: 272_000,
      supportsImages: false,
      supportsFastTier: true,
    };
  }

  async function call(handler: RPCHandler<never>, path: string, body: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  async function listIds(handler: RPCHandler<never>): Promise<string[]> {
    const response = await call(handler, "models/list", null);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      json: Array<{ provider: string; id: string }>;
    };
    return body.json.filter((entry) => entry.provider === "openai-codex").map((entry) => entry.id);
  }

  function catalogDeps(opts: {
    read: ReturnType<typeof vi.fn>;
    oauthAccountId?: string | null;
    apiKeyOnly?: boolean;
    disconnected?: boolean;
  }) {
    const oauthPlaintext = oauth(
      opts.oauthAccountId === null ? undefined : (opts.oauthAccountId ?? "acct-live-test"),
    );
    const load = vi.fn((ciphertext: string) =>
      ciphertext === "cipher-oauth" ? oauthPlaintext : apiKey,
    );
    const prisma = opts.disconnected
      ? {
          userModelCredential: { findMany: vi.fn().mockResolvedValue([]) },
          spaceModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
          secret: { findMany: vi.fn().mockResolvedValue([]) },
        }
      : opts.apiKeyOnly
        ? {
            userModelCredential: {
              findMany: vi
                .fn()
                .mockResolvedValue([{ provider: "openai-codex", secretId: "secret-api" }]),
            },
            spaceModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
            secret: {
              findMany: vi.fn().mockResolvedValue([{ id: "secret-api", ciphertext: "cipher-api" }]),
            },
          }
        : {
            userModelCredential: {
              findMany: vi.fn().mockResolvedValue([
                { provider: "openai-codex", secretId: "secret-api" },
                { provider: "openai-codex", secretId: "secret-oauth" },
              ]),
            },
            spaceModelPreference: {
              findMany: vi
                .fn()
                .mockResolvedValue([
                  { credential: { provider: "openai-codex", secretId: "secret-oauth" } },
                ]),
            },
            secret: {
              findMany: vi
                .fn()
                .mockResolvedValue([{ id: "secret-oauth", ciphertext: "cipher-oauth" }]),
            },
          };
    const deps = {
      prisma,
      secrets: { load },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      codexCatalog: { read: opts.read },
    } as unknown as RouterDeps;
    return { handler: new RPCHandler(createRouter(deps)) };
  }

  it("unlocks Spark and bounds the codex list to the live account catalog", async () => {
    const read = vi.fn().mockResolvedValue([liveModel(spark), liveModel(luna)]);
    const { handler } = catalogDeps({ read });

    const ids = await listIds(handler);

    expect(ids).toContain(spark);
    expect(ids).toContain(luna);
    expect(ids).not.toContain(sol);
    expect(read).toHaveBeenCalledWith(
      actor.userId,
      expect.objectContaining({ accountId: "acct-live-test" }),
    );
  });

  it("keeps the static oauth catalog when the live read fails", async () => {
    const read = vi.fn().mockResolvedValue(undefined);
    const { handler } = catalogDeps({ read });

    const ids = await listIds(handler);

    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
  });

  it("ignores a live catalog that shares no known codex slug", async () => {
    const read = vi.fn().mockResolvedValue([liveModel("gpt-unknown-from-backend")]);
    const { handler } = catalogDeps({ read });

    const ids = await listIds(handler);

    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
    expect(ids).not.toContain("gpt-unknown-from-backend");
  });

  it("never reads the catalog for an API-key credential and still lists Spark", async () => {
    const read = vi.fn().mockResolvedValue([liveModel(spark)]);
    const { handler } = catalogDeps({ read, apiKeyOnly: true });

    const ids = await listIds(handler);

    expect(ids).toContain(spark);
    expect(read).not.toHaveBeenCalled();
  });

  it("never reads the catalog when no credential exists", async () => {
    const read = vi.fn().mockResolvedValue([liveModel(spark)]);
    const { handler } = catalogDeps({ read, disconnected: true });

    const ids = await listIds(handler);

    // Disconnected browsing still lists Codex models but keeps the Spark exclusion.
    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
    expect(read).not.toHaveBeenCalled();
  });

  it("falls back to the static catalog when the oauth credential has no account id", async () => {
    const read = vi.fn().mockResolvedValue([liveModel(spark)]);
    const { handler } = catalogDeps({ read, oauthAccountId: null });

    const ids = await listIds(handler);

    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
    expect(read).not.toHaveBeenCalled();
  });

  it("governs each codex model by the credential that owns it", async () => {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const credentialA = {
      id: "cred-a",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT A",
      secretId: "secret-a",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const credentialB = { ...credentialA, id: "cred-b", secretId: "secret-b" };
    const prisma = {
      userModelCredential: { findMany: vi.fn().mockResolvedValue([credentialA, credentialB]) },
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-luna",
            modelId: luna,
            isDefault: true,
            updatedAt: stamp,
            credential: credentialA,
          },
          {
            id: "pref-spark",
            modelId: spark,
            isDefault: false,
            updatedAt: stamp,
            credential: credentialB,
          },
        ]),
      },
      secret: {
        findMany: vi.fn().mockResolvedValue([
          { id: "secret-a", ciphertext: "cipher-a" },
          { id: "secret-b", ciphertext: "cipher-b" },
        ]),
      },
    };
    const secrets = {
      load: (ciphertext: string) => (ciphertext === "cipher-a" ? oauth("acct-a") : oauth("acct-b")),
    };
    const deps = {
      prisma,
      secrets,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps;

    // Spark's preference points at account B: only B's catalog can unlock it.
    const read = vi.fn(async (_userId: string, account: { accountId: string }) =>
      account.accountId === "acct-b" ? [liveModel(spark)] : [liveModel(luna)],
    );
    deps.codexCatalog = { read };
    const first = await listIds(new RPCHandler(createRouter(deps)));
    expect(first).toContain(spark);
    expect(first).toContain(luna);

    // Account A listing Spark must not unlock it — B's catalog does not list it.
    const swapped = vi.fn(async (_userId: string, account: { accountId: string }) =>
      account.accountId === "acct-a" ? [liveModel(spark), liveModel(luna)] : [liveModel(luna)],
    );
    deps.codexCatalog = { read: swapped };
    const second = await listIds(new RPCHandler(createRouter(deps)));
    expect(second).not.toContain(spark);
    expect(second).toContain(luna);
  });

  it("never fetches the catalog for an expired token and kicks a detached refresh", async () => {
    const expiredOauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() - 1_000,
      accountId: "acct-live-test",
    });
    const prisma = {
      userModelCredential: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ provider: "openai-codex", secretId: "secret-oauth" }]),
      },
      spaceModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
      secret: {
        findMany: vi.fn().mockResolvedValue([{ id: "secret-oauth", ciphertext: "cipher-oauth" }]),
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ models: [{ slug: spark, visibility: "list", supported_in_api: true }] }),
          { status: 200 },
        ),
    );
    const refreshExpiredModelCredential = vi.fn();
    const deps = {
      prisma,
      secrets: { load: vi.fn(() => expiredOauth), put: vi.fn() },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      codexCatalog: new CodexCatalogCache({ fetch: fetchImpl }),
      refreshExpiredModelCredential,
    } as unknown as RouterDeps;

    const ids = await listIds(new RPCHandler(createRouter(deps)));

    // Static exclusion stands this round; the credential's refresh is kicked so
    // the next read can see the account's real catalog.
    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(refreshExpiredModelCredential).toHaveBeenCalledWith(
      expect.objectContaining({ userId: actor.userId }),
      "secret-oauth",
      "openai-codex",
    );
  });

  it("lets models.setDefault pick Spark when the account's live catalog lists it", async () => {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const upsert = vi.fn(async () => ({ id: "pref-spark" }));
    const tx = {
      userModelCredential: { findMany: vi.fn().mockResolvedValue([oauthCredential]) },
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(async () => ({ count: 0 })),
        upsert,
      },
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-oauth", ciphertext: "cipher-oauth" })),
      },
    };
    const deps = {
      prisma: { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) },
      secrets: { load: vi.fn(() => oauth("acct-live-test")) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      codexCatalog: { read: vi.fn(async () => [liveModel(spark)]) },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-oauth",
          },
        },
      }),
    );
  });

  it("still rejects models.setDefault for Spark when the live catalog omits it", async () => {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const oauthCredential = {
      id: "cred-oauth",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-oauth",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const tx = {
      userModelCredential: { findMany: vi.fn().mockResolvedValue([oauthCredential]) },
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(async () => ({ count: 0 })),
        upsert: vi.fn(async () => ({ id: "pref-spark" })),
      },
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-oauth", ciphertext: "cipher-oauth" })),
      },
    };
    const deps = {
      prisma: { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) },
      secrets: { load: vi.fn(() => oauth("acct-live-test")) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      codexCatalog: { read: vi.fn(async () => [liveModel(luna)]) },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));

    const response = await call(handler, "models/setDefault", {
      provider: "openai-codex",
      modelId: spark,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/not available with your current sign-in/i),
      }),
    });
  });

  it.each(["unchanged", "rotated", "reconnected", "unavailable"] as const)(
    "prepares slow model secrets before the transaction: %s",
    async (change) => {
      const stamp = new Date("2026-01-01T00:00:00.000Z");
      const oauthCredential = {
        id: "cred-oauth",
        userId: actor.userId,
        provider: "openai-codex",
        label: "ChatGPT",
        secretId: "secret-oauth",
        createdAt: stamp,
        updatedAt: stamp,
      };
      const upsert = vi.fn(async () => ({ id: "pref-spark" }));
      const tx = {
        userModelCredential: { findMany: vi.fn().mockResolvedValue([oauthCredential]) },
        spaceModelPreference: {
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: vi.fn(async () => ({ count: 0 })),
          upsert,
        },
        secret: {
          findFirst: vi.fn(async () => ({ id: "secret-oauth", ciphertext: "cipher-oauth" })),
        },
      };
      let elapsed = 0;
      let inTransaction = false;
      const transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => {
        if (change === "rotated")
          tx.secret.findFirst.mockResolvedValue({ id: "secret-oauth", ciphertext: "rotated" });
        if (change === "reconnected")
          tx.userModelCredential.findMany.mockResolvedValue([
            { ...oauthCredential, secretId: "replacement" },
          ]);
        const started = elapsed;
        inTransaction = true;
        try {
          const result = await fn(tx);
          expect(elapsed - started).toBeLessThan(5_000);
          return result;
        } finally {
          inTransaction = false;
        }
      });
      const prisma = {
        $transaction: transaction,
        userModelCredential: tx.userModelCredential,
        spaceModelPreference: { findMany: tx.spaceModelPreference.findMany },
        secret: tx.secret,
      };
      const read = vi.fn(
        async (_userId: string, _account: { accountId: string }, _opts?: { waitMs?: number }) => [
          liveModel(spark),
        ],
      );
      const refreshExpiredModelCredential = vi.fn();
      const deps = {
        prisma,
        secrets: {
          load: vi.fn(async () => {
            expect(inTransaction).toBe(false);
            elapsed += 15_000;
            if (change === "unavailable") throw new SecretStoreUnavailableError();
            return oauth("acct-live-test");
          }),
          put: vi.fn(),
        },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
        codexCatalog: { read },
        refreshExpiredModelCredential,
      } as unknown as RouterDeps;
      const handler = new RPCHandler(createRouter(deps));

      const response = await call(handler, "models/setDefault", {
        provider: "openai-codex",
        modelId: spark,
      });

      expect(elapsed).toBe(15_000);
      expect(response.status).toBe(
        change === "unchanged" ? 200 : change === "unavailable" ? 503 : 409,
      );
      if (change === "unchanged") {
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.invocationCallOrder[0]).toBeLessThan(
          transaction.mock.invocationCallOrder[0]!,
        );
        expect(upsert).toHaveBeenCalled();
      } else {
        expect(upsert).not.toHaveBeenCalled();
      }
    },
  );
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

  async function call(handler: RPCHandler<never>, path: string, body: unknown) {
    const { response } = await handler.handle(
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
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-spark",
            modelId: spark,
            isDefault: false,
            updatedAt: older,
            credential: apiCredential,
          },
          {
            id: "pref-luna",
            modelId: luna,
            isDefault: true,
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
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-api",
          },
        },
        update: { modelId: spark, isDefault: true, thinkingLevel: null },
      }),
    );
  });

  it("does not rewrite a Spark API-key preference when another Codex model becomes the default", async () => {
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
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-spark",
            modelId: spark,
            isDefault: true,
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
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-oauth",
          },
        },
        create: expect.objectContaining({ modelId: luna, isDefault: true }),
        update: { modelId: luna, isDefault: true, thinkingLevel: null },
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        isDefault: true,
        credentialId: { not: "cred-oauth" },
      },
      data: { isDefault: false },
    });
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
      spaceModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-spark",
            modelId: spark,
            isDefault: true,
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
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-api",
          },
        },
        update: { modelId: luna, isDefault: true, thinkingLevel: null },
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

  async function call(handler: RPCHandler<never>, path: string, body: unknown) {
    const { response } = await handler.handle(
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
      thread: { id: "thread-1", unread: false, messages: [] },
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
      isDefault: boolean;
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
      bot: { update: botUpdate },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 2 })) },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => bot),
        findMany: vi.fn(async () => [{ ...bot, name: "Ada renamed" }]),
        update: botUpdate,
      },
      spaceModelPreference: { findFirst: preferenceFindFirst },
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
      handler: new RPCHandler(createRouter(deps)),
    };
  }

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

  it("rejects setting Codex Spark on the space's ChatGPT subscription credential", async () => {
    const oauthCredential = credentialRow("cred-oauth", "secret-oauth");
    const { preferenceFindFirst, handler } = saveDeps({
      modelId: luna,
      preferences: (args) => {
        if (args.where.modelId) return null;
        if (args.where.credential?.provider === "openai-codex") {
          return { credential: oauthCredential, isDefault: true, modelId: luna };
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
        message: expect.stringMatching(/not available with your current sign-in/i),
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
          return { credential: apiCredential, isDefault: false, modelId: spark };
        }
        if (args.where.credential?.provider === "openai-codex") {
          return { credential: oauthCredential, isDefault: true, modelId: luna };
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
});

describe("bot restore computer quota", () => {
  function fixture(archivedBot: { archivedAt: Date | null } | null, inUse = 0) {
    const bot = archivedBot
      ? {
          ...archivedBot,
          id: "bot-archived",
          computerId: "computer-archived",
          computer: { id: "computer-archived" },
          userId: "user-1",
        }
      : null;
    const botApi = {
      findFirst: vi.fn(async () => bot),
      update: vi.fn(async () => ({})),
    };
    const computer = {
      count: vi.fn(async (args: { where: { id?: string } }) => (args.where.id ? 0 : inUse)),
    };
    const $queryRaw = vi.fn(async () => [{ lock: "1" }]);
    const prisma = {
      bot: botApi,
      computer,
      $queryRaw,
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ $queryRaw, computer, bot: botApi }),
      ),
    };
    const handler = new RPCHandler(
      createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
    );
    const call = async () =>
      handler.handle(
        new Request("http://127.0.0.1/rpc/bots/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: "bot-archived" } }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "space-1",
              userId: "user-1",
              email: "user@rakazo.test",
              isDeploymentOwner: true,
            },
          },
        },
      );
    return { prisma, call };
  }

  it("archives, creates, then restores is refused when the restore would exceed the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, call } = fixture({ archivedAt: new Date() }, 1);
    const { response } = await call();
    expect(response.status).toBe(400);
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("restores normally when the user is below the cap or the computer is already live", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, call } = fixture({ archivedAt: new Date() }, 0);
    const { response } = await call();
    expect(response.status).toBe(200);
    expect(prisma.bot.update).toHaveBeenCalledWith({
      where: { id: "bot-archived" },
      data: { archivedAt: null },
    });
  });

  it("does not enforce anything when the cap is unset", async () => {
    const { prisma, call } = fixture({ archivedAt: new Date() }, 99);
    const { response } = await call();
    expect(response.status).toBe(200);
    expect(prisma.bot.update).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
});

describe("routines.update", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const routine = {
    id: "routine-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    name: "Later",
    prompt: "say done",
    crons: ["@once"],
    timezone: "UTC",
    active: false,
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };

  function fixture(botArchived: boolean, archivedBeforeWrite = false) {
    const update = vi.fn(async (args: { data: Record<string, unknown> }) => {
      if (archivedBeforeWrite) throw Object.assign(new Error("not found"), { code: "P2025" });
      return {
        ...routine,
        ...Object.fromEntries(Object.entries(args.data).filter(([, value]) => value !== undefined)),
      };
    });
    const enqueue = vi.fn(async () => undefined);
    const prisma = {
      routine: {
        findFirst: vi.fn(async (args: { where: { bot?: { archivedAt: null } } }) =>
          botArchived && args.where.bot?.archivedAt === null ? null : routine,
        ),
        update,
      },
      bot: {
        findFirst: vi.fn(async () =>
          botArchived ? null : { id: "bot-1", thread: { id: "thread-1" }, computer: null },
        ),
      },
    };
    const handler = new RPCHandler(
      createRouter({
        prisma,
        env: { sandboxProvider: "fake" },
        events: { append: vi.fn(async () => undefined) },
        jobs: { enqueue, cancel: vi.fn(async () => undefined) },
      } as unknown as RouterDeps),
    );
    const call = () =>
      handler.handle(
        new Request("http://127.0.0.1/rpc/routines/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: {
              routineId: "routine-1",
              active: true,
              runAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    return { update, enqueue, call };
  }

  it("refuses to re-arm a routine on an archived bot without writing", async () => {
    const { update, enqueue, call } = fixture(true);
    const { response } = await call();
    expect(response.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-arms a routine on an active bot", async () => {
    const { update, enqueue, call } = fixture(false);
    const { response } = await call();
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "routine-1", bot: { archivedAt: null } },
        data: expect.objectContaining({ active: true }),
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("does not re-arm when the bot is archived between the read and the write", async () => {
    const { enqueue, call } = fixture(false, true);
    const { response } = await call();
    expect(response.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("threads.endCall", () => {
  function fixture(duplicateMarker?: boolean) {
    const created: { blocks?: unknown; clientNonce?: string }[] = [];
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 3, nextEventSeq: 5 }) },
      message: {
        create: vi.fn(async ({ data }: { data: { blocks: unknown; clientNonce?: string } }) => {
          if (duplicateMarker) throw Object.assign(new Error("unique"), { code: "P2002" });
          created.push({ blocks: data.blocks, clientNonce: data.clientNonce });
          return { id: "message-1" };
        }),
      },
      event: vi.fn(),
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      run: {
        create: vi.fn().mockResolvedValue({ id: "run-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
      },
    };
    tx.event = {
      create: vi.fn(async ({ data }: { data: { type: string; payload: never } }) => {
        events.push({ type: data.type, payload: data.payload });
        return { seq: 4, threadId: "thread-1" };
      }),
    } as never;
    const prisma = {
      bot: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "bot-1", thread: { id: "thread-1" }, computer: null }),
      },
      taughtSkill: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaClient;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma,
      events: { notify: vi.fn().mockResolvedValue(undefined) },
      jobs: { enqueue },
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "space-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));
    return {
      tx,
      created,
      events,
      enqueue,
      call: () =>
        handler.handle(
          new Request("http://127.0.0.1/rpc/threads/endCall", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { botId: "bot-1", callId: "call-1" } }),
          }),
          { prefix: "/rpc", context: { actor } },
        ),
    };
  }

  it("closes the card and queues a call_end run", async () => {
    const { call, created, events, tx, enqueue } = fixture();
    const { response } = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(created[0]?.blocks).toEqual([
      { kind: "voice_call", callId: "call-1", title: "", farewell: "" },
    ]);
    expect(created[0]?.clientNonce).toBe("call:call-1:marker");
    expect(events.map((event) => event.type)).toEqual([
      "thread.message.created",
      "thread.call.ended",
    ]);
    expect(events[1]?.payload).toMatchObject({
      callId: "call-1",
      title: "",
      messageId: "message-1",
    });
    expect(events[0]?.payload).toMatchObject({ callId: "call-1", messageId: "message-1" });
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "call_end", taskId: "task-1" }),
      }),
    );
    expect(String(tx.run.create.mock.calls[0]?.[0]?.data?.clientNonce)).toMatch(/^call:call-1:/);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("is a no-op when a concurrent hang-up already wrote the marker", async () => {
    const { call, created, events, tx, enqueue } = fixture(true);
    const { response } = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(created).toEqual([]);
    expect(events).toEqual([]);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("groups.archive", () => {
  async function archiveGroup(archivedAt: Date | null) {
    const calls: string[] = [];
    const groupUpdate = vi.fn();
    // As in production: the run's computer is known only through its execution lease.
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          archivedAt,
          thread: { id: "thread-1" },
        }),
        update: groupUpdate,
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computerId: "computer-1", botId: "bot-1", runId: "run-1", fence: 3 },
          ]),
        updateMany: vi.fn(async () => {
          calls.push("expire lease");
        }),
      },
      computer: {
        findMany: vi.fn(async ({ where }: { where: { OR?: unknown } }) =>
          where.OR
            ? [
                {
                  id: "computer-1",
                  homeKey: "home-1",
                  kind: "docker",
                  providerRef: "computer-1",
                  executionBotId: null,
                  executionRunId: null,
                },
              ]
            : [],
        ),
        updateMany: vi.fn(),
      },
      event: { deleteMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      computerExecutionLease: {
        updateMany: vi.fn(async () => {
          calls.push("expire lease");
        }),
      },
      computer: { updateMany: vi.fn() },
    } as unknown as PrismaClient;
    const releaseScreen = vi.fn(async () => {
      calls.push("release screen");
    });
    const execute = vi.fn(() => {
      calls.push("cancel run work");
      return [];
    });
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
      sandbox: { releaseScreen, execute },
      jobs: { cancel: vi.fn().mockResolvedValue(undefined) },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await new RPCHandler(createRouter(deps)).handle(
      new Request("http://127.0.0.1/rpc/groups/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { groupId: "group-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, releaseScreen, calls, groupUpdate };
  }

  it("stops each member's run work and releases its screen before expiring the lease", async () => {
    const { response, releaseScreen, calls } = await archiveGroup(null);

    expect(response?.status).toBe(200);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      expect.objectContaining({
        botId: "bot-1",
        runId: "run-1",
        screenLeaseId: screenLeaseIdForRun({ runId: "run-1", fence: 3 }, "run-1"),
        cancelRunWork: true,
      }),
    );
    expect(calls).toEqual(["cancel run work", "release screen", "expire lease"]);
  });

  it("finishes teardown when the group is already archived and a lease is still live", async () => {
    const { response, releaseScreen, calls, groupUpdate } = await archiveGroup(
      new Date("2026-09-26T00:00:00.000Z"),
    );

    expect(response?.status).toBe(200);
    expect(groupUpdate).not.toHaveBeenCalled();
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      expect.objectContaining({
        botId: "bot-1",
        runId: "run-1",
        screenLeaseId: screenLeaseIdForRun({ runId: "run-1", fence: 3 }, "run-1"),
        cancelRunWork: true,
      }),
    );
    expect(calls).toEqual(["cancel run work", "release screen", "expire lease"]);
  });
});
