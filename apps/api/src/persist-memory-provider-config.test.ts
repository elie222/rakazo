import { MemoryProviderPrivateEndpointRequiredError } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  disconnectMemoryProvider,
  persistMemoryProviderConfig,
  serializeSpaceMemoryConfig,
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
    } | null;
    isolatedBot?: boolean;
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
    $queryRaw: vi.fn().mockResolvedValue([]),
    bot: {
      findFirst: vi.fn().mockResolvedValue(overrides.isolatedBot ? { id: "isolated-bot" } : null),
    },
    spaceMemoryConfig: { findUnique, update, upsert, delete: deleteConfig },
    secret: { create: secretCreate, deleteMany: secretDeleteMany },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: { put: vi.fn().mockResolvedValue({ id: "secret-new", ciphertext: "cipher" }) },
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
  function sharedInput() {
    return {
      provider: "rembric",
      settings: { endpoint: `https://memory.example.test/mcp/space-${actor.spaceId}` },
      credentials: { token: "fake-token" },
      defaultMemoryScope: "shared" as const,
    };
  }

  function offlineDeps(overrides: Parameters<typeof makeDeps>[0] = {}) {
    const setup = makeDeps(overrides);
    return {
      ...setup,
      deps: {
        ...setup.deps,
        classifySettings: vi.fn(
          async (_provider: string, settings: Record<string, string>) => settings,
        ),
        prepareConnection: vi.fn(
          async (input: {
            provider: string;
            settings: Record<string, string>;
            credentials: Record<string, string>;
          }) => ({
            provider: input.provider,
            settings: input.settings,
            credentials: input.credentials,
          }),
        ),
      },
    };
  }

  it("requires ownership before exposing unsupported scope validation", async () => {
    const { deps } = offlineDeps({ spaceOwner: false });
    await expect(
      persistMemoryProviderConfig(deps, actor, {
        ...sharedInput(),
        defaultMemoryScope: "isolated",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deps.prepareConnection).not.toHaveBeenCalled();
  });

  it("never returns credential-bearing probe errors", async () => {
    const { deps } = offlineDeps();
    deps.prepareConnection.mockRejectedValueOnce(new Error("remote echoed fake-token"));
    await expect(
      persistMemoryProviderConfig(deps, actor, { ...sharedInput(), confirmSharedScope: true }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Could not connect memory provider. Check the endpoint and credentials.",
    });
  });

  it("serializes pure optional capability metadata", () => {
    expect(
      serializeSpaceMemoryConfig({
        provider: "rembric",
        settings: {},
        defaultMemoryScope: "shared",
        updatedAt: new Date(0),
      }),
    ).toMatchObject({ capabilities: { isolatedScope: false } });
    expect(
      serializeSpaceMemoryConfig({
        provider: "supermemory",
        settings: {},
        defaultMemoryScope: "isolated",
        updatedAt: new Date(0),
      }),
    ).not.toHaveProperty("capabilities");
  });

  it("passes only the actor's trusted Space after spreading input", async () => {
    const { deps } = offlineDeps();
    const untrustedInput = {
      ...sharedInput(),
      confirmSharedScope: true,
      spaceId: "untrusted-space",
    };
    await persistMemoryProviderConfig(deps, actor, untrustedInput);
    expect(deps.prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: actor.spaceId }),
    );
  });

  it("rejects an unsupported isolated default before classification, probes or secrets", async () => {
    const { deps } = offlineDeps();
    await expect(
      persistMemoryProviderConfig(deps, actor, {
        ...sharedInput(),
        defaultMemoryScope: "isolated",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deps.classifySettings).not.toHaveBeenCalled();
    expect(deps.prepareConnection).not.toHaveBeenCalled();
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it.each([undefined, "isolated"])(
    "requires inherited-scope confirmation (prior=%s)",
    async (scope) => {
      const { deps, upsert } = offlineDeps({
        existing: scope ? { id: "cfg", secretId: "old", defaultMemoryScope: scope } : null,
      });
      await expect(persistMemoryProviderConfig(deps, actor, sharedInput())).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "accepts shared with confirmation, or an already shared default (%s)",
    async (alreadyShared) => {
      const { deps, upsert } = offlineDeps({
        existing: alreadyShared
          ? { id: "cfg", secretId: "old", defaultMemoryScope: "shared" }
          : null,
      });
      await persistMemoryProviderConfig(deps, actor, {
        ...sharedInput(),
        confirmSharedScope: !alreadyShared,
      });
      expect(upsert).toHaveBeenCalled();
    },
  );

  it("refuses all explicit isolated overrides, without filtering archived bots or members", async () => {
    const { deps, upsert } = offlineDeps({ isolatedBot: true });
    await expect(
      persistMemoryProviderConfig(deps, actor, { ...sharedInput(), confirmSharedScope: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deps.prisma.bot.findFirst).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId, memoryScope: "isolated" },
      select: { id: true },
    });
    expect(upsert).not.toHaveBeenCalled();
  });

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
    ).rejects.toThrow("Check the endpoint and credentials");
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
    ).rejects.toThrow("Check the endpoint and credentials");
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
    ).rejects.toThrow("Check the endpoint and credentials");
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
      isolationLevel: "ReadCommitted",
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
  it("rejects isolated defaults on a shared-only provider inside the scope transaction", async () => {
    const { deps, update, transaction } = makeDeps({
      existing: { id: "cfg", secretId: "old", provider: "rembric", defaultMemoryScope: "shared" },
    });
    await expect(updateMemoryProviderDefaultScope(deps, actor, "isolated")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(update).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
  });

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
