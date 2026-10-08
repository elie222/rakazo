import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  defaultCatalogModelId,
  inboundRoutineModelPin,
  modelCredentialAuthKindsForSpace,
  pinnedModelCredentialError,
  readStoredModelAuth,
  routineRunModelPin,
  runModelChoice,
  selectConfiguredModel,
  selectDefaultCredentialId,
  validateConnectedModelChoice,
  validateModelAuthAvailability,
} from "./model-selection.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";

type SelectionInput = Parameters<typeof selectConfiguredModel>[0];

function credential(
  provider: string,
  defaultModel: string | null,
  thinkingLevel: string | null = null,
) {
  return {
    id: `credential-${provider}`,
    userId: "user-1",
    provider,
    label: provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
    defaultModel,
    thinkingLevel,
  };
}

const spaceCredential = credential("space-provider", "space-model");
const overrideCredential = credential("bot-provider", "stored-model");
const bot = { modelProvider: "bot-provider", modelId: "bot-model", thinkingLevel: "high" };
const defaults: SelectionInput = {
  override: null,
  overrideCredential: null,
  defaultCredential: spaceCredential,
  settings: { defaultModelProvider: "settings-provider", defaultModelId: "settings-model" },
  deployment: { provider: "deployment-provider", model: "deployment-model" },
};

