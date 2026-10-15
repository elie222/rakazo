import { createRouterClient } from "@orpc/server";
import type * as AdaptersModule from "@rakazo/adapters";
import { listPiCatalog, serializeModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const probes = vi.hoisted(() => ({
  catalog: vi.fn(async () => ["test-model"]),
  compatible: vi.fn(async () => ["test-model"]),
}));
vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof AdaptersModule>()),
  probeCatalogProviderModels: probes.catalog,
  probeOpenAiCompatibleModels: probes.compatible,
}));

const actor = {
  userId: "user",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const modelId = listPiCatalog().find(
  (model) => model.provider === "anthropic" && !model.placeholder,
)!.id;
type Row = Record<string, any>;
function fixture() {
  const accounts: Row[] = ["a", "b"].map((id, index) => ({
    id,
    userId: "user",
    provider: "anthropic",
    label: `Account ${id}`,
    secretId: `secret-${id}`,
    supportsImages: false,
    createdAt: new Date(index),
    updatedAt: new Date(index),
  }));
  const preferences: Row[] = accounts.map((account, index) => ({
    id: `pref-${account.id}`,
    spaceId: "space",
    userId: "user",
    credentialId: account.id,
    modelId,
    thinkingLevel: null,
    isDefault: index === 0,
    updatedAt: new Date(index),
  }));
  const secrets: Row[] = accounts.map((account) => ({
    id: account.secretId,
    userId: "user",
    spaceId: null,
    ciphertext: `cipher-${account.id}`,
  }));
  const plaintext = new Map(
    accounts.map((account) => [
      `cipher-${account.id}`,
      serializeModelSecret({ kind: "api_key", key: `fake-account-${account.id}-key` }),
    ]),
  );
  function matches(row: Row, where: Row = {}) {
    return Object.entries(where).every(([key, value]) => {
      if (key === "credential")
        return matches(accounts.find((account) => account.id === row.credentialId)!, value);
      if (value && typeof value === "object")
        return value.in
          ? value.in.includes(row[key])
          : "not" in value
            ? row[key] !== value.not
            : true;
      return row[key] === value;
    });
  }
  const credentials = {
    findFirst: vi.fn(async ({ where, include }: Row) => {
      const row = accounts.filter((item) => matches(item, where)).at(-1);
      return row
        ? {
            ...row,
            ...(include
              ? {
                  preferences: preferences.filter(
                    (pref) =>
                      pref.credentialId === row.id && matches(pref, include.preferences.where),
                  ),
                }
              : {}),
          }
        : null;
    }),
    findMany: vi.fn(async ({ where }: Row) =>
      accounts.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    create: vi.fn(async ({ data }: Row) => {
      const row = {
        ...data,
        id: `new-${accounts.length}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      accounts.push(row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: Row) => {
      const row = accounts.find((item) => matches(item, where))!;
      Object.assign(row, data);
      return { ...row };
    }),
    deleteMany: vi.fn(async ({ where }: Row) => {
      const before = accounts.length;
      for (let i = accounts.length - 1; i >= 0; i--)
        if (matches(accounts[i]!, where)) accounts.splice(i, 1);
      return { count: before - accounts.length };
    }),
    count: vi.fn(async ({ where }: Row) => accounts.filter((row) => matches(row, where)).length),
  };
  const preferenceModel = {
    findFirst: vi.fn(
      async ({ where }: Row) => preferences.find((row) => matches(row, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: Row) =>
      preferences
        .filter((row) => matches(row, where))
        .map((row) => ({
          ...row,
          credential: accounts.find((account) => account.id === row.credentialId),
        })),
    ),
    updateMany: vi.fn(async ({ where, data }: Row) => {
      preferences
        .filter((row) => matches(row, where))
        .forEach((row) => {
          Object.assign(row, data);
        });
      return { count: 1 };
    }),
    upsert: vi.fn(async ({ where, create, update }: Row) => {
      const row = preferences.find((item) => matches(item, where.spaceId_userId_credentialId));
      if (row) {
        Object.assign(row, update);
        return row;
      }
      const next = { id: `pref-${preferences.length}`, updatedAt: new Date(), ...create };
      preferences.push(next);
      return next;
    }),
    deleteMany: vi.fn(async ({ where }: Row) => {
      for (let i = preferences.length - 1; i >= 0; i--)
        if (matches(preferences[i]!, where)) preferences.splice(i, 1);
      return { count: 1 };
    }),
  };
  const secretModel = {
    findFirst: vi.fn(async ({ where }: Row) => secrets.find((row) => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where }: Row) => secrets.filter((row) => matches(row, where))),
    create: vi.fn(async ({ data }: Row) => {
      secrets.push(data);
      return data;
    }),
    deleteMany: vi.fn(async ({ where }: Row) => {
      for (let i = secrets.length - 1; i >= 0; i--)
        if (matches(secrets[i]!, where)) secrets.splice(i, 1);
      return { count: 1 };
    }),
  };
  const db = {
    userModelCredential: credentials,
    spaceModelPreference: preferenceModel,
    secret: secretModel,
    userVoiceCredential: { count: vi.fn(async () => 0) },
    spaceBackupModel: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (work) => work(db));
  const store = {
    load: vi.fn(async (ciphertext: string) => plaintext.get(ciphertext)!),
    put: vi.fn(async (value: string) => {
      const id = `saved-${plaintext.size}`;
      plaintext.set(id, value);
      return { id, ciphertext: id };
    }),
  };
  const oauthLogins = {
    cancelProvider: vi.fn(),
    begin: vi.fn(async () => ({
      loginId: "login",
      provider: "anthropic",
      mode: "device-code",
      verificationUri: "https://example.test/login",
      userCode: "FAKE",
      expiresInSeconds: 60,
    })),
  };
  const deps = {
    prisma: db,
    secrets: store,
    oauthLogins,
    env: {
      agentRuntime: "pi",
      defaultProvider: "anthropic",
      defaultModel: modelId,
      sandboxProvider: "fake",
    },
  } as unknown as RouterDeps;
  return {
    client: createRouterClient(createRouter(deps), { context: { actor } as never }),
    accounts,
    plaintext,
    preferences,
    secrets,
    db,
    store,
    oauthLogins,
  };
}

describe("explicit model accounts", () => {
  it("adds a same-provider account without reading another key or changing the default", async () => {
    const f = fixture();
    const created = await f.client.models.connect({
      provider: "anthropic",
      createNew: true,
      label: "New account",
      apiKey: "fake-new-account-key",
      modelId,
    });
    expect(f.accounts).toHaveLength(3);
    expect(created.id).not.toBe("a");
    expect(created.id).not.toBe("b");
    expect(created.isDefault).toBe(false);
    expect(f.store.load).not.toHaveBeenCalled();
    expect(f.db.userModelCredential.update).not.toHaveBeenCalled();
    expect(f.preferences.find((row) => row.credentialId === "a")?.isDefault).toBe(true);
  });
  it("reconnects only the selected account and preserves the other secret", async () => {
    const f = fixture();
    await f.client.models.connect({
      provider: "anthropic",
      credentialId: "a",
      apiKey: "fake-replacement-key",
      modelId,
    });
    expect(f.accounts.find((row) => row.id === "a")?.secretId).not.toBe("secret-a");
    expect(f.accounts.find((row) => row.id === "b")?.secretId).toBe("secret-b");
    expect(f.secrets.some((row) => row.id === "secret-b")).toBe(true);
    expect(f.store.load).toHaveBeenCalledWith("cipher-a", "secret-a");
  });
  it("renames an exact account without rotating secret material or changing defaults", async () => {
    const f = fixture();
    const saved = await f.client.models.connect({
      provider: "anthropic",
      credentialId: "b",
      label: "Renamed",
      makeDefault: false,
    });
    expect(saved.label).toBe("Renamed");
    expect(saved.isDefault).toBe(false);
    expect(f.accounts[1]?.secretId).toBe("secret-b");
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it.each(["missing", "foreign"])(
    "rejects an unavailable account %s before reading or storing secrets",
    async (id) => {
      const f = fixture();
      if (id === "foreign") f.accounts.push({ ...f.accounts[0], id, userId: "other" });
      await expect(
        f.client.models.connect({
          provider: "anthropic",
          credentialId: id,
          apiKey: "fake-new-account-key",
          modelId,
        }),
      ).rejects.toThrow();
      expect(f.store.load).not.toHaveBeenCalled();
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it("does not inherit a key when creating a new account", async () => {
    const f = fixture();
    await expect(
      f.client.models.connect({ provider: "anthropic", createNew: true, maxTokens: 100 }),
    ).rejects.toThrow();
    expect(f.store.load).not.toHaveBeenCalled();
  });
  it("rejects conflicting new and existing account targets", async () => {
    const f = fixture();
    await expect(
      f.client.models.connect({
        provider: "anthropic",
        createNew: true,
        credentialId: "a",
        apiKey: "fake-new-account-key",
      }),
    ).rejects.toThrow();
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it("disconnects one account without deleting a sibling or provider-wide defaults", async () => {
    const f = fixture();
    await f.client.models.disconnect({ provider: "anthropic", credentialId: "a" });
    expect(f.accounts.map((row) => row.id)).toEqual(["b"]);
    expect(f.secrets.map((row) => row.id)).toEqual(["secret-b"]);
    expect(f.db.spaceBackupModel.deleteMany).not.toHaveBeenCalled();
    expect(f.oauthLogins.cancelProvider).not.toHaveBeenCalled();
  });
  it("preserves the legacy provider-wide disconnect", async () => {
    const f = fixture();
    await f.client.models.disconnect({ provider: "anthropic" });
    expect(f.accounts).toEqual([]);
    expect(f.secrets).toEqual([]);
    expect(f.oauthLogins.cancelProvider).toHaveBeenCalledWith({
      userId: "user",
      provider: "anthropic",
    });
  });
  it("selects the exact same-provider account as default", async () => {
    const f = fixture();
    await f.client.models.setDefault({ provider: "anthropic", credentialId: "b", modelId });
    expect(f.preferences.find((row) => row.credentialId === "a")?.isDefault).toBe(false);
    expect(f.preferences.find((row) => row.credentialId === "b")?.isDefault).toBe(true);
    expect(f.store.load).not.toHaveBeenCalledWith("cipher-a", "secret-a");
  });
  it("passes explicit OAuth account targeting without starting a real login", async () => {
    const f = fixture();
    await f.client.models.beginOAuth({
      provider: "anthropic",
      credentialId: "b",
      makeDefault: false,
    });
    expect(f.oauthLogins.begin).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: "b", makeDefault: false }),
    );
  });
  it("reads profile model metadata from only the selected account", async () => {
    const f = fixture();
    const models = await f.client.executionProfiles.models({ harness: "pi", credentialId: "a" });
    expect(models.some((model) => model.protocol === "anthropic")).toBe(true);
    expect(f.store.load).toHaveBeenCalledWith("cipher-a", "secret-a");
    expect(f.store.load).not.toHaveBeenCalledWith("cipher-b", "secret-b");
  });
});

describe("native account lifecycle separation", () => {
  it.each(["connect", "setDefault", "disconnect", "beginOAuth"] as const)(
    "rejects ordinary %s on a native subscription account",
    async (method) => {
      const f = fixture();
      await expect(
        (f.client.models[method] as (input: unknown) => Promise<unknown>)({
          provider: "native-codex",
          credentialId: "a",
          modelId,
          label: "Native",
        }),
      ).rejects.toThrow();
      expect(f.accounts).toHaveLength(2);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it("allows a compatible account label edit without changing its endpoint or secret", async () => {
    const f = fixture();
    f.accounts[0]!.provider = "openai-compatible";
    const result = await f.client.models.connect({
      provider: "openai-compatible",
      credentialId: "a",
      label: "Renamed compatible",
    });
    expect(result.label).toBe("Renamed compatible");
    expect(f.store.put).not.toHaveBeenCalled();
    expect(f.accounts[0]!.secretId).toBe("secret-a");
  });
});

describe("exact account model discovery", () => {
  it("discovers with only the explicitly selected account key", async () => {
    const f = fixture();
    await f.client.models.probeCatalog({ provider: "anthropic", credentialId: "b" });
    expect(probes.catalog).toHaveBeenLastCalledWith(
      { provider: "anthropic", apiKey: "fake-account-b-key" },
      undefined,
      undefined,
    );
    expect(f.store.load).not.toHaveBeenCalledWith("cipher-a", "secret-a");
  });
  it("never forwards an existing account key to a changed compatible endpoint", async () => {
    const f = fixture();
    f.accounts[0]!.provider = "openai-compatible";
    f.plaintext.set(
      "cipher-a",
      serializeModelSecret({
        kind: "openai_compatible",
        baseUrl: "https://api.example.test/v1",
        apiKey: "fake-account-a-key",
      }),
    );
    const before = probes.compatible.mock.calls.length;
    await expect(
      f.client.models.probeOpenAiCompatible({
        credentialId: "a",
        baseUrl: "https://other.example.test/v1",
      }),
    ).rejects.toThrow("Enter a key explicitly");
    expect(probes.compatible.mock.calls).toHaveLength(before);
    await f.client.models.probeOpenAiCompatible({
      credentialId: "a",
      baseUrl: "https://api.example.test/v1",
    });
    expect(probes.compatible).toHaveBeenLastCalledWith(
      { baseUrl: "https://api.example.test/v1", apiKey: "fake-account-a-key" },
      undefined,
      undefined,
    );
  });
  it("rejects an account owned by another provider before attempting discovery", async () => {
    const f = fixture();
    const before = probes.catalog.mock.calls.length;
    await expect(
      f.client.models.probeCatalog({ provider: "openai", credentialId: "a" }),
    ).rejects.toThrow();
    expect(probes.catalog.mock.calls).toHaveLength(before);
    expect(f.store.load).not.toHaveBeenCalled();
  });
});
