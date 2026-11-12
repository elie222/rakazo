import { MemoryProviderPrivateEndpointRequiredError } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  disconnectMemoryProvider,
  persistMemoryProviderConfig,
  updateMemoryProviderConfig,
  updateMemoryProviderDefaultScope,
} from "./memory-provider-config.js";

const actor = {
  userId: "user-1",
  spaceId: "ws-1",
  email: "a@b.com",
  isDeploymentOwner: false,
};
const deploymentOwner = { ...actor, isDeploymentOwner: true };

function makeDeps(
  overrides: {
    existing?: {
      id: string;
      secretId: string;
      provider?: string;
      defaultMemoryScope?: string;
      settings?: Record<string, string>;
      secret?: { id: string; ciphertext: string };
    } | null;
    upsertResult?: {
      provider: string;
      settings: Record<string, string>;
      defaultMemoryScope: string;
      updatedAt: Date;
    };
    updateResult?: {
      provider: string;
      settings: Record<string, string>;
      defaultMemoryScope: string;
      updatedAt: Date;
    };
    spaceOwner?: boolean;
    memberRole?: string;
  } = {},
) {
  const secretCreate = vi.fn().mockResolvedValue({ id: "secret-new" });
  const secretDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const findUnique = vi.fn().mockResolvedValue(overrides.existing ?? null);
  const upsert = vi.fn().mockResolvedValue(
    overrides.upsertResult ?? {
      provider: "supermemory",
      settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
      defaultMemoryScope: "isolated",
      updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    },
  );
  const update = vi.fn().mockResolvedValue(
    overrides.updateResult ?? {
      provider: "supermemory",
      settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
      defaultMemoryScope: "shared",
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    },
  );
  const deleteConfig = vi.fn().mockResolvedValue({ id: "cfg-1" });
  const prisma = {
    spaceMember: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          overrides.spaceOwner === false ? null : { role: overrides.memberRole ?? "owner" },
        ),
    },
    spaceMemoryConfig: { findUnique, update, upsert, delete: deleteConfig },
    secret: {
      create: secretCreate,
      deleteMany: secretDeleteMany,
      findUnique: vi.fn().mockResolvedValue({ id: "secret-old", ciphertext: "old-cipher" }),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: {
      put: vi.fn().mockResolvedValue({ id: "secret-new", ciphertext: "cipher" }),
      load: vi.fn().mockResolvedValue(JSON.stringify({ apiKey: "sm_stored_key_12345" })),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
  return {
    deps,
    secretCreate,
    secretDeleteMany,
    findUnique,
    upsert,
    update,
    deleteConfig,
    transaction: prisma.$transaction,
  };
}

function connectionInput(mode: "cloud" | "local", baseUrl?: string) {
  return {
    provider: "supermemory",
    settings: { mode, ...(baseUrl ? { baseUrl } : {}) },
    credentials: { apiKey: "sm_test_key_12345" },
    defaultMemoryScope: "isolated" as const,
  };
}

describe("persistMemoryProviderConfig", () => {
  it("does not trust a legacy owner flag for private-network access", async () => {
    const { deps } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        deps,
        deploymentOwner,
        connectionInput("local", "http://10.0.0.8:6767"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it("stores Honcho credentials only in the secret and never serializes them to the client", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) !== "https://api.honcho.dev/v3/workspaces")
        throw new Error("Unexpected request");
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings = { workspaceId: "team-notes", reasoningLevel: "low" };
    const { deps, upsert, secretCreate } = makeDeps({
      upsertResult: {
        provider: "honcho",
        settings,
        defaultMemoryScope: "isolated",
        updatedAt: new Date("2026-08-19T00:00:00.000Z"),
      },
    });
    try {
      const result = await persistMemoryProviderConfig(deps, actor, {
        provider: "honcho",
        settings: { ...settings, apiKey: "discard", baseUrl: "http://localhost" },
        credentials: { apiKey: "hch-test-key" },
        defaultMemoryScope: "isolated",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(deps.secrets.put).toHaveBeenCalledWith(
        JSON.stringify({ apiKey: "hch-test-key" }),
        expect.any(Object),
      );
      expect(secretCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ ciphertext: "cipher", kind: "memory-provider" }),
      });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ settings, secretId: "secret-new" }),
          update: expect.objectContaining({ settings, secretId: "secret-new" }),
        }),
      );
      expect(result).toEqual({
        provider: "honcho",
        settings,
        defaultMemoryScope: "isolated",
        updatedAt: "2026-08-19T00:00:00.000Z",
      });
      expect(JSON.stringify(result)).not.toMatch(/apiKey|hch-test-key|cipher|secret/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects unknown providers as bad requests without probing or writing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps();
    try {
      await expect(
        persistMemoryProviderConfig(deps, actor, {
          ...connectionInput("cloud"),
          provider: "unknown-provider",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["#", "?action=delete", "?"])(
    "rejects ambiguous local URLs even with operator-configured private endpoints: %s",
    async (suffix) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { deps, transaction } = makeDeps();
      try {
        await expect(
          persistMemoryProviderConfig(
            { ...deps, env: { mcpAllowPrivateEndpoint: true } },
            deploymentOwner,
            connectionInput("local", `http://127.0.0.1:8123/internal-action${suffix}`),
          ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    "http://127.0.0.1:8123/internal-action#",
    "http://localhost:6767",
    "http://10.0.0.8:6767",
    "http://supermemory:6767",
  ])("rejects ordinary Space owners before any local probe or write: %s", async (baseUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]"));
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps();
    try {
      await expect(
        persistMemoryProviderConfig(deps, actor, connectionInput("local", baseUrl)),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deps.secrets.put).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still requires Space ownership for a deployment owner", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps({ spaceOwner: false });
    try {
      await expect(
        persistMemoryProviderConfig(
          { ...deps, env: { mcpAllowPrivateEndpoint: true } },
          deploymentOwner,
          connectionInput("local", "http://localhost:6767"),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects non-owners before probing or writing Space configuration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps({ spaceOwner: false });

    await expect(
      persistMemoryProviderConfig(deps, actor, connectionInput("cloud")),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects local mode without a baseUrl, without touching the database", async () => {
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        { ...deps, env: { mcpAllowPrivateEndpoint: true } },
        deploymentOwner,
        connectionInput("local"),
      ),
    ).rejects.toThrow(/baseUrl/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a metadata baseUrl in local mode without probing or touching the database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        { ...deps, env: { mcpAllowPrivateEndpoint: true } },
        deploymentOwner,
        connectionInput("local", "http://169.254.169.254/latest/meta-data/"),
      ),
    ).rejects.toThrow(/blocked address/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects a public HTTP base URL in local mode without probing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        { ...deps, env: { mcpAllowPrivateEndpoint: true } },
        deploymentOwner,
        connectionInput("local", "http://203.0.113.10:6767"),
      ),
    ).rejects.toThrow(/private-network/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("accepts a private-network base URL in local mode with operator-configured private endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps();

    await persistMemoryProviderConfig(
      { ...deps, env: { mcpAllowPrivateEndpoint: true } },
      deploymentOwner,
      connectionInput("local", "http://10.0.0.8:6767"),
    );

    expect(fetchMock.mock.calls[0]![0]).toBe("http://10.0.0.8:6767/v3/container-tags/list");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          settings: { mode: "local", baseUrl: "http://10.0.0.8:6767" },
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("probes before persisting, and rejects (without writing) when the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        { ...deps, env: { mcpAllowPrivateEndpoint: true } },
        deploymentOwner,
        {
          ...connectionInput("local", "http://localhost:6767"),
          credentials: { apiKey: "sm_bad_key" },
        },
      ),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("accepts a bracketed IPv6 loopback base URL in local mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps();

    await persistMemoryProviderConfig(
      { ...deps, env: { mcpAllowPrivateEndpoint: true } },
      deploymentOwner,
      connectionInput("local", "http://[::1]:6767"),
    );

    expect(fetchMock.mock.calls[0]![0]).toBe("http://[::1]:6767/v3/container-tags/list");
    expect(upsert).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("connects cloud mode, defaulting the base URL, and returns the serialized config", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const { deps, upsert, transaction } = makeDeps();
    const result = await persistMemoryProviderConfig(deps, actor, connectionInput("cloud"));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1" },
        create: expect.objectContaining({
          provider: "supermemory",
          settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
        }),
      }),
    );
    expect(result).toEqual({
      provider: "supermemory",
      settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
      defaultMemoryScope: "isolated",
      updatedAt: "2026-08-19T00:00:00.000Z",
    });
    expect(transaction).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("deletes the old secret when replacing an existing config with a new key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const { deps, secretDeleteMany } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-old" },
    });
    await persistMemoryProviderConfig(deps, actor, {
      ...connectionInput("cloud"),
      credentials: { apiKey: "sm_new_key_12345" },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
    vi.unstubAllGlobals();
  });

  it("rejects non-deployment-owners for public-looking Serenity hostnames that resolve private, without probing", async () => {
    const prepareConnection = vi.fn();
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        {
          ...deps,
          classifySettings: async () => ({
            endpoint: "https://serenity.example.test/mcp",
            endpointTrust: "private",
          }),
          prepareConnection,
        },
        actor,
        {
          provider: "serenity",
          settings: { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
          credentials: { token: "serenity_test_token" },
          defaultMemoryScope: "isolated",
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prepareConnection).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects non-owners when prepare reclassifies a hostname as private before probing", async () => {
    const prepareConnection = vi.fn(async () => {
      throw new MemoryProviderPrivateEndpointRequiredError();
    });
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        {
          ...deps,
          classifySettings: async () => ({
            endpoint: "https://serenity.example.test/mcp",
          }),
          prepareConnection,
        },
        actor,
        {
          provider: "serenity",
          settings: { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
          credentials: { token: "serenity_test_token" },
          defaultMemoryScope: "isolated",
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({ allowPrivateEndpoint: false }),
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("disconnectMemoryProvider", () => {
  it("rejects non-owners before opening a transaction", async () => {
    const { deps, transaction, secretDeleteMany } = makeDeps({ spaceOwner: false });

    await expect(disconnectMemoryProvider(deps, actor)).rejects.toThrow();

    expect(transaction).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });

  it("disconnects an existing provider and removes its secret in the same transaction", async () => {
    const { deps, transaction, deleteConfig, secretDeleteMany } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-old" },
    });

    await expect(disconnectMemoryProvider(deps, actor)).resolves.toEqual({ ok: true });

    expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(deleteConfig).toHaveBeenCalledWith({ where: { id: "cfg-1" } });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
  });

  it("leaves secrets untouched when no provider is configured", async () => {
    const { deps, deleteConfig, secretDeleteMany } = makeDeps();

    await expect(disconnectMemoryProvider(deps, actor)).resolves.toEqual({ ok: true });

    expect(deleteConfig).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });
});

describe("updateMemoryProviderDefaultScope", () => {
  it("accepts owners with additional Better Auth roles", async () => {
    const { deps, update } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-existing" },
      memberRole: "owner,admin",
    });

    await updateMemoryProviderDefaultScope(deps, actor, "shared");

    expect(update).toHaveBeenCalled();
  });

  it("updates only the generic scope setting and retains the provider secret", async () => {
    const { deps, update, secretCreate, secretDeleteMany } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-existing" },
    });

    const result = await updateMemoryProviderDefaultScope(deps, actor, "shared");

    expect(update).toHaveBeenCalledWith({
      where: { id: "cfg-1" },
      data: { defaultMemoryScope: "shared" },
    });
    expect(secretCreate).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
    expect(result.defaultMemoryScope).toBe("shared");
  });

  it("rejects non-owners without updating provider configuration", async () => {
    const { deps, update } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-existing" },
      spaceOwner: false,
    });

    await expect(updateMemoryProviderDefaultScope(deps, actor, "shared")).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("updateMemoryProviderConfig", () => {
  const connected = {
    id: "cfg-1",
    secretId: "secret-old",
    provider: "supermemory",
    defaultMemoryScope: "shared",
    settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
    secret: { id: "secret-old", ciphertext: "stored-cipher" },
  };
  const settings = { mode: "cloud", baseUrl: "https://api.supermemory.ai" };

  function updateDeps(overrides: Parameters<typeof makeDeps>[0] = { existing: connected }) {
    const made = makeDeps(overrides);
    const prepareConnection = vi.fn(
      async (input: {
        provider: string;
        settings: Record<string, string>;
        credentials: Record<string, string>;
      }) => ({
        provider: input.provider,
        settings: input.settings,
        credentials: input.credentials,
      }),
    );
    const deps = {
      ...made.deps,
      classifySettings: async (_provider: string, value: Record<string, string>) => value,
      prepareConnection,
    } as Parameters<typeof updateMemoryProviderConfig>[0];
    return { ...made, deps, prepareConnection };
  }

  it("keeps stored credentials when the update leaves them empty", async () => {
    const { deps, prepareConnection, secretDeleteMany, upsert } = updateDeps();
    await updateMemoryProviderConfig(deps, actor, { settings, credentials: { apiKey: "" } });
    expect(deps.secrets.load).toHaveBeenCalledWith("stored-cipher", "secret-old");
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "supermemory",
        settings,
        credentials: { apiKey: "sm_stored_key_12345" },
        allowPrivateEndpoint: false,
      }),
    );
    // The same secret record stays, so work bound to this connection keeps its identity.
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ secretId: "secret-old" }) }),
    );
  });

  it("replaces a credential when one is given and keeps the default scope", async () => {
    const { deps, upsert } = updateDeps();
    await updateMemoryProviderConfig(deps, actor, {
      settings,
      credentials: { apiKey: "sm_new_key_12345" },
    });
    expect(deps.secrets.put).toHaveBeenCalledWith(
      JSON.stringify({ apiKey: "sm_new_key_12345" }),
      expect.anything(),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          provider: "supermemory",
          settings,
          defaultMemoryScope: "shared",
        }),
      }),
    );
  });

  it("refuses when no provider is connected", async () => {
    const { deps, prepareConnection, transaction } = updateDeps({ existing: null });
    await expect(
      updateMemoryProviderConfig(deps, actor, { settings, credentials: {} }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prepareConnection).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects non-owners before reading stored credentials", async () => {
    const { deps } = updateDeps({ existing: connected, spaceOwner: false });
    await expect(
      updateMemoryProviderConfig(deps, actor, { settings, credentials: {} }),
    ).rejects.toThrow();
    // The stored key is only compared, never sent to the moved target.
  });

  it("surfaces a failed probe exactly as connect does, without saving", async () => {
    const { deps, prepareConnection, transaction } = updateDeps();
    prepareConnection.mockRejectedValue(new Error("Supermemory rejected the key"));
    await expect(
      updateMemoryProviderConfig(deps, actor, { settings, credentials: {} }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Supermemory rejected the key" });
    await expect(
      persistMemoryProviderConfig(deps, actor, {
        provider: "supermemory",
        settings,
        credentials: { apiKey: "sm_test_key_12345" },
        defaultMemoryScope: "isolated",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Supermemory rejected the key" });
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses private endpoints the operator has not allowed", async () => {
    const { deps, prepareConnection } = updateDeps();
    await expect(
      updateMemoryProviderConfig(deps, actor, {
        settings: { mode: "local", baseUrl: "http://10.0.0.8:6767" },
        credentials: { apiKey: "sm_new_key_12345" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prepareConnection).not.toHaveBeenCalled();
  });

  it("keeps the stored key for the exact draft the cloud form sends", async () => {
    const { deps, prepareConnection } = updateDeps();
    await updateMemoryProviderConfig(deps, actor, {
      settings: { mode: "cloud" },
      credentials: { apiKey: "" },
    });
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { apiKey: "sm_stored_key_12345" } }),
    );
  });

  it("never sends the stored key to a new address", async () => {
    const { deps, prepareConnection } = updateDeps();
    await updateMemoryProviderConfig({ ...deps, env: { mcpAllowPrivateEndpoint: true } }, actor, {
      settings: { mode: "local", baseUrl: "http://127.0.0.1:6767" },
      credentials: { apiKey: "" },
    });
    // The stored key is only compared, never sent to the moved target.
    // Only what was entered reaches the provider's own validation, which decides whether a missing
    // key is acceptable (a keyless self-hosted server is).
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { apiKey: "" } }),
    );
  });

  it("moves the endpoint when the credentials are entered again", async () => {
    const { deps, prepareConnection } = updateDeps();
    const nextSettings = { mode: "local", baseUrl: "http://127.0.0.1:6767" };
    await updateMemoryProviderConfig({ ...deps, env: { mcpAllowPrivateEndpoint: true } }, actor, {
      settings: nextSettings,
      credentials: { apiKey: "sm_new_key_12345" },
    });
    // The stored key is only compared, never sent to the moved target.
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: nextSettings,
        credentials: { apiKey: "sm_new_key_12345" },
      }),
    );
  });

  it("never lets the stored key reach another workspace or peer", async () => {
    const { deps, prepareConnection } = updateDeps({
      existing: {
        ...connected,
        provider: "honcho",
        settings: { reasoningLevel: "low", workspaceId: "team" },
      },
    });
    await updateMemoryProviderConfig(deps, actor, {
      settings: { mode: "cloud", reasoningLevel: "low", workspaceId: "other-team" },
      credentials: { apiKey: "" },
    });
    // The stored key is only compared, never sent to the moved target.
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { apiKey: "" } }),
    );
  });

  it("never lets the stored key read other banks", async () => {
    const { deps, prepareConnection } = updateDeps({
      existing: { ...connected, provider: "hindsight", settings: { recallBanks: "notes" } },
    });
    await updateMemoryProviderConfig(deps, actor, {
      settings: { mode: "cloud", recallBanks: "notes, journal" },
      credentials: { apiKey: "" },
    });
    // The stored key is only compared, never sent to the moved target.
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { apiKey: "" } }),
    );
  });

  it("keeps the connection identity when only the outside banks change and the key is re-entered", async () => {
    const { deps, upsert } = updateDeps({
      existing: { ...connected, provider: "hindsight", settings: { recallBanks: "notes" } },
    });
    await updateMemoryProviderConfig(deps, actor, {
      settings: { mode: "cloud", recallBanks: "notes, journal" },
      credentials: { apiKey: "sm_stored_key_12345" },
    });
    // Same credentials: the secret record stays, so pending memory cleanup isn't orphaned.
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ secretId: "secret-old" }) }),
    );
  });

  it("refuses when the connection was replaced during the update", async () => {
    const { deps, findUnique, upsert, secretDeleteMany } = updateDeps();
    findUnique
      .mockResolvedValueOnce(connected)
      .mockResolvedValueOnce({ ...connected, secretId: "secret-other" });
    await expect(
      updateMemoryProviderConfig(deps, actor, {
        settings,
        credentials: { apiKey: "sm_replacement_key_1" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(upsert).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
    // The value already written to the secret store is removed there too.
    expect(deps.secrets.delete).toHaveBeenCalledWith("cipher", "secret-new");
  });

  it("removes the replaced key from the secret store once saved", async () => {
    const { deps } = updateDeps();
    await updateMemoryProviderConfig(deps, actor, {
      settings,
      credentials: { apiKey: "sm_replacement_key_1" },
    });
    expect(deps.secrets.delete).toHaveBeenCalledWith("old-cipher", "secret-old");
    expect(deps.secrets.delete).not.toHaveBeenCalledWith("cipher", "secret-new");
  });

  it("saves a typed key when the stored one can no longer be read", async () => {
    const { deps, prepareConnection, upsert } = updateDeps();
    vi.mocked(deps.secrets.load).mockRejectedValueOnce(new Error("secret store key rotated"));
    await updateMemoryProviderConfig(deps, actor, {
      settings,
      credentials: { apiKey: "sm_replacement_key_1" },
    });
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { apiKey: "sm_replacement_key_1" } }),
    );
    expect(upsert).toHaveBeenCalled();
  });

  it("surfaces a secret-store failure when no key was typed", async () => {
    const { deps, prepareConnection, upsert } = updateDeps();
    vi.mocked(deps.secrets.load).mockRejectedValueOnce(new Error("secret store unavailable"));
    await expect(
      updateMemoryProviderConfig(deps, actor, { settings, credentials: { apiKey: "" } }),
    ).rejects.toThrow("secret store unavailable");
    expect(prepareConnection).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