describe("configured model selection", () => {
  it.each<{
    name: string;
    input: Partial<SelectionInput>;
    expected: ReturnType<typeof selectConfiguredModel>;
  }>([
    {
      name: "uses the bot's model with its own credential",
      input: { override: bot, overrideCredential },
      expected: {
        provider: "bot-provider",
        id: "bot-model",
        credential: overrideCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "drops override thinking when its provider has no credential",
      input: { override: bot },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: null,
      },
    },
    {
      name: "keeps bot thinking with the Space default",
      input: { override: { modelProvider: null, modelId: null, thinkingLevel: "high" } },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "does not select an incomplete bot override",
      input: { override: { ...bot, modelId: null }, overrideCredential },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "uses settings before deployment defaults without inventing a credential",
      input: { defaultCredential: null },
      expected: {
        provider: "settings-provider",
        id: "settings-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "uses deployment defaults when no stored configuration exists",
      input: { defaultCredential: null, settings: null },
      expected: {
        provider: "deployment-provider",
        id: "deployment-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "leaves missing configuration for the caller's runtime fallback or failure path",
      input: { defaultCredential: null, settings: null, deployment: null },
      expected: {
        provider: undefined,
        id: null,
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "skips a literal null model id and uses the provider catalog instead",
      input: {
        defaultCredential: credential("anthropic", "null"),
        settings: null,
        deployment: null,
      },
      expected: {
        provider: "anthropic",
        id: defaultCatalogModelId("anthropic"),
        credential: credential("anthropic", "null"),
        thinkingLevel: null,
      },
    },
    {
      name: "applies the preference thinking level to the space default model",
      input: { defaultCredential: credential("space-provider", "space-model", "low") },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: credential("space-provider", "space-model", "low"),
        thinkingLevel: "low",
      },
    },
    {
      name: "bot override thinking beats the preference level",
      input: {
        override: { modelProvider: null, modelId: null, thinkingLevel: "high" },
        defaultCredential: credential("space-provider", "space-model", "low"),
      },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: credential("space-provider", "space-model", "low"),
        thinkingLevel: "high",
      },
    },
    {
      name: "does not leak a preference level onto a different override model",
      input: {
        override: { modelProvider: "bot-provider", modelId: "other-model", thinkingLevel: null },
        overrideCredential: credential("bot-provider", "stored-model", "xhigh"),
      },
      expected: {
        provider: "bot-provider",
        id: "other-model",
        credential: credential("bot-provider", "stored-model", "xhigh"),
        thinkingLevel: null,
      },
    },
    {
      name: "does not treat a sentinel bot override as a selected model",
      input: { override: { ...bot, modelId: "null" }, overrideCredential },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "inherits the preference level when the override names its model",
      input: {
        override: { modelProvider: "bot-provider", modelId: "stored-model", thinkingLevel: null },
        overrideCredential: credential("bot-provider", "stored-model", "xhigh"),
      },
      expected: {
        provider: "bot-provider",
        id: "stored-model",
        credential: credential("bot-provider", "stored-model", "xhigh"),
        thinkingLevel: "xhigh",
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(selectConfiguredModel({ ...defaults, ...input })).toEqual(expected);
  });
});

describe("routine model pin", () => {
  const routine = {
    modelProvider: "routine-provider",
    modelId: "routine-model",
    thinkingLevel: "low",
  };

  it("pins the routine's own model onto its run", () => {
    expect(routineRunModelPin(routine)).toEqual({
      modelProvider: "routine-provider",
      modelId: "routine-model",
      thinkingLevel: "low",
      modelPinned: true,
    });
  });

  it("pins nothing when the routine follows the bot", () => {
    expect(routineRunModelPin({ modelProvider: null, modelId: null, thinkingLevel: null })).toEqual(
      {},
    );
    expect(
      routineRunModelPin({ modelProvider: "routine-provider", modelId: null, thinkingLevel: null }),
    ).toEqual({});
  });

  it("runs a routine turn on the model pinned to its run", () => {
    const choice = runModelChoice({ modelPinned: true, ...routine }, bot);
    expect(choice).toEqual(routine);
    expect(
      selectConfiguredModel({
        ...defaults,
        override: choice,
        overrideCredential: credential("routine-provider", "stored-model"),
      }),
    ).toMatchObject({ provider: "routine-provider", id: "routine-model", thinkingLevel: "low" });
  });

  it("keeps a pinned run on its model after the routine is edited or deleted", () => {
    // The routine row is gone or changed; the run still carries what it fired with.
    expect(runModelChoice({ modelPinned: true, ...routine }, bot)).toEqual(routine);
  });

  it("falls back to the bot for a routine run without a pinned model", () => {
    expect(
      runModelChoice(
        { modelPinned: false, modelProvider: null, modelId: null, thinkingLevel: null },
        bot,
      ),
    ).toEqual(bot);
  });

  it("follows the bot when a routine run only recorded the model an attempt used", () => {
    expect(runModelChoice({ modelPinned: false, ...routine }, bot)).toEqual(bot);
  });

  it("ignores run model columns that belong to an ordinary run", () => {
    // Ordinary runs record the model they used; that record is not an override.
    expect(runModelChoice(routine, bot)).toEqual(bot);
  });

  it("pins an inbound delivery only when every routine chose the same model", () => {
    expect(inboundRoutineModelPin([routine, routine])).toEqual({
      ...routine,
      modelPinned: true,
    });
    expect(
      inboundRoutineModelPin([
        routine,
        { modelProvider: null, modelId: null, thinkingLevel: null },
      ]),
    ).toEqual({});
    expect(
      inboundRoutineModelPin([
        routine,
        { modelProvider: "other", modelId: "other-model", thinkingLevel: null },
      ]),
    ).toEqual({});
  });

  it("rejects a pinned model whose credential is missing or belongs to another free-form model", () => {
    expect(pinnedModelCredentialError(routine, null)).toBe("Connect that model provider first");
    expect(pinnedModelCredentialError(routine, { defaultModel: "other-model" })).toBe(
      "Unknown model for that provider",
    );
    expect(pinnedModelCredentialError(routine, { defaultModel: routine.modelId })).toBeUndefined();
    expect(
      pinnedModelCredentialError(
        { modelProvider: "xai", modelId: "grok-4.6", thinkingLevel: null },
        { defaultModel: "other-model" },
      ),
    ).toBeUndefined();
  });
});

describe("defaultCatalogModelId", () => {
  it("skips Codex Spark as the default for ChatGPT subscription credentials", () => {
    const oauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    expect(defaultCatalogModelId("openai-codex", oauth)).not.toBe("gpt-5.3-codex-spark");
    expect(defaultCatalogModelId("openai-codex", oauth)).toBeTruthy();
  });
});

describe("space catalog auth", () => {
  const scope = { userId: "user-1", spaceId: "space-1" };
  const oauth = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  const apiKey = "sk-test-api-key-12345678";
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";

  function stamp(iso: string) {
    return new Date(iso);
  }

  function storedCredential(id: string, secretId: string, iso: string) {
    return {
      id,
      provider: "openai-codex",
      secretId,
      updatedAt: stamp(iso),
      createdAt: stamp(iso),
    };
  }

  function storedPreference(input: {
    id: string;
    modelId: string | null;
    isDefault: boolean;
    credentialId: string;
    secretId: string;
    iso: string;
  }) {
    return {
      id: input.id,
      modelId: input.modelId,
      isDefault: input.isDefault,
      updatedAt: stamp(input.iso),
      credential: storedCredential(input.credentialId, input.secretId, input.iso),
    };
  }

  function authPrisma(options: {
    credentials: ReturnType<typeof storedCredential>[];
    preferences: ReturnType<typeof storedPreference>[];
    secrets: Array<{ id: string; ciphertext: string }>;
  }) {
    const credentialFindMany = vi.fn().mockResolvedValue(options.credentials);
    const preferenceFindMany = vi.fn().mockResolvedValue(options.preferences);
    const secretFindMany = vi.fn().mockResolvedValue(options.secrets);
    const prisma = {
      userModelCredential: { findMany: credentialFindMany },
      spaceModelPreference: { findMany: preferenceFindMany },
      secret: { findMany: secretFindMany },
    } as unknown as PrismaClient;
    return { prisma, credentialFindMany, preferenceFindMany, secretFindMany };
  }

  function listsSpark(auth: Awaited<ReturnType<typeof modelCredentialAuthKindsForSpace>>) {
    return listAvailablePiCatalog(auth.byProvider, auth.byModel).some(
      (entry) => entry.provider === "openai-codex" && entry.id === spark,
    );
  }

  it("uses the space preference instead of a newer account credential", async () => {
    const { prisma, preferenceFindMany } = authPrisma({
      credentials: [
        storedCredential("cred-api", "secret-api", "2026-03-01T00:00:00.000Z"),
        storedCredential("cred-oauth", "secret-oauth", "2026-01-01T00:00:00.000Z"),
      ],
      preferences: [
        storedPreference({
          id: "pref-oauth",
          modelId: luna,
          isDefault: true,
          credentialId: "cred-oauth",
          secretId: "secret-oauth",
          iso: "2026-01-02T00:00:00.000Z",
        }),
      ],
      secrets: [{ id: "secret-oauth", ciphertext: "cipher-oauth" }],
    });
    const load = vi.fn(async (ciphertext: string) =>
      ciphertext === "cipher-oauth" ? oauth : apiKey,
    );

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth.byProvider["openai-codex"]).toBe("oauth");
    expect(preferenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: scope.userId, spaceId: scope.spaceId },
      }),
    );
    expect(listsSpark(auth)).toBe(false);
    expect(load).not.toHaveBeenCalledWith("cipher-api", "secret-api");
  });

  it("shows Spark from the preference that owns that model when the default is ChatGPT sign-in", async () => {
    const { prisma } = authPrisma({
      credentials: [
        storedCredential("cred-api", "secret-api", "2026-02-01T00:00:00.000Z"),
        storedCredential("cred-oauth", "secret-oauth", "2026-03-01T00:00:00.000Z"),
      ],
      preferences: [
        storedPreference({
          id: "pref-oauth",
          modelId: luna,
          isDefault: true,
          credentialId: "cred-oauth",
          secretId: "secret-oauth",
          iso: "2026-03-02T00:00:00.000Z",
        }),
        storedPreference({
          id: "pref-spark",
          modelId: spark,
          isDefault: false,
          credentialId: "cred-api",
          secretId: "secret-api",
          iso: "2026-02-02T00:00:00.000Z",
        }),
      ],
      secrets: [
        { id: "secret-oauth", ciphertext: "cipher-oauth" },
        { id: "secret-api", ciphertext: "cipher-api" },
      ],
    });
    const load = vi.fn(async (_ciphertext: string, secretId: unknown) =>
      secretId === "secret-oauth" ? oauth : apiKey,
    );

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth.byModel["openai-codex"]?.[spark]).toBe("api_key");
    expect(auth.byProvider["openai-codex"]).toBe("oauth");
    expect(auth.secretIdByModel["openai-codex"]?.[spark]).toBe("secret-api");
    expect(auth.secretIdByProvider["openai-codex"]).toBe("secret-oauth");
    expect(listsSpark(auth)).toBe(true);
    expect(
      listAvailablePiCatalog(auth.byProvider, auth.byModel).some(
        (entry) => entry.provider === "openai-codex" && entry.id === luna,
      ),
    ).toBe(true);
  });

  it("hides Spark when the preference that owns it is ChatGPT sign-in", async () => {
    const { prisma } = authPrisma({
      credentials: [
        storedCredential("cred-api", "secret-api", "2026-03-01T00:00:00.000Z"),
        storedCredential("cred-oauth", "secret-oauth", "2026-01-01T00:00:00.000Z"),
      ],
      preferences: [
        storedPreference({
          id: "pref-api",
          modelId: luna,
          isDefault: true,
          credentialId: "cred-api",
          secretId: "secret-api",
          iso: "2026-03-02T00:00:00.000Z",
        }),
        storedPreference({
          id: "pref-spark",
          modelId: spark,
          isDefault: false,
          credentialId: "cred-oauth",
          secretId: "secret-oauth",
          iso: "2026-02-02T00:00:00.000Z",
        }),
      ],
      secrets: [
        { id: "secret-api", ciphertext: "cipher-api" },
        { id: "secret-oauth", ciphertext: "cipher-oauth" },
      ],
    });

    const auth = await modelCredentialAuthKindsForSpace(
      prisma,
      {
        load: async (_ciphertext: string, secretId: unknown) =>
          secretId === "secret-oauth" ? oauth : apiKey,
      },
      scope,
    );

    expect(auth.byModel["openai-codex"]?.[spark]).toBe("oauth");
    expect(auth.secretIdByModel["openai-codex"]?.[spark]).toBe("secret-oauth");
    expect(auth.secretIdByProvider["openai-codex"]).toBe("secret-api");
    expect(listsSpark(auth)).toBe(false);
  });

  it("does not replace an unreadable newest credential with an older API key", async () => {
    const { prisma, secretFindMany } = authPrisma({
      credentials: [
        storedCredential("cred-older", "secret-api", "2026-01-01T00:00:00.000Z"),
        storedCredential("cred-newest", "secret-broken", "2026-03-01T00:00:00.000Z"),
      ],
      preferences: [],
      secrets: [
        { id: "secret-broken", ciphertext: "cipher-broken" },
        { id: "secret-api", ciphertext: "cipher-api" },
      ],
    });
    const load = vi.fn(async (ciphertext: string) => {
      if (ciphertext === "cipher-broken") throw new Error("unreadable");
      return apiKey;
    });

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(secretFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["secret-broken"] } }),
      }),
    );
    expect(auth.byProvider).toEqual({});
    expect(auth.byModel).toEqual({});
    expect(listsSpark(auth)).toBe(false);
    expect(load).not.toHaveBeenCalledWith("cipher-api", "secret-api");
  });

  it("does not replace an unreadable model preference with the provider default", async () => {
    const { prisma } = authPrisma({
      credentials: [
        storedCredential("cred-api", "secret-api", "2026-03-01T00:00:00.000Z"),
        storedCredential("cred-oauth", "secret-oauth", "2026-01-01T00:00:00.000Z"),
      ],
      preferences: [
        storedPreference({
          id: "pref-api",
          modelId: luna,
          isDefault: true,
          credentialId: "cred-api",
          secretId: "secret-api",
          iso: "2026-03-02T00:00:00.000Z",
        }),
        storedPreference({
          id: "pref-spark",
          modelId: spark,
          isDefault: false,
          credentialId: "cred-oauth",
          secretId: "secret-oauth",
          iso: "2026-02-02T00:00:00.000Z",
        }),
      ],
      secrets: [
        { id: "secret-api", ciphertext: "cipher-api" },
        { id: "secret-oauth", ciphertext: "cipher-oauth" },
      ],
    });
    const load = vi.fn(async (_ciphertext: string, secretId: unknown) => {
      if (secretId === "secret-oauth") throw new Error("unreadable");
      return apiKey;
    });

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth.byModel["openai-codex"]?.[spark]).toBe("disconnected");
    expect(listsSpark(auth)).toBe(false);
  });

  it("decrypts a provider credential once, not once per catalog model", async () => {
    const { prisma } = authPrisma({
      credentials: [
        {
          ...storedCredential("cred-or", "secret-or", "2026-03-01T00:00:00.000Z"),
          provider: "openrouter",
        },
      ],
      preferences: [],
      secrets: [{ id: "secret-or", ciphertext: "cipher-or" }],
    });
    const load = vi.fn(async () => apiKey);

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth.byProvider.openrouter).toBe("api_key");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("default credential selection", () => {
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";

  it("keeps the space preference when another account is also ready", () => {
    expect(
      selectDefaultCredentialId({
        provider: "openai-codex",
        modelId: luna,
        orderedIds: ["older", "newer"],
        readyIds: ["older", "newer"],
        savedModelId: (id) => (id === "older" ? "gpt-5.4" : null),
      }),
    ).toBe("older");
  });

  it("moves the default off an auth-restricted model when another credential can call it", () => {
    expect(
      selectDefaultCredentialId({
        provider: "openai-codex",
        modelId: luna,
        orderedIds: ["api", "oauth"],
        readyIds: ["api", "oauth"],
        savedModelId: (id) => (id === "api" ? spark : null),
      }),
    ).toBe("oauth");
  });

  it("keeps the restricted binding when no other credential is ready", () => {
    expect(
      selectDefaultCredentialId({
        provider: "openai-codex",
        modelId: luna,
        orderedIds: ["api", "oauth"],
        readyIds: ["api"],
        savedModelId: (id) => (id === "api" ? spark : null),
      }),
    ).toBe("api");
  });
});

describe("stored model auth", () => {
  const userId = "user-1";

  it("rejects an unreadable secret and a model the credential cannot call", async () => {
    const findFirst = vi.fn(async (args: { where: { id?: string } }) => {
      if (args.where.id === "secret-broken") {
        return { id: "secret-broken", ciphertext: "cipher-broken" };
      }
      if (args.where.id === "secret-oauth") {
        return { id: "secret-oauth", ciphertext: "cipher-oauth" };
      }
      return null;
    });
    const prisma = { secret: { findFirst } } as unknown as PrismaClient;
    const load = vi.fn(async (ciphertext: string) => {
      if (ciphertext === "cipher-broken") throw new Error("unreadable");
      return JSON.stringify({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      });
    });

    await expect(
      readStoredModelAuth(prisma, { load }, userId, "secret-missing", "openai-codex", "gpt-6-luna"),
    ).resolves.toEqual({ status: "unreadable" });
    await expect(
      readStoredModelAuth(prisma, { load }, userId, "secret-broken", "openai-codex", "gpt-6-luna"),
    ).resolves.toEqual({ status: "unreadable" });
    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: expect.stringMatching(/not available with your current sign-in/i),
    });
    await expect(
      readStoredModelAuth(prisma, { load }, userId, "secret-oauth", "openai-codex", "gpt-6-luna"),
    ).resolves.toEqual({ status: "ready" });
  });

  it("keeps a decryptable-but-corrupt secret unreadable even when the live catalog lists the model", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-corrupt",
          ciphertext: "cipher-corrupt",
        })),
      },
    } as unknown as PrismaClient;
    // Decrypts fine, but the stored JSON claims oauth without a credential.
    const load = vi.fn(async () => JSON.stringify({ kind: "oauth" }));
    const live = {
      read: vi.fn(async () => [
        {
          slug: "gpt-5.3-codex-spark",
          reasoningEfforts: [],
          supportsImages: false,
          supportsFastTier: true,
        },
      ]),
    };

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-corrupt",
        "openai-codex",
        "gpt-5.3-codex-spark",
        live,
      ),
    ).resolves.toEqual({ status: "unreadable" });
    expect(live.read).not.toHaveBeenCalled();
  });

  it("accepts a statically excluded model when its own account's live catalog lists it", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-oauth",
          ciphertext: "cipher-oauth",
        })),
      },
    } as unknown as PrismaClient;
    const oauthWithAccount = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct-live",
    });
    const load = vi.fn(async () => oauthWithAccount);
    const live = {
      read: vi.fn(async (_userId: string, account: { accountId: string }) =>
        account.accountId === "acct-live"
          ? [
              {
                slug: "gpt-5.3-codex-spark",
                reasoningEfforts: [],
                supportsImages: false,
                supportsFastTier: true,
              },
            ]
          : undefined,
      ),
    };

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        live,
      ),
    ).resolves.toEqual({ status: "ready" });
    expect(live.read).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ accountId: "acct-live" }),
      undefined,
    );

    // A catalog that does not list the model keeps the static rejection.
    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read: vi.fn(async () => []) },
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: expect.stringMatching(/not available with your current sign-in/i),
    });
  });

  it("does not consult the live catalog for an expired credential", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-oauth",
          ciphertext: "cipher-oauth",
        })),
      },
    } as unknown as PrismaClient;
    const load = vi.fn(async () =>
      JSON.stringify({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() - 1_000,
        accountId: "acct-live",
      }),
    );
    const read = vi.fn(
      async (
        _userId: string,
        account: { accountId: string; accessToken: () => Promise<string | null> },
      ) => {
        // The catalog path must see an expired credential as "no usable token".
        return (await account.accessToken()) === null ? undefined : [];
      },
    );

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read },
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: expect.stringMatching(/not available with your current sign-in/i),
    });
  });

  it("fires the expired-token hook so the caller can kick a detached refresh", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-oauth",
          ciphertext: "cipher-oauth",
        })),
      },
    } as unknown as PrismaClient;
    let plaintext = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() - 1_000,
      accountId: "acct-live",
    });
    const load = vi.fn(async () => plaintext);
    const read = vi.fn(
      async (
        _userId: string,
        account: { accountId: string; accessToken: () => Promise<string | null> },
      ) =>
        (await account.accessToken()) === null
          ? undefined
          : [
              {
                slug: "gpt-5.3-codex-spark",
                reasoningEfforts: [],
                supportsImages: false,
                supportsFastTier: true,
              },
            ],
    );
    const onExpiredToken = vi.fn();

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read },
        { onExpiredToken },
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: expect.stringMatching(/not available with your current sign-in/i),
    });
    expect(onExpiredToken).toHaveBeenCalledTimes(1);

    // A valid bearer never fires the hook — and the live answer flows through.
    plaintext = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct-live",
    });
    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read },
        { onExpiredToken },
      ),
    ).resolves.toEqual({ status: "ready" });
    expect(onExpiredToken).toHaveBeenCalledTimes(1);
  });

  it("passes a zero wait bound through to the catalog read", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-oauth",
          ciphertext: "cipher-oauth",
        })),
      },
    } as unknown as PrismaClient;
    const load = vi.fn(async () =>
      JSON.stringify({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        accountId: "acct-live",
      }),
    );
    const read = vi.fn(async () => [
      {
        slug: "gpt-5.3-codex-spark",
        reasoningEfforts: [],
        supportsImages: false,
        supportsFastTier: true,
      },
    ]);

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read },
        { waitMs: 0 },
      ),
    ).resolves.toEqual({ status: "ready" });
    expect(read).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ accountId: "acct-live" }),
      expect.objectContaining({ waitMs: 0 }),
    );
  });
});

