import { RPCHandler } from "@orpc/server/fetch";
import type { PiOAuthConnected, PiOAuthPersist } from "@rakazo/adapters";
import * as adapters from "@rakazo/adapters";
import { ModelSignInError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { MODEL_KEY_FORMAT_ERROR } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import type { RouterHandler } from "../router-test-support.js";
import {
  appHandler,
  createRouter,
  handle,
  mainRole,
  withModelRoles,
} from "../router-test-support.js";

describe("model credential persistence", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;

  function persistDeps(options?: {
    envDefaultModel?: string;
    deploymentModelConfigured?: boolean;
  }) {
    const upsert = vi.fn(async (_args: unknown) => ({ id: "preference" }));
    const finish = vi.fn();
    // Connect loads any previous credential on the root client before the write transaction.
    const userModelCredential = {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
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
    const userModelPreference = {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert,
    };
    const tx = {
      userModelCredential,
      secret: { create: vi.fn().mockResolvedValue({}) },
      userModelPreference,
    };
    const deps = {
      prisma: {
        userModelCredential,
        userModelPreference,
        deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
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
        deploymentModelConfigured: options?.deploymentModelConfigured ?? false,
      },
    } as unknown as RouterDeps;
    return { upsert, finish, deps, handler: appHandler(deps) };
  }

  /** A sign-in whose provider exchange returned `login`: begin hands over the save, and
   *  finish returns what it saved. */
  async function finishSignIn(
    { deps, finish, handler }: ReturnType<typeof persistDeps>,
    login: Omit<PiOAuthConnected, "signal">,
  ) {
    let persist: PiOAuthPersist<unknown> | undefined;
    Object.assign(deps.oauthLogins, {
      begin: vi.fn(async (input: { persist: PiOAuthPersist<unknown> }) => {
        persist = input.persist;
        return {
          loginId: "login-1",
          provider: login.provider,
          mode: "device-code" as const,
          userCode: "CODE",
          verificationUri: "https://auth.example.com/device",
          expiresInSeconds: 60,
        };
      }),
    });
    await call(handler, "models/beginOAuth", { provider: login.provider });
    const value = await persist?.({ ...login, signal: new AbortController().signal });
    finish.mockResolvedValue({ status: "connected", value, provider: login.provider });
    return call(handler, "models/finishOAuth", { loginId: "login-1" });
  }

  async function call(
    handler: RouterHandler,
    path: string,
    body: unknown,
    as: Actor = actor,
  ): Promise<Response> {
    const response = await handle(
      handler,
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor: as } },
    );
    return response;
  }

  const privateConnect = {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "local-model",
  };

  it("refuses to save a private model endpoint for a user who is not the deployment owner", async () => {
    const { deps, handler } = persistDeps();
    const response = await call(handler, "models/connect", privateConnect, {
      ...actor,
      isDeploymentOwner: false,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: adapters.PRIVATE_MODEL_ENDPOINT_MESSAGE },
    });
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it.each([
    { isDeploymentOwner: true, mcpAllowPrivateEndpoint: true },
    { isDeploymentOwner: false, mcpAllowPrivateEndpoint: true },
  ])("lets a private model endpoint through for %j", async (who) => {
    const { deps, handler } = persistDeps();
    Object.assign(deps.env, { mcpAllowPrivateEndpoint: who.mcpAllowPrivateEndpoint });
    const build = vi.spyOn(adapters, "buildModelConnectPlaintext").mockImplementation(() => {
      throw new Error("stop after validation");
    });
    try {
      await call(handler, "models/connect", privateConnect, {
        ...actor,
        isDeploymentOwner: who.isDeploymentOwner,
      });
      expect(build).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: privateConnect.baseUrl }),
        undefined,
        expect.objectContaining({ allowPrivateEndpoint: true }),
      );
    } finally {
      build.mockRestore();
    }
  });

  it("does not persist a stringified null model id from subscription sign-in", async () => {
    const setup = persistDeps();
    const { upsert } = setup;
    const response = await finishSignIn(setup, {
      provider: "anthropic",
      modelId: "null",
      label: "Anthropic",
      credential: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });
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

  it("updates a saved legacy Azure credential when replacing its key", async () => {
    const { deps, handler } = persistDeps();
    const existing = {
      id: "cred-azure",
      userId: actor.userId,
      provider: "azure-openai-responses",
      label: "Azure",
      secretId: "old-secret",
    };
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...existing,
      ...data,
    }));
    const findFirst = vi.fn(
      async ({ where }: { where: { provider: string | { in: string[] } } }) => {
        const provider = where.provider;
        return provider === existing.provider ||
          (typeof provider !== "string" && provider.in.includes(existing.provider))
          ? existing
          : null;
      },
    );
    Object.assign(deps.prisma.userModelCredential, {
      findFirst,
      update,
      count: vi.fn().mockResolvedValue(0),
    });
    // The fixture shares this client with the write transaction.
    const transaction = deps.prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
    transaction.mockImplementation(async (fn) =>
      fn(
        withModelRoles({
          userModelCredential: deps.prisma.userModelCredential,
          userVoiceCredential: { count: vi.fn().mockResolvedValue(0) },
          userModelPreference: deps.prisma.userModelPreference,
          secret: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "new-secret" }),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        }),
      ),
    );
    Object.assign(deps.prisma, {
      secret: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    const response = await call(handler, "models/connect", {
      provider: "azure",
      apiKey: "fake-replacement-key",
      modelId: "gpt-4o",
    });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: existing.id },
      // An older app's connect replaces the provider's connection and keeps its name.
      data: { secretId: "new-secret" },
    });
    expect(deps.prisma.userModelCredential.create).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      json: { id: existing.id, provider: "azure" },
    });
  });

  it("keeps another connection as the space default when makeDefault is false", async () => {
    const { upsert, deps, handler } = persistDeps();
    const preferences = deps.prisma.userModelPreference as unknown as {
      findFirst: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    // Another connection runs the main model.
    await (
      deps.prisma.userModelRoleChoice as unknown as {
        createMany: (args: { data: unknown[] }) => Promise<unknown>;
      }
    ).createMany({
      data: [mainRole({ userId: actor.userId }, "other-provider", "other-model")],
    });

    const response = await call(handler, "models/connect", {
      provider: "test-provider",
      apiKey: "sk-test-key-123",
      modelId: "fallback-model",
      makeDefault: false,
    });

    expect(response.status).toBe(200);
    expect(preferences.updateMany).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { modelId: "fallback-model", thinkingLevel: null },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ json: { isDefault: false } });
  });

  it("keeps a working deployment model when a fallback connection is added", async () => {
    const { upsert, handler } = persistDeps({ deploymentModelConfigured: true });

    const response = await call(handler, "models/connect", {
      provider: "test-provider",
      apiKey: "sk-test-key-123",
      modelId: "fallback-model",
      makeDefault: false,
    });

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ modelId: "fallback-model" }) }),
    );
    await expect(response.json()).resolves.toMatchObject({ json: { isDefault: false } });
  });

  it("leaves the main model's choice alone when its own connection is saved for another role", async () => {
    const { upsert, handler } = persistDeps({ deploymentModelConfigured: true });
    // This connection already runs chat.
    const chat = await call(handler, "models/connect", {
      provider: "test-provider",
      apiKey: "sk-test-key-123",
      modelId: "chat-model",
      makeDefault: true,
    });
    expect(chat.status).toBe(200);
    upsert.mockClear();

    const response = await call(handler, "models/connect", {
      provider: "test-provider",
      apiKey: "sk-test-key-123",
      modelId: "approval-model",
      makeDefault: false,
    });

    expect(response.status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ json: { isDefault: true } });
  });

  it("changes no model role for a first connection when makeDefault is false", async () => {
    const { upsert, deps, handler } = persistDeps();

    const response = await call(handler, "models/connect", {
      provider: "test-provider",
      apiKey: "sk-test-key-123",
      modelId: "only-model",
      makeDefault: false,
    });

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ modelId: "only-model" }) }),
    );
    const roles = deps.prisma.userModelRoleChoice as unknown as {
      createMany: ReturnType<typeof vi.fn>;
    };
    expect(roles.createMany).not.toHaveBeenCalled();
  });

  it("makes the connection's model the main model when asked, through the role table", async () => {
    const { upsert, deps, handler } = persistDeps();

    const response = await call(handler, "models/connect", {
      provider: "test-provider",
      apiKey: "sk-test-key-123",
      modelId: "only-model",
      makeDefault: true,
    });

    expect(response.status).toBe(200);
    const roles = deps.prisma.userModelRoleChoice as unknown as {
      createMany: ReturnType<typeof vi.fn>;
    };
    expect(roles.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          role: "main",
          position: 0,
          provider: "test-provider",
          modelId: "only-model",
        }),
      ],
    });
    // The connection's own model is the one it connected with.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { modelId: "only-model", thinkingLevel: null } }),
    );
    await expect(response.json()).resolves.toMatchObject({ json: { isDefault: true } });
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

  it.each([401, 403, 503])(
    "rejects an unverified compatible Ollama connection (%i) before saving",
    async (status) => {
      const { deps, handler } = persistDeps();
      const transport = vi.fn<typeof fetch>(async () => new Response(null, { status }));
      Object.assign(deps, { modelConnectionFetch: transport });
      const response = await call(handler, "models/connect", {
        provider: "openai-compatible",
        baseUrl: "https://ollama.com/v1",
        apiKey: "fake-fixture-key",
        modelId: "fixture-model",
      });
      expect(response.status).toBe(400);
      expect(String(transport.mock.calls[0]?.[0])).toBe("https://ollama.com/api/balance");
      expect(deps.secrets.put).not.toHaveBeenCalled();
      expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each(
    ["openrouter", "google", "deepseek"].flatMap((provider) =>
      [401, 403].map((status) => ({ provider, status })),
    ),
  )(
    "rejects a refused $provider replacement ($status) without changing the saved connection",
    async ({ provider, status }) => {
      const { upsert, deps, handler } = persistDeps();
      const saved = {
        id: "credential-fixture",
        userId: actor.userId,
        provider,
        secretId: "secret-fixture",
      };
      vi.mocked(deps.prisma.userModelCredential.findFirst).mockResolvedValue(saved as never);
      Object.assign(deps.prisma, {
        secret: { findFirst: vi.fn().mockResolvedValue({ ciphertext: "fixture-ciphertext" }) },
      });
      Object.assign(deps.secrets, { load: vi.fn().mockResolvedValue("fixture-previous-key") });
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response("private upstream details", { status }),
      );
      vi.stubGlobal("fetch", fetchImpl);
      try {
        const response = await call(handler, "models/connect", {
          provider,
          apiKey: "fixture-replacement-key",
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          json: {
            code: "BAD_REQUEST",
            message: "API key was rejected by the provider.",
          },
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(deps.secrets.put).not.toHaveBeenCalled();
        expect(deps.prisma.$transaction).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    {
      provider: "openrouter",
      url: "https://openrouter.ai/api/v1/key",
      headers: { Authorization: "Bearer fixture-key" },
    },
    {
      provider: "deepseek",
      url: "https://api.deepseek.com/models",
      headers: { Authorization: "Bearer fixture-key" },
    },
    {
      provider: "google",
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      headers: { "x-goog-api-key": "fixture-key" },
    },
  ])(
    "saves a $provider key only after its authentication check succeeds",
    async ({ provider, url, headers }) => {
      const { deps, handler } = persistDeps();
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: {} }));
      vi.stubGlobal("fetch", fetchImpl);
      try {
        const response = await call(handler, "models/connect", {
          provider,
          apiKey: "fixture-key",
        });
        expect(response.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ headers }));
        expect(deps.secrets.put).toHaveBeenCalledWith(
          "fixture-key",
          expect.objectContaining({ userId: actor.userId }),
        );
        expect(fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(deps.secrets.put).mock.invocationCallOrder[0]!,
        );
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

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

  it("checks the chosen model with the new key before saving it", async () => {
    const { deps, handler } = persistDeps();
    const check = vi.fn(async () => {
      throw new Error("Your model provider denied access to this model.");
    });
    Object.assign(deps, { modelConnectionCheck: check });

    const response = await call(handler, "models/connect", {
      provider: "groq",
      apiKey: "fixture-groq-key",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { code: "BAD_REQUEST", message: "Your model provider denied access to this model." },
    });
    // No model chosen: the provider's recommended default is the one checked.
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "groq",
        id: "openai/gpt-oss-120b",
        apiKey: "fixture-groq-key",
      }),
      expect.any(Object),
    );
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it("refuses a pasted key that is not a header-safe token before checking it", async () => {
    const { deps, handler } = persistDeps();
    const check = vi.fn(async () => undefined);
    Object.assign(deps, { modelConnectionCheck: check });

    const response = await call(handler, "models/connect", {
      provider: "deepseek",
      apiKey: "sk-fixture-你好-key",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: MODEL_KEY_FORMAT_ERROR },
    });
    expect(check).not.toHaveBeenCalled();
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it("adds another connection when the save names none, numbering its name", async () => {
    const { deps, handler } = persistDeps();
    const existing = {
      id: "cred-personal",
      userId: actor.userId,
      provider: "anthropic",
      label: "Anthropic",
      secretId: "secret-personal",
    };
    const credentials = deps.prisma.userModelCredential as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    credentials.findFirst!.mockResolvedValue(existing);
    credentials.findMany!.mockResolvedValue([{ label: "Anthropic" }]);
    credentials.update = vi.fn();

    const response = await call(handler, "models/connect", {
      provider: "anthropic",
      apiKey: "sk-test-key-123",
      label: "Anthropic",
      credentialId: null,
      makeDefault: false,
    });

    expect(response.status).toBe(200);
    expect(credentials.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ provider: "anthropic", label: "Anthropic 2" }),
    });
    expect(credentials.update).not.toHaveBeenCalled();
  });

  it("replaces only the connection a save names", async () => {
    const { deps, handler } = persistDeps();
    const work = {
      id: "cred-work",
      userId: actor.userId,
      provider: "anthropic",
      label: "Work",
      secretId: "secret-work",
    };
    const credentials = deps.prisma.userModelCredential as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    credentials.findFirst!.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === work.id ? work : null,
    );
    credentials.update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...work,
      ...data,
    }));
    credentials.count = vi.fn().mockResolvedValue(0);
    Object.assign(deps.prisma, { secret: { findFirst: vi.fn().mockResolvedValue(null) } });
    const transaction = deps.prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
    transaction.mockImplementation(async (fn) =>
      fn(
        withModelRoles({
          userModelCredential: credentials,
          userVoiceCredential: { count: vi.fn().mockResolvedValue(0) },
          userModelPreference: deps.prisma.userModelPreference,
          secret: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "new-secret" }),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        }),
      ),
    );

    const response = await call(handler, "models/connect", {
      provider: "anthropic",
      apiKey: "sk-test-key-123",
      credentialId: work.id,
      makeDefault: false,
    });
    expect(response.status).toBe(200);
    expect(credentials.update).toHaveBeenCalledWith({
      where: { id: work.id },
      data: { secretId: "new-secret" },
    });
    expect(credentials.create).not.toHaveBeenCalled();

    const missing = await call(handler, "models/connect", {
      provider: "anthropic",
      apiKey: "sk-test-key-123",
      credentialId: "cred-removed",
    });
    expect(missing.status).toBe(404);
  });

  it("binds an older app's sign-in to the provider's newest connection when it begins", async () => {
    const { deps, handler } = persistDeps();
    const begin = vi.fn(async () => ({
      loginId: "login-1",
      provider: "openai-codex",
      mode: "auth-url" as const,
      verificationUri: "https://auth.example.com/authorize",
      expiresInSeconds: 60,
    }));
    Object.assign(deps.oauthLogins, { begin });
    const credentials = deps.prisma.userModelCredential as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    credentials.findFirst!.mockResolvedValue({
      id: "cred-newest",
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId: "secret-newest",
    });

    expect((await call(handler, "models/beginOAuth", { provider: "openai-codex" })).status).toBe(
      200,
    );
    expect(begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ credentialId: "cred-newest" }),
    );

    // A new account stays a new account.
    await call(handler, "models/beginOAuth", { provider: "openai-codex", credentialId: null });
    expect(begin).toHaveBeenLastCalledWith(expect.objectContaining({ credentialId: null }));
  });

  it("answers a provider sign-in outage as a retryable 503", async () => {
    const { deps, handler } = persistDeps();
    Object.assign(deps.oauthLogins, {
      begin: vi
        .fn()
        .mockRejectedValue(
          new Error('Device code request failed with status 503: {"error":{"code":503}}'),
        ),
    });
    const response = await call(handler, "models/beginOAuth", { provider: "openai-codex" });
    expect(response.status).toBe(503);
  });

  it("tells the user to restart a pasted-code sign-in that is gone", async () => {
    const { deps, handler } = persistDeps();
    const message = "Sign-in session not found. Start sign-in again.";
    Object.assign(deps.oauthLogins, {
      submit: vi.fn().mockRejectedValue(new ModelSignInError(message)),
    });
    const response = await call(handler, "models/submitOAuthCode", {
      loginId: "login-1",
      code: "pasted-code",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ json: { message } });
  });

  it("names a second subscription account by the email it signed in with", async () => {
    const setup = persistDeps();
    const { deps } = setup;
    const access = `fake.${Buffer.from(
      JSON.stringify({ "https://api.openai.com/profile": { email: "work@example.com" } }),
    ).toString("base64url")}.fake`;
    const response = await finishSignIn(setup, {
      provider: "openai-codex",
      credentialId: null,
      credential: { type: "oauth", access, refresh: "refresh-token", expires: Date.now() + 1 },
    });

    expect(response.status).toBe(200);
    expect(deps.prisma.userModelCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "openai-codex", label: "work@example.com" }),
      }),
    );
  });

  it.each([
    ["github-copilot", "GitHub Copilot"],
    ["openai-codex", "OpenAI Codex"],
    ["anthropic", "Anthropic"],
  ])("labels a %s subscription sign-in with its own provider name", async (provider, label) => {
    const setup = persistDeps();
    const { deps } = setup;
    const response = await finishSignIn(setup, {
      provider,
      credential: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });

    expect(response.status).toBe(200);
    expect(deps.prisma.userModelCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider, label }),
      }),
    );
  });
});

