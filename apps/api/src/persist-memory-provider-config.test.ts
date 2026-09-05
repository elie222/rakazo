import { describe, expect, it, vi } from "vitest";
import { persistMemoryProviderConfig, updateMemoryProviderDefaultScope } from "./router.js";

const actor = {
  userId: "user-1",
  spaceId: "ws-1",
  email: "a@b.com",
  isDeploymentOwner: false,
};
const deploymentOwner = { ...actor, isDeploymentOwner: true };

function makeDeps(
  overrides: {
    existing?: { id: string; secretId: string } | null;
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
  const prisma = {
    spaceMember: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          overrides.spaceOwner === false ? null : { role: overrides.memberRole ?? "owner" },
        ),
    },
    spaceMemoryConfig: { findUnique, update, upsert },
    secret: { create: secretCreate, deleteMany: secretDeleteMany },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const deps = {
    prisma,
    secrets: { put: vi.fn().mockResolvedValue({ id: "secret-new", ciphertext: "cipher" }) },
  };
  return {
    deps,
    secretCreate,
    secretDeleteMany,
    findUnique,
    upsert,
    update,
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
  it("rejects unknown providers as bad requests without probing or writing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps();
    try {
      await expect(
        persistMemoryProviderConfig(deps as never, actor, {
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
    "rejects ambiguous local URLs even for the deployment owner: %s",
    async (suffix) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { deps, transaction } = makeDeps();
      try {
        await expect(
          persistMemoryProviderConfig(
            deps as never,
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

  it.each(["http://127.0.0.1:8123/internal-action#", "http://localhost:6767"])(
    "rejects ordinary Space owners before any local probe or write: %s",
    async (baseUrl) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("[]"));
      vi.stubGlobal("fetch", fetchMock);
      const { deps, transaction } = makeDeps();
      try {
        await expect(
          persistMemoryProviderConfig(deps as never, actor, connectionInput("local", baseUrl)),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deps.secrets.put).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("still requires Space ownership for a deployment owner", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps({ spaceOwner: false });
    try {
      await expect(
        persistMemoryProviderConfig(
          deps as never,
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
      persistMemoryProviderConfig(deps as never, actor, connectionInput("cloud")),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects local mode without a baseUrl, without touching the database", async () => {
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(deps as never, deploymentOwner, connectionInput("local")),
    ).rejects.toThrow(/baseUrl/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback baseUrl in local mode without probing or touching the database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        deps as never,
        deploymentOwner,
        connectionInput("local", "http://169.254.169.254/latest/meta-data/"),
      ),
    ).rejects.toThrow(/loopback/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("probes before persisting, and rejects (without writing) when the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const { deps, upsert } = makeDeps();
    await expect(
      persistMemoryProviderConfig(deps as never, deploymentOwner, {
        ...connectionInput("local", "http://localhost:6767"),
        credentials: { apiKey: "sm_bad_key" },
      }),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("accepts a bracketed IPv6 loopback base URL in local mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps();

    await persistMemoryProviderConfig(
      deps as never,
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
    const result = await persistMemoryProviderConfig(
      deps as never,
      actor,
      connectionInput("cloud"),
    );
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
    await persistMemoryProviderConfig(deps as never, actor, {
      ...connectionInput("cloud"),
      credentials: { apiKey: "sm_new_key_12345" },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
    vi.unstubAllGlobals();
  });
});

describe("updateMemoryProviderDefaultScope", () => {
  it("accepts owners with additional Better Auth roles", async () => {
    const { deps, update } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-existing" },
      memberRole: "owner,admin",
    });

    await updateMemoryProviderDefaultScope(deps as never, actor, "shared");

    expect(update).toHaveBeenCalled();
  });

  it("updates only the generic scope setting and retains the provider secret", async () => {
    const { deps, update, secretCreate, secretDeleteMany } = makeDeps({
      existing: { id: "cfg-1", secretId: "secret-existing" },
    });

    const result = await updateMemoryProviderDefaultScope(deps as never, actor, "shared");

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

    await expect(
      updateMemoryProviderDefaultScope(deps as never, actor, "shared"),
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});