describe("model auth availability", () => {
  it("rejects Codex Spark for oauth credentials and keeps other catalog models", () => {
    const oauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    expect(validateModelAuthAvailability("openai-codex", "gpt-5.3-codex-spark", oauth)).toMatch(
      /not available with your current sign-in/i,
    );
    expect(validateModelAuthAvailability("openai-codex", "gpt-6-luna", oauth)).toBeUndefined();
    expect(
      validateModelAuthAvailability("openai-codex", "gpt-5.3-codex-spark", "sk-test-api-key"),
    ).toBeUndefined();
  });
});

describe("connected model validation", () => {
  const actor: Pick<Actor, "userId" | "spaceId"> = {
    userId: "user-1",
    spaceId: "space-1",
  };

  it("accepts catalog and saved free-form models but rejects unavailable choices", async () => {
    const catalogPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => credential("xai", null) },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "grok-4.6"),
    ).resolves.toBeUndefined();
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "not-a-model"),
    ).resolves.toBe("Unknown model for that provider");

    const preferenceFindFirst = vi.fn(
      async (args: {
        where: {
          spaceId?: string;
          userId?: string;
          modelId?: string;
          credential?: { provider?: string; userId?: string };
        };
      }) => {
        if (args.where.modelId) {
          if (
            args.where.spaceId === actor.spaceId &&
            args.where.userId === actor.userId &&
            args.where.modelId === "private-model" &&
            args.where.credential?.provider === "openai-compatible" &&
            args.where.credential?.userId === actor.userId
          ) {
            return { id: "saved-private-model" };
          }
          return null;
        }
        if (args.where.credential?.provider === "openai-compatible") {
          return {
            credential: credential("openai-compatible", "newest-model"),
            isDefault: true,
            modelId: "newest-model",
            thinkingLevel: null,
          };
        }
        return null;
      },
    );
    const customPrisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "private-model"),
    ).resolves.toBeUndefined();
    expect(preferenceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          userId: actor.userId,
          modelId: "private-model",
          credential: { userId: actor.userId, provider: "openai-compatible" },
        }),
        select: { id: true },
      }),
    );
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "missing-model"),
    ).resolves.toBe("Unknown model for that provider");

    const disconnectedPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(disconnectedPrisma, actor, "anthropic", "claude-opus-4-6"),
    ).resolves.toBe("Connect that model provider first");

    await expect(validateConnectedModelChoice(catalogPrisma, actor, "xai", "null")).resolves.toBe(
      "Unknown model for that provider",
    );
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "undefined"),
    ).resolves.toBe("Unknown model for that provider");
  });
});