describe("model disconnect", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const connection = (id: string) => ({
    id,
    userId: actor.userId,
    provider: "openai-codex",
    label: id,
    secretId: `${id}-secret`,
  });

  function disconnectDeps() {
    const connections = [connection("personal"), connection("work")];
    const tx = {
      $queryRaw: vi.fn(async () => [{ bypass: null }]),
      userModelRoleChoice: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      spaceModelRoleChoice: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      userModelCredential: {
        findMany: vi.fn(async () => connections),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        count: vi.fn(async () => 0),
      },
      userVoiceCredential: { count: vi.fn(async () => 0) },
      secret: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    };
    const cancelProvider = vi.fn(async () => undefined);
    const deps = {
      prisma: { $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) },
      oauthLogins: { cancelProvider },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        agentRuntime: "pi",
      },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const call = async (body: unknown) =>
      handle(
        handler,
        new Request("http://127.0.0.1/rpc/models/disconnect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: body }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
    return { tx, cancelProvider, call };
  }

  it("removes one connection and its rows, keeping the other account's", async () => {
    const { tx, cancelProvider, call } = disconnectDeps();
    const response = await call({ provider: "openai-codex", credentialId: "work" });
    expect(response.status).toBe(200);
    expect(cancelProvider).toHaveBeenCalledWith({
      userId: actor.userId,
      provider: "openai-codex",
      credentialId: "work",
    });
    const workRows = {
      where: {
        userId: actor.userId,
        provider: "openai-codex",
        OR: [{ credentialId: { in: ["work"] } }],
      },
    };
    // The account's models and every Space's own lose the connection.
    expect(tx.userModelRoleChoice.deleteMany).toHaveBeenCalledWith(workRows);
    expect(tx.spaceModelRoleChoice.deleteMany).toHaveBeenCalledWith(workRows);
    expect(tx.userModelCredential.deleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, id: { in: ["work"] } },
    });
    expect(tx.secret.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "work-secret" },
    });
  });

  it("removes every connection of the provider for an app that names none", async () => {
    const { tx, call } = disconnectDeps();
    expect((await call({ provider: "openai-codex" })).status).toBe(200);
    const providerRows = {
      where: {
        userId: actor.userId,
        provider: "openai-codex",
        OR: [
          { credentialId: { in: ["personal", "work"] } },
          { credentialId: null, creditOfferingId: null },
        ],
      },
    };
    expect(tx.userModelRoleChoice.deleteMany).toHaveBeenCalledWith(providerRows);
    expect(tx.spaceModelRoleChoice.deleteMany).toHaveBeenCalledWith(providerRows);
    expect(tx.userModelCredential.deleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, id: { in: ["personal", "work"] } },
    });
  });
});
