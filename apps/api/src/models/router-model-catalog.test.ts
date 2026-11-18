import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import { CodexCatalogCache, listPiCatalog } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import type { RouterHandler } from "../router-test-support.js";
import { appHandler, createRouter, handle } from "../router-test-support.js";

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

  function catalogDeps() {
    const load = vi.fn((ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey));
    const prisma = {
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([
          { provider: "openai-codex", secretId: "secret-api" },
          { provider: "openai-codex", secretId: "secret-oauth" },
        ]),
      },
      userModelPreference: {
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

  it("hides Codex Spark for the preferred ChatGPT credential when a newer key exists", async () => {
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
    expect(prisma.userModelPreference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: actor.userId },
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

  async function listIds(handler: RouterHandler): Promise<string[]> {
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
          userModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
          secret: { findMany: vi.fn().mockResolvedValue([]) },
        }
      : opts.apiKeyOnly
        ? {
            userModelCredential: {
              findMany: vi
                .fn()
                .mockResolvedValue([{ provider: "openai-codex", secretId: "secret-api" }]),
            },
            userModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
            secret: {
              findMany: vi.fn().mockResolvedValue([{ id: "secret-api", ciphertext: "cipher-api" }]),
            },
          }
        : {
            userModelCredential: {
              findMany: vi.fn().mockResolvedValue([
                { id: "credential-api", provider: "openai-codex", secretId: "secret-api" },
                { id: "credential-oauth", provider: "openai-codex", secretId: "secret-oauth" },
              ]),
            },
            userModelPreference: {
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
              findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
                id: where.id,
                ciphertext: where.id === "secret-oauth" ? "cipher-oauth" : "cipher-api",
              })),
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

  it("never reads the catalog for an API-key credential", async () => {
    const read = vi.fn().mockResolvedValue([liveModel(spark)]);
    const { handler } = catalogDeps({ read, apiKeyOnly: true });

    const ids = await listIds(handler);

    // Pi no longer bundles Spark for Codex; only an account catalog can add it.
    expect(ids).not.toContain(spark);
    expect(ids).toContain(luna);
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
      userModelPreference: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "pref-luna",
            modelId: luna,
            updatedAt: stamp,
            credential: credentialA,
          },
          {
            id: "pref-spark",
            modelId: spark,
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
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          ciphertext: where.id === "secret-a" ? "cipher-a" : "cipher-b",
        })),
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
      // A catalog is trusted only when it shares a bundled slug, so B lists Luna too.
      account.accountId === "acct-b" ? [liveModel(spark), liveModel(luna)] : [liveModel(luna)],
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
      userModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
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
      codexCatalog: new CodexCatalogCache({ enabled: true, fetch: fetchImpl }),
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
      userModelPreference: {
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
          userId_credentialId: {
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
      userModelPreference: {
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
        userModelPreference: {
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
        userModelPreference: { findMany: tx.userModelPreference.findMany },
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
      const handler = appHandler(deps);

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

describe("API-key live model catalog", () => {
  it.each([false, true])(
    "merges a fake provider probe and keeps saved selections (failure=%s)",
    async (fails) => {
      const bundled = listPiCatalog().filter((entry) => entry.provider === "openai");
      const retired = bundled[0]!.id;
      const saved = bundled[1]!.id;
      const liveOnly = "gpt-future-live-chat";
      const probe = vi.fn(async () => {
        if (fails) throw new Error("fake provider failure");
        return [...bundled.slice(2).map((entry) => entry.id), liveOnly, "text-embedding-future"];
      });
      const credential = {
        id: "credential-test",
        provider: "openai",
        secretId: "secret-test",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      const prisma = {
        userModelCredential: { findMany: vi.fn(async () => [credential]) },
        userModelPreference: { findMany: vi.fn(async () => []) },
        secret: {
          findMany: vi.fn(async () => [{ id: "secret-test", ciphertext: "fake-ciphertext" }]),
        },
        bot: { findMany: vi.fn(async () => [{ modelProvider: "openai", modelId: saved }]) },
        routine: { findMany: vi.fn(async () => []) },
        userModelRoleChoice: { findMany: vi.fn(async () => []) },
        spaceModelRoleChoice: { findMany: vi.fn(async () => []) },
        deploymentSettings: { findFirst: vi.fn(async () => null) },
      };
      const load = vi.fn(async () => "fake-api-key");
      const deps = {
        prisma,
        secrets: { load },
        providerCatalog: new adapters.ProviderCatalogCache({ enabled: true, probe }),
        env: { agentRuntime: "pi", defaultProvider: "fake", defaultModel: "fake" },
      } as unknown as RouterDeps;
      const actor = {
        userId: "user-test",
        spaceId: "space-test",
        email: "user@example.test",
        isDeploymentOwner: false,
      } satisfies Actor;
      const client = createRouterClient(createRouter(deps), { context: { actor } as never });
      const entries = await client.models.list();
      const openai = entries.filter((entry) => entry.provider === "openai");
      expect(openai.some((entry) => entry.id === retired)).toBe(fails);
      expect(openai.some((entry) => entry.id === saved)).toBe(true);
      expect(openai.some((entry) => entry.id === liveOnly)).toBe(!fails);
      expect(openai.some((entry) => entry.id === "text-embedding-future")).toBe(false);
      if (!fails)
        expect(openai.at(-1)).toMatchObject({
          provider: "openai",
          providerName: "OpenAI",
          id: liveOnly,
          label: liveOnly,
          auth: "api-key",
        });
      await client.models.list();
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith(
        { provider: "openai", apiKey: "fake-api-key" },
        undefined,
        expect.any(AbortSignal),
      );
      expect(prisma.secret.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: actor.userId, spaceId: null }),
        }),
      );
    },
  );
});
