import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import * as adapters from "@rakazo/adapters";
import {
  findConnectedModelCredential,
  listPiCatalog,
  modelCredentialDto,
  parseModelSecret,
  serializeModelSecret,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import {
  appHandler,
  createRouter,
  handle,
  mainRole,
  withModelRoles,
} from "../router-test-support.js";

describe("OpenAI-compatible model probes", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const baseUrl = "https://127.0.0.1:8000/v1";
  const stored = JSON.stringify({ kind: "openai_compatible", baseUrl, apiKey: "fake-saved-key" });

  function fixture(
    options: {
      credentialUserId?: string;
      secretUserId?: string;
      actor?: Actor;
      mcpAllowPrivateEndpoint?: boolean;
    } = {},
  ) {
    const credential = {
      id: "cred-1",
      userId: options.credentialUserId ?? actor.userId,
      provider: "openai-compatible",
      secretId: "secret-1",
    };
    const credentials = [credential];
    const findCredential = vi.fn(
      async ({ where }: { where: { userId: string; provider: string } }) =>
        where.userId === credential.userId && where.provider === credential.provider
          ? credential
          : null,
    );
    const findCredentials = vi.fn(
      async ({ where }: { where: { userId: string; provider: string } }) =>
        credentials.filter(
          (candidate) => candidate.userId === where.userId && candidate.provider === where.provider,
        ),
    );
    const findSecret = vi.fn(
      async ({ where }: { where: { userId: string; id: { in: string[] }; spaceId: null } }) =>
        credentials
          .filter(
            (candidate) =>
              where.userId === (options.secretUserId ?? candidate.userId) &&
              where.id.in.includes(candidate.secretId) &&
              where.spaceId === null,
          )
          .map((candidate) => ({ id: candidate.secretId, ciphertext: "fake-ciphertext" })),
    );
    const load = vi.fn().mockResolvedValue(stored);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ data: [{ id: "test-model" }] }),
    );
    const probe = adapters.probeOpenAiCompatibleModels;
    vi.spyOn(adapters, "probeOpenAiCompatibleModels").mockImplementation((input, _, signal, opts) =>
      probe(input, fetch, signal, opts),
    );
    const deps = {
      prisma: {
        userModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
        userModelCredential: { findFirst: findCredential, findMany: findCredentials },
        secret: { findMany: findSecret },
      },
      secrets: { load },
      modelConnectionFetch: vi.fn(() => {
        throw new Error("Unexpected injected transport");
      }),
      env: {
        sandboxProvider: "fake",
        mcpAllowPrivateEndpoint: options.mcpAllowPrivateEndpoint ?? true,
      },
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), {
      context: { actor: options.actor ?? actor } as never,
    });
    return { client, deps, fetch, credentials, findCredential, findCredentials, findSecret, load };
  }

  afterEach(() => vi.restoreAllMocks());

  /** The answer a client receives, through the app's error translation. */
  const probeOverHttp = (deps: RouterDeps, path: string, body: unknown) =>
    handle(
      appHandler(deps),
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } as never },
    );

  it("tells the member what the server answered when it refuses the probe", async () => {
    const { deps, fetch } = fixture();
    fetch.mockResolvedValue(new Response("no", { status: 401 }));

    const response = await probeOverHttp(deps, "models/probeOpenAiCompatible", { baseUrl });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      json: {
        code: "BAD_REQUEST",
        message: "Model server returned 401. You can still Connect with an explicit model id.",
      },
    });
  });

  it("loads a public preset's models without opening a saved credential", async () => {
    const { client, fetch, findCredentials, load } = fixture();
    const presetUrl = "https://api.concentrate.ai/v1";

    await expect(
      client.models.probeOpenAiCompatible({ baseUrl: presetUrl, credentialId: "cred-1" }),
    ).resolves.toEqual({ models: ["test-model"] });

    expect(findCredentials).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    const request = fetch.mock.calls[0];
    expect(String(request?.[0])).toBe(`${presetUrl}/models`);
    expect(new Headers(request?.[1]?.headers).has("Authorization")).toBe(false);
  });

  it("tells the member the server could not be reached", async () => {
    const { deps, fetch } = fixture();
    fetch.mockRejectedValue(new TypeError("fetch failed"));

    const response = await probeOverHttp(deps, "models/probeOpenAiCompatible", { baseUrl });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      json: { code: "BAD_REQUEST", message: "fetch failed" },
    });
  });

  it("reports a probe that fails for a reason of our own as a server fault", async () => {
    const { deps, fetch } = fixture();
    fetch.mockRejectedValue(new Error("egress proxy pool exhausted"));

    const response = await probeOverHttp(deps, "models/probeOpenAiCompatible", { baseUrl });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("egress proxy");
  });

  it("tells the member a catalog provider rejected the key", async () => {
    const { deps } = fixture();
    deps.modelConnectionFetch = vi.fn(async () => new Response("no", { status: 401 }));

    const response = await probeOverHttp(deps, "models/probeCatalog", {
      provider: "deepseek",
      apiKey: "fake-typed-key",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      json: { code: "BAD_REQUEST", message: "API key was rejected by the provider." },
    });
  });

  it("reports a catalog probe that fails for a reason of our own as a server fault", async () => {
    const { deps } = fixture();
    vi.spyOn(adapters, "probeCatalogProviderModels").mockRejectedValue(
      new Error("catalog registry failed to load"),
    );

    const response = await probeOverHttp(deps, "models/probeCatalog", {
      provider: "deepseek",
      apiKey: "fake-typed-key",
    });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("catalog registry");
  });

  it("does not inject the connection transport into non-Ollama probes", async () => {
    const { client } = fixture();
    await client.models.probeOpenAiCompatible({ baseUrl });
    expect(adapters.probeOpenAiCompatibleModels).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it.each([undefined, "", "   "])("uses the saved key for a blank key %j", async (apiKey) => {
    const { client, fetch, findSecret, load } = fixture();
    const response = await client.models.probeOpenAiCompatible({ baseUrl, apiKey });
    expect(fetch).toHaveBeenCalledWith(
      new URL(`${baseUrl}/models`),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fake-saved-key" }),
      }),
    );
    expect(findSecret).toHaveBeenCalledWith({
      where: { id: { in: ["secret-1"] }, userId: actor.userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    expect(load).toHaveBeenCalledWith("fake-ciphertext", "secret-1");
    expect(response).toEqual({ models: ["test-model"] });
    expect(JSON.stringify(response)).not.toContain("fake-saved-key");
  });

  it("uses explicit key and headers without looking up the stored credential", async () => {
    const { client, fetch, findCredential, findCredentials, findSecret, load } = fixture();
    await client.models.probeOpenAiCompatible({ baseUrl, apiKey: " fake-typed-key ", headers: {} });
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fake-typed-key" }),
      }),
    );
    expect(findCredential).not.toHaveBeenCalled();
    expect(findCredentials).not.toHaveBeenCalled();
    expect(findSecret).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("reuses saved headers for the same endpoint without exposing them", async () => {
    const { client, fetch, load } = fixture();
    load.mockResolvedValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl,
        apiKey: "fake-saved-key",
        headers: { "x-session": "fake-session-secret" },
      }),
    );
    const response = await client.models.probeOpenAiCompatible({ baseUrl });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-session")).toBe(
      "fake-session-secret",
    );
    expect(JSON.stringify(response)).not.toContain("fake-session-secret");
  });

  it("hides the saved key and headers in a failed probe's message", async () => {
    const { client, fetch, load } = fixture();
    load.mockResolvedValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl,
        apiKey: "fake-saved-key",
        headers: { "x-session": "fake-session-secret" },
      }),
    );
    fetch.mockRejectedValue(
      new TypeError(
        'Headers.append: "Bearer fake-saved-key" after fake-session-secret is invalid.',
      ),
    );
    await expect(client.models.probeOpenAiCompatible({ baseUrl })).rejects.toThrow(
      'Headers.append: "Bearer •••" after ••• is invalid.',
    );
  });

  it("sends a saved key with Anthropic headers for the Anthropic Messages protocol", async () => {
    const { client, fetch, load } = fixture();
    load.mockResolvedValue(
      JSON.stringify({ kind: "openai_compatible", baseUrl, apiKey: "fake-saved-key" }),
    );
    const response = await client.models.probeOpenAiCompatible({
      baseUrl,
      apiProtocol: "anthropic-messages",
    });
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("fake-saved-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBeNull();
    expect(response).toEqual({ models: ["test-model"] });
  });

  it("never uses another user's credential id for probe secrets", async () => {
    const { client, fetch, credentials, load } = fixture();
    credentials.push({
      id: "other-credential",
      userId: "other-user",
      provider: "openai-compatible",
      secretId: "other-secret",
    });
    await client.models.probeOpenAiCompatible({ baseUrl, credentialId: "other-credential" });
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-session")).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("takes both saved fields from the selected credential, never another credential", async () => {
    const { client, fetch, credentials, load } = fixture();
    credentials.push({
      id: "cred-2",
      userId: actor.userId,
      provider: "openai-compatible",
      secretId: "secret-2",
    });
    load.mockImplementation(async (_, secretId) =>
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl,
        apiKey: secretId === "secret-2" ? "selected-key" : "other-key",
        headers: secretId === "secret-2" ? {} : { "x-session": "other-session" },
      }),
    );
    await client.models.probeOpenAiCompatible({ baseUrl, credentialId: "cred-2" });
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer selected-key");
    expect(headers.has("x-session")).toBe(false);
    expect(load.mock.calls.map((call) => call[1])).toEqual(["secret-2"]);
  });

  it.each(["different endpoint", "unreadable", "matching endpoint"])(
    "tries the preferred credential first, then another matching credential when preferred is %s",
    async (preferred) => {
      const { client, fetch, credentials, findCredentials, findSecret, load } = fixture();
      credentials.push({
        id: "cred-2",
        userId: actor.userId,
        provider: "openai-compatible",
        secretId: "secret-2",
      });
      load.mockImplementation(async (_, secretId) => {
        if (secretId === "secret-2") return stored;
        if (preferred === "unreadable") throw new Error("Secret unavailable");
        return JSON.stringify({
          kind: "openai_compatible",
          baseUrl: preferred === "matching endpoint" ? baseUrl : "https://127.0.0.2:8000/v1",
          apiKey: "fake-preferred-key",
        });
      });

      await client.models.probeOpenAiCompatible({ baseUrl });

      expect(findCredentials).toHaveBeenCalledWith({
        where: { userId: actor.userId, provider: "openai-compatible" },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });
      expect(findSecret).toHaveBeenCalledExactlyOnceWith({
        where: { id: { in: ["secret-1", "secret-2"] }, userId: actor.userId, spaceId: null },
        select: { id: true, ciphertext: true },
      });
      expect(fetch.mock.calls[0]?.[1]?.headers).toHaveProperty(
        "Authorization",
        preferred === "matching endpoint" ? "Bearer fake-preferred-key" : "Bearer fake-saved-key",
      );
      expect(load.mock.calls.map((call) => call[1])).toEqual(
        preferred === "matching endpoint" ? ["secret-1"] : ["secret-1", "secret-2"],
      );
    },
  );

  it("never uses another user's matching credential after the preferred endpoint differs", async () => {
    const { client, fetch, credentials, findSecret, load } = fixture();
    credentials.push({
      id: "cred-other",
      userId: "other-user",
      provider: "openai-compatible",
      secretId: "secret-other",
    });
    load.mockImplementation(async (_, secretId) =>
      secretId === "secret-other"
        ? stored
        : JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://127.0.0.2:8000/v1",
            apiKey: "fake-preferred-key",
          }),
    );

    await client.models.probeOpenAiCompatible({ baseUrl });

    expect(findSecret).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ["secret-1"] }, userId: actor.userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    expect(load).toHaveBeenCalledExactlyOnceWith("fake-ciphertext", "secret-1");
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  });

  it("does not send the saved key to a different endpoint", async () => {
    const { client, fetch } = fixture();
    await client.models.probeOpenAiCompatible({ baseUrl: "https://127.0.0.2:8000/v1" });
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  });

  it.each([{ credentialUserId: "other-user" }, { secretUserId: "other-user" }])(
    "does not load another user's credential or secret: %j",
    async (options) => {
      const { client, fetch, findCredential, load } = fixture(options);
      await client.models.probeOpenAiCompatible({ baseUrl });
      expect(findCredential).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: actor.userId, provider: "openai-compatible" } }),
      );
      expect(load).not.toHaveBeenCalled();
      expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    },
  );

  it.each(["unavailable", "corrupt"])(
    "falls back when the stored secret is %s",
    async (failure) => {
      const { client, fetch, load } = fixture();
      if (failure === "unavailable") load.mockRejectedValue(new Error("Secret unavailable"));
      else load.mockResolvedValue('{"kind":"openai_compatible"}');
      await expect(client.models.probeOpenAiCompatible({ baseUrl })).resolves.toEqual({
        models: ["test-model"],
      });
      expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    },
  );

  it("refuses a private endpoint probe from a user who is not the deployment owner", async () => {
    const { client, fetch } = fixture({
      actor: { ...actor, isDeploymentOwner: true },
      mcpAllowPrivateEndpoint: false,
    });
    await expect(
      client.models.probeOpenAiCompatible({ baseUrl, apiKey: "fake-typed-key" }),
    ).rejects.toThrow(adapters.PRIVATE_MODEL_ENDPOINT_MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("probes a private endpoint for any user when the instance flag allows it", async () => {
    const { client, fetch } = fixture({
      actor: { ...actor, isDeploymentOwner: false },
      mcpAllowPrivateEndpoint: true,
    });
    await expect(
      client.models.probeOpenAiCompatible({ baseUrl, apiKey: "fake-typed-key" }),
    ).resolves.toEqual({ models: ["test-model"] });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("still rejects saved keys on public HTTP endpoints", async () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
    try {
      const { client, fetch, load } = fixture();
      const baseUrl = "http://example.invalid/v1";
      load.mockResolvedValue(
        JSON.stringify({ kind: "openai_compatible", baseUrl, apiKey: "fake-saved-key" }),
      );
      await expect(client.models.probeOpenAiCompatible({ baseUrl })).rejects.toThrow(/HTTPS/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("openai-compatible enabled models", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const compatible = "openai-compatible";
  const baseUrl = "https://10.0.0.5:8443/v1";
  const catalogId = listPiCatalog().find((entry) => entry.provider === compatible)!.id;
  /** A pin row; space and user default to the actor's. */
  type Pin = {
    name: string;
    modelId: string;
    archived?: boolean;
    spaceId?: string;
    userId?: string;
    role?: string;
    position?: number;
  };
  type PinWhere = {
    spaceId?: string;
    archivedAt?: null;
    bot?: { archivedAt: null };
    userId?: string;
    modelProvider?: string;
    provider?: string;
    modelId?: string | { notIn?: string[] };
  };

  function secretText(enabledModelIds?: string[], reasoning?: boolean) {
    return serializeModelSecret({
      kind: "openai_compatible",
      baseUrl,
      apiKey: "sk-fake-compatible-key",
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(enabledModelIds ? { enabledModelIds } : {}),
    });
  }

  /** Applies the subset of a Prisma pin `where` the router uses. */
  function matching(pins: Pin[] | undefined, where: PinWhere) {
    return (pins ?? [])
      .map((pin) => ({ spaceId: actor.spaceId, userId: actor.userId, ...pin }))
      .filter(
        (pin) =>
          (where.modelProvider ?? where.provider) === compatible &&
          (where.spaceId === undefined || pin.spaceId === where.spaceId) &&
          (where.userId === undefined || pin.userId === where.userId) &&
          !((where.archivedAt === null || where.bot?.archivedAt === null) && pin.archived) &&
          (typeof where.modelId === "string"
            ? pin.modelId === where.modelId
            : !where.modelId?.notIn?.includes(pin.modelId)),
      )
      .map(({ name, spaceId, modelId, role, position }) => ({
        name,
        spaceId,
        modelId,
        role,
        position,
      }));
  }

  function pinStores(options: {
    bots?: Pin[];
    routines?: Pin[];
    backups?: string[];
    roleChoices?: string[];
    mainPrimary?: string;
  }) {
    // The main model and its fallbacks are role choices too.
    const roleChoices = [
      ...(options.mainPrimary
        ? [{ name: "", modelId: options.mainPrimary, role: "main", position: 0 }]
        : []),
      ...(options.backups ?? []).map((modelId, index) => ({
        name: "",
        modelId,
        role: "main",
        position: index + 1,
      })),
      ...(options.roleChoices ?? []).map((modelId) => ({
        name: "",
        modelId,
        role: "approval",
        position: 0,
      })),
    ];
    return {
      bots: (where: PinWhere) => matching(options.bots, where),
      routine: {
        findMany: vi.fn(async ({ where }: { where: PinWhere }) =>
          matching(options.routines, where),
        ),
      },
      // The account's models; no Space overrides them.
      userModelRoleChoice: {
        findMany: vi.fn(async ({ where }: { where: PinWhere }) => matching(roleChoices, where)),
      },
      spaceModelRoleChoice: { findMany: vi.fn(async () => []) },
    };
  }

  function botRow(modelId: string) {
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
      modelProvider: compatible,
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

  function preferenceStore(state: {
    credential: Record<string, unknown>;
    preference: Record<string, unknown>;
  }) {
    const withCredential = (): Record<string, unknown> => ({
      ...state.preference,
      credential: state.credential,
    });
    type PreferenceWhere = {
      isDefault?: boolean;
      modelId?: string;
      credential?: { provider?: string };
    };
    return {
      findMany: vi.fn(async ({ where }: { where: PreferenceWhere }) =>
        where.credential?.provider && where.credential.provider !== compatible
          ? []
          : [withCredential()],
      ),
      findFirst: vi.fn(async ({ where }: { where: PreferenceWhere }) => {
        const preference = withCredential();
        if (where.modelId !== undefined && where.modelId !== preference.modelId) return null;
        if (where.credential?.provider && where.credential.provider !== compatible) return null;
        return preference;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) =>
        Object.assign(state.preference, update),
      ),
    };
  }

  function fixture(options: {
    /** Stored plaintext; null makes the stored ciphertext unreadable. */
    plaintext: string | null;
    alternatePlaintext?: string;
    defaultModel: string;
    thinkingLevel?: string;
    /** Another provider runs the main model, so the compatible default is not it. */
    mainElsewhere?: boolean;
    botModelId?: string;
    bots?: Pin[];
    routines?: Pin[];
    backups?: string[];
    roleChoices?: string[];
    mainPrimary?: string;
  }) {
    const state = {
      credential: {
        id: "cred-compat",
        userId: actor.userId,
        provider: compatible,
        label: "Compatible",
        secretId: "secret-compat",
        supportsImages: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      } as Record<string, unknown>,
      preference: {
        userId: actor.userId,
        credentialId: "cred-compat",
        modelId: options.defaultModel,
        thinkingLevel: options.thinkingLevel ?? null,
        updatedAt: new Date(0),
      } as Record<string, unknown>,
    };
    const alternate = { ...state.credential, id: "cred-alternate", secretId: "secret-alternate" };
    const initialCredential = { ...state.credential };
    const ciphertexts = new Map([["secret-compat", "cipher-compat"]]);
    const plaintexts = new Map<string, string>();
    if (options.plaintext !== null) plaintexts.set("cipher-compat", options.plaintext);
    if (options.alternatePlaintext) {
      ciphertexts.set("secret-alternate", "cipher-alternate");
      plaintexts.set("cipher-alternate", options.alternatePlaintext);
    }
    const pins = pinStores(options);
    const bot = botRow(options.botModelId ?? options.defaultModel);
    const prisma = {
      ...pins,
      $queryRaw: vi.fn(async () => []),
      bot: {
        findFirst: vi.fn(async () => bot),
        findMany: vi.fn(async ({ where }: { where: PinWhere }) =>
          where.modelProvider ? pins.bots(where) : [bot],
        ),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
          Object.assign(
            bot,
            Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
          ),
        ),
      },
      userModelPreference: preferenceStore(state),
      userModelCredential: {
        findMany: vi.fn(async ({ where }: { where: { provider?: string } }) =>
          where.provider === compatible
            ? [state.credential, ...(options.alternatePlaintext ? [alternate] : [])]
            : [],
        ),
        findFirst: vi.fn(async ({ where }: { where: { provider?: string | { in: string[] } } }) =>
          (
            typeof where.provider === "string"
              ? where.provider === compatible
              : where.provider?.in.includes(compatible)
          )
            ? state.credential
            : null,
        ),
        create: vi.fn(),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
          Object.assign(state.credential, data),
        ),
        count: vi.fn(async () => 0),
      },
      userVoiceCredential: { count: vi.fn(async () => 0) },
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
          const ciphertext = ciphertexts.get(where.id);
          return ciphertext ? { id: where.id, ciphertext } : null;
        }),
        create: vi.fn(async ({ data }: { data: { id: string; ciphertext: string } }) => {
          ciphertexts.set(data.id, data.ciphertext);
          return data;
        }),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      user: {
        findUniqueOrThrow: vi.fn(async () => ({
          email: actor.email,
          name: "User",
          avatarStyle: "organic",
          secrets: [],
        })),
      },
      $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(prisma)),
    };
    const secrets = {
      load: vi.fn(async (ciphertext: string) => {
        const plaintext = plaintexts.get(ciphertext);
        if (plaintext === undefined) throw new Error("fixture ciphertext is unreadable");
        return plaintext;
      }),
      put: vi.fn(async (plaintext: string) => {
        plaintexts.set("cipher-new", plaintext);
        return { id: "secret-new", ciphertext: "cipher-new" };
      }),
    };
    withModelRoles(
      prisma,
      options.mainElsewhere
        ? []
        : [mainRole(actor, compatible, options.defaultModel, options.thinkingLevel)],
    );
    const handler = new RPCHandler(
      createRouter({
        prisma,
        secrets,
        events: { notify: vi.fn().mockResolvedValue(undefined) },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
          agentRuntime: "pi",
          mcpAllowPrivateEndpoint: true,
        },
      } as unknown as RouterDeps),
    );
    const call = async (path: string, body: unknown) => {
      const response = await handle(
        handler,
        new Request(`http://127.0.0.1/rpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: body }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      const payload = (await response.json()) as { json: { message?: string } };
      return { status: response.status, message: payload.json.message };
    };
    const enabledInDto = () =>
      modelCredentialDto(
        { ...state.credential, defaultModel: state.preference.modelId } as never,
        options.plaintext ?? "",
      ).enabledModelIds;
    return { state, initialCredential, prisma, secrets, call, enabledInDto };
  }

  const refusal = (names: string) => `In use by ${names}. Pick another model for them first.`;

  it.each([
    ["bot", { bots: [{ name: "Ada", modelId: "m-b" }] }, "Ada"],
    ["routine", { routines: [{ name: "Nightly digest", modelId: "m-b" }] }, "Nightly digest"],
    ["backup", { backups: ["m-b"] }, "backup models"],
    ["approval model", { roleChoices: ["m-b"] }, "backup models"],
  ])("refuses a shrunk list while a %s pins the removed id", async (_kind, pins, names) => {
    const { call, secrets, state, initialCredential, prisma } = fixture({
      plaintext: secretText(["m-a", "m-b"]),
      defaultModel: "m-a",
      ...pins,
    });

    const result = await call("models/connect", {
      provider: compatible,
      baseUrl,
      modelId: "m-a",
      enabledModelIds: ["m-a"],
    });

    expect(result).toEqual({ status: 400, message: refusal(names) });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(prisma.userModelCredential.update).not.toHaveBeenCalled();
    expect(prisma.userModelCredential.create).not.toHaveBeenCalled();
    expect(state.credential).toEqual(initialCredential);
  });

  it.each(["bot", "routine", "backup"])(
    "keeps a working %s on another connection when saving this one",
    async (kind) => {
      const { call } = fixture({
        plaintext: secretText(["m-a"]),
        alternatePlaintext: secretText(["m-b"]),
        defaultModel: "m-a",
        bots: kind === "bot" ? [{ name: "Ada", modelId: "m-b" }] : [],
        routines: kind === "routine" ? [{ name: "Digest", modelId: "m-b" }] : [],
        backups: kind === "backup" ? ["m-b"] : [],
      });
      expect(
        (
          await call("models/connect", {
            provider: compatible,
            baseUrl,
            modelId: "m-a",
            enabledModelIds: ["m-a"],
          })
        ).status,
      ).toBe(200);
    },
  );

  it("does not let an archived bot pinned on a removed id block the save", async () => {
    const { call, secrets } = fixture({
      plaintext: secretText(["m-a", "m-b"]),
      defaultModel: "m-a",
      bots: [{ name: "Ada", modelId: "m-b", archived: true }],
    });

    const result = await call("models/connect", {
      provider: compatible,
      baseUrl,
      modelId: "m-a",
      enabledModelIds: ["m-a"],
    });

    expect(result.status).toBe(200);
    expect(secrets.put).toHaveBeenCalledOnce();
  });

  it.each(["models/connect", "models/setDefault"])(
    "ignores pins from routines on archived bots in %s",
    async (route) => {
      const { call } = fixture({
        plaintext: route === "models/setDefault" ? secretText() : secretText(["m-a", "m-b"]),
        defaultModel: "m-a",
        routines: [{ name: "Paused routine", modelId: "m-a", archived: true }],
      });
      const result = await call(route, {
        provider: compatible,
        baseUrl,
        modelId: "m-b",
        enabledModelIds: ["m-b"],
      });
      expect(result.status).toBe(200);
    },
  );

  it("ignores another user's bot in the same space", async () => {
    const { call } = fixture({
      plaintext: secretText(["m-a", "m-b"]),
      defaultModel: "m-a",
      bots: [{ name: "Teammate bot", modelId: "m-b", userId: "user-2" }],
    });

    const result = await call("models/connect", {
      provider: compatible,
      baseUrl,
      modelId: "m-a",
      enabledModelIds: ["m-a"],
    });

    expect(result.status).toBe(200);
  });

  it("refuses when the actor's bot in another space pins a removed id", async () => {
    const { call, secrets } = fixture({
      plaintext: secretText(["m-a", "m-b"]),
      defaultModel: "m-a",
      bots: [{ name: "Elsewhere", modelId: "m-b", spaceId: "space-2" }],
    });

    const result = await call("models/connect", {
      provider: compatible,
      baseUrl,
      modelId: "m-a",
      enabledModelIds: ["m-a"],
    });

    expect(result).toEqual({ status: 400, message: refusal("Elsewhere") });
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it("keeps a thinking level on a newly enabled default judged by the saved secret", async () => {
    const { call, prisma } = fixture({
      plaintext: null,
      defaultModel: "m-z",
      thinkingLevel: "high",
    });

    const result = await call("models/connect", {
      provider: compatible,
      baseUrl,
      apiKey: "sk-fake-replacement-key",
      modelId: "m-z",
      enabledModelIds: ["m-z"],
      makeDefault: true,
      reasoning: true,
      thinkingLevel: "high",
    });

    expect(result.status).toBe(200);
    expect(prisma.userModelPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ modelId: "m-z", thinkingLevel: "high" }),
      }),
    );
  });

  it("refuses an old client's key replacement over an unreadable secret that would drop a pin", async () => {
    const { call, secrets, state, initialCredential } = fixture({
      plaintext: null,
      defaultModel: "m-a",
      bots: [{ name: "Ada", modelId: "m-b" }],
    });

    const result = await call("models/connect", {
      provider: compatible,
      baseUrl,
      apiKey: "sk-fake-replacement-key",
      modelId: "m-a",
    });

    expect(result).toEqual({ status: 400, message: refusal("Ada") });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(state.credential).toEqual(initialCredential);
  });

  it("accepts the same key replacement when the client lists the pinned id", async () => {
    const { call, secrets } = fixture({
      plaintext: null,
      defaultModel: "m-a",
      bots: [{ name: "Ada", modelId: "m-b" }],
    });

    const result = await call("models/connect", {
      provider: compatible,
      baseUrl,
      apiKey: "sk-fake-replacement-key",
      modelId: "m-a",
      enabledModelIds: ["m-b"],
    });

    expect(result.status).toBe(200);
    expect(secrets.put).toHaveBeenCalledOnce();
  });

  it("refuses disabling a catalog placeholder that a bot pins", async () => {
    const { call } = fixture({
      plaintext: secretText(["m-a"]),
      defaultModel: "m-a",
      bots: [{ name: "Ada", modelId: catalogId }],
    });

    const result = await call("models/connect", {
      provider: compatible,
      baseUrl,
      modelId: "m-a",
      enabledModelIds: ["m-a"],
    });

    expect(result).toEqual({ status: 400, message: refusal("Ada") });
  });

  it("refuses an old client's default change while a bot pins the old default", async () => {
    const { call, secrets } = fixture({
      plaintext: secretText(),
      defaultModel: "m-a",
      bots: [{ name: "Ada", modelId: "m-a" }],
    });

    const result = await call("models/connect", { provider: compatible, baseUrl, modelId: "m-c" });

    expect(result).toEqual({ status: 400, message: refusal("Ada") });
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it("stores the new list with the default included when nothing pins a dropped id", async () => {
    const { call, secrets } = fixture({
      plaintext: secretText(["m-a", "m-c"]),
      defaultModel: "m-a",
    });

    const result = await call("models/connect", {
      provider: compatible,
      baseUrl,
      modelId: "m-a",
      enabledModelIds: ["m-b"],
    });

    expect(result.status).toBe(200);
    const saved = parseModelSecret(secrets.put.mock.calls[0]![0]);
    expect(saved).toMatchObject({ kind: "openai_compatible", enabledModelIds: ["m-a", "m-b"] });
  });

  it.each([secretText(["m-a"], false), secretText()])(
    "sets the default on the connection enabling the model, preserving its reasoning (%s)",
    async (plaintext) => {
      const { call, prisma } = fixture({
        plaintext,
        bots: [{ name: "Ada", modelId: "m-a" }],
        alternatePlaintext: secretText(["m-b"], true),
        defaultModel: "m-a",
      });
      expect(
        (
          await call("models/setDefault", {
            provider: compatible,
            modelId: "m-b",
            thinkingLevel: "high",
          })
        ).status,
      ).toBe(200);
      expect(prisma.userModelPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_credentialId: {
              userId: actor.userId,
              credentialId: "cred-alternate",
            },
          },
          update: expect.objectContaining({ modelId: "m-b", thinkingLevel: "high" }),
        }),
      );
    },
  );

  it("lets the main model leave an implicit compatible default it alone uses", async () => {
    const { call } = fixture({
      plaintext: secretText(),
      defaultModel: "m-a",
      mainPrimary: "m-a",
    });
    expect((await call("models/setDefault", { provider: compatible, modelId: "m-b" })).status).toBe(
      200,
    );
  });

  it("refuses leaving an implicit compatible default another purpose still uses", async () => {
    const { call } = fixture({
      plaintext: secretText(),
      defaultModel: "m-a",
      mainPrimary: "m-a",
      roleChoices: ["m-a"],
    });
    expect(await call("models/setDefault", { provider: compatible, modelId: "m-b" })).toEqual({
      status: 400,
      message: refusal("backup models"),
    });
  });

  it("refuses setDefault to an id outside a listed secret", async () => {
    const { call, prisma } = fixture({
      plaintext: secretText(["m-a", "m-b"]),
      defaultModel: "m-a",
    });

    const result = await call("models/setDefault", { provider: compatible, modelId: "m-z" });

    expect(result).toEqual({ status: 400, message: "Unknown model for that provider" });
    expect(prisma.userModelPreference.upsert).not.toHaveBeenCalled();
  });

  it("switches A to B to A within the list while a bot pins B", async () => {
    const { call, state, enabledInDto } = fixture({
      plaintext: secretText(["m-a", "m-b"]),
      defaultModel: "m-a",
      bots: [{ name: "Ada", modelId: "m-b" }],
    });

    expect((await call("models/setDefault", { provider: compatible, modelId: "m-b" })).status).toBe(
      200,
    );
    expect(state.preference.modelId).toBe("m-b");
    expect((await call("models/setDefault", { provider: compatible, modelId: "m-a" })).status).toBe(
      200,
    );
    expect(state.preference.modelId).toBe("m-a");
    expect(enabledInDto()).toContain("m-b");
  });

  it.each([
    ["a same-space bot on another non-default id", { name: "Ada", modelId: "m-z" }],
    ["a bot in another space", { name: "Elsewhere", modelId: "m-w", spaceId: "space-2" }],
  ])("lets setDefault on a legacy secret ignore %s", async (_case, bot) => {
    const { call, state } = fixture({
      plaintext: secretText(),
      defaultModel: "m-a",
      bots: [bot],
    });

    const result = await call("models/setDefault", { provider: compatible, modelId: "m-x" });

    expect(result.status).toBe(200);
    expect(state.preference.modelId).toBe("m-x");
  });

  it("refuses setDefault on a legacy secret while another space's bot runs the outgoing default", async () => {
    // The connection's own model is the account's, so every Space loses the outgoing one.
    const { call, state } = fixture({
      plaintext: secretText(),
      defaultModel: "m-a",
      bots: [{ name: "Far", modelId: "m-a", spaceId: "space-2" }],
    });

    const result = await call("models/setDefault", { provider: compatible, modelId: "m-x" });

    expect(result).toEqual({ status: 400, message: refusal("Far") });
    expect(state.preference.modelId).toBe("m-a");
  });

  it("skips the pin check when the outgoing default stays in the stored list", async () => {
    const { call, prisma } = fixture({
      plaintext: secretText(["m-a", "m-x"]),
      defaultModel: "m-a",
      bots: [{ name: "Ada", modelId: "m-a" }],
    });

    const result = await call("models/setDefault", { provider: compatible, modelId: "m-x" });

    expect(result.status).toBe(200);
    expect(prisma.routine.findMany).not.toHaveBeenCalled();
  });

  it("refuses setDefault on a legacy secret away from a pinned default", async () => {
    const { call, prisma } = fixture({
      plaintext: secretText(),
      defaultModel: "m-a",
      bots: [{ name: "Ada", modelId: "m-a" }],
    });

    const result = await call("models/setDefault", { provider: compatible, modelId: "m-b" });

    expect(result).toEqual({ status: 400, message: refusal("Ada") });
    expect(prisma.userModelPreference.upsert).not.toHaveBeenCalled();
  });

  it("refuses setDefault away from a union-only default that a bot pins", async () => {
    const { call } = fixture({
      plaintext: secretText(["m-x"]),
      defaultModel: "m-y",
      bots: [{ name: "Ada", modelId: "m-y" }],
    });

    const result = await call("models/setDefault", { provider: compatible, modelId: "m-x" });

    expect(result).toEqual({ status: 400, message: refusal("Ada") });
  });

  it("re-activates a union-only compatible default while another provider is the space default", async () => {
    const { call, state } = fixture({
      plaintext: secretText(["m-x"]),
      defaultModel: "m-y",
      mainElsewhere: true,
    });

    const result = await call("models/setDefault", { provider: compatible, modelId: "m-y" });

    expect(result.status).toBe(200);
    expect(state.preference).toMatchObject({ modelId: "m-y" });
  });

  it("keeps two bots on an enabled connection after successive saves and a failed save", async () => {
    const { call, prisma, secrets, state } = fixture({
      plaintext: secretText(),
      alternatePlaintext: secretText(["Y", "Z"], true),
      defaultModel: "X",
    });
    const bots = [botRow("X"), { ...botRow("X"), id: "bot-2" }];
    prisma.bot.findFirst.mockImplementation(async (...args: unknown[]) => {
      const { where } = args[0] as { where: { id: string } };
      return bots.find((bot) => bot.id === where.id)!;
    });
    prisma.bot.findMany.mockImplementation(async () => bots);
    prisma.bot.update.mockImplementation(async (...args: unknown[]) => {
      const { where, data } = args[0] as { where: { id: string }; data: Record<string, unknown> };
      return Object.assign(
        bots.find((bot) => bot.id === where.id)!,
        Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
      );
    });
    const assertRouting = async () => {
      for (const bot of bots.filter((bot) => bot.modelId !== "X")) {
        await expect(
          findConnectedModelCredential(
            prisma as unknown as PrismaClient,
            secrets,
            actor,
            compatible,
            bot.modelId,
          ),
        ).resolves.toMatchObject({ id: "cred-alternate" });
      }
      expect(state.preference).toMatchObject({ modelId: "X" });
      expect(prisma.userModelPreference.upsert).not.toHaveBeenCalled();
    };
    for (const [botId, modelId] of [
      ["bot-1", "Y"],
      ["bot-2", "Z"],
      ["bot-1", "Y"],
    ]) {
      expect(
        (
          await call("bots/update", {
            botId,
            modelProvider: compatible,
            modelId,
            thinkingLevel: "high",
          })
        ).status,
      ).toBe(200);
      await assertRouting();
    }
    prisma.bot.update.mockRejectedValueOnce(new Error("save aborted"));
    expect(
      (await call("bots/update", { botId: "bot-2", modelProvider: compatible, modelId: "Y" }))
        .status,
    ).toBe(500);
    expect(bots.map((bot) => bot.modelId)).toEqual(["Y", "Z"]);
    await assertRouting();
    expect(
      (await call("bots/update", { botId: "bot-2", modelProvider: compatible, modelId: "Z" }))
        .status,
    ).toBe(200);
    await assertRouting();
  });

  it("saves a bot thinking level on a non-default enabled id when the endpoint reasons", async () => {
    const { call, prisma } = fixture({
      plaintext: secretText(["m-a", "m-b"], true),
      defaultModel: "m-a",
    });

    const result = await call("bots/update", {
      botId: "bot-1",
      modelProvider: compatible,
      modelId: "m-b",
      thinkingLevel: "high",
    });

    expect(result.status).toBe(200);
    expect(prisma.bot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ modelId: "m-b", thinkingLevel: "high" }),
      }),
    );
  });

  it("keeps a non-reasoning endpoint's bots at thinking off", async () => {
    const { call, prisma } = fixture({
      plaintext: secretText(["m-a", "m-b"], false),
      defaultModel: "m-a",
    });

    const result = await call("bots/update", {
      botId: "bot-1",
      modelProvider: compatible,
      modelId: "m-b",
      thinkingLevel: "high",
    });

    expect(result).toEqual({ status: 400, message: "Thinking level must be one of: off" });
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("saves a bot on this space's default when another space wrote the list", async () => {
    const { call } = fixture({
      plaintext: secretText(["m-x"], true),
      defaultModel: "m-y",
      botModelId: "m-x",
    });

    const result = await call("bots/update", {
      botId: "bot-1",
      modelProvider: compatible,
      modelId: "m-y",
      thinkingLevel: "high",
    });

    expect(result.status).toBe(200);
  });

  it("accepts a bot on a listed id that is not the default and refuses an unlisted one", async () => {
    const { call } = fixture({ plaintext: secretText(["m-x"]), defaultModel: "m-y" });

    expect(
      (await call("bots/update", { botId: "bot-1", modelProvider: compatible, modelId: "m-x" }))
        .status,
    ).toBe(200);
    expect(
      await call("bots/update", { botId: "bot-1", modelProvider: compatible, modelId: "m-z" }),
    ).toEqual({ status: 400, message: "Unknown model for that provider" });
  });
});
