import { describe, expect, it, vi } from "vitest";
import { persistSupermemoryConfig } from "./router.js";

const actor = { userId: "user-1", workspaceId: "ws-1", email: "a@b.com", isDeploymentOwner: false };

function makeDeps(
  overrides: {
    existing?: { id: string; secretId: string } | null;
    upsertResult?: { mode: string; baseUrl: string; defaultMemoryScope: string; updatedAt: Date };
    workspaceOwner?: boolean;
  } = {},
) {
  const secretCreate = vi.fn().mockResolvedValue({ id: "secret-new" });
  const secretDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const findUnique = vi.fn().mockResolvedValue(overrides.existing ?? null);
  const upsert = vi.fn().mockResolvedValue(
    overrides.upsertResult ?? {
      mode: "cloud",
      baseUrl: "https://api.supermemory.ai",
      defaultMemoryScope: "isolated",
      updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    },
  );
  const prisma = {
    member: {
      findFirst: vi
        .fn()
        .mockResolvedValue(overrides.workspaceOwner === false ? null : { id: "m-1" }),
    },
    workspaceMemoryConfig: { findUnique, upsert },
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
    transaction: prisma.$transaction,
  };
}

describe("persistSupermemoryConfig", () => {
  it("rejects non-owners before probing or writing workspace configuration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps({ workspaceOwner: false });

    await expect(
      persistSupermemoryConfig(deps as never, actor, {
        mode: "cloud",
        apiKey: "sm_test_key_12345",
        defaultMemoryScope: "isolated",
      }),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects local mode without a baseUrl, without touching the database", async () => {
    const { deps, upsert } = makeDeps();
    await expect(
      persistSupermemoryConfig(deps as never, actor, {
        mode: "local",
        apiKey: "sm_test_key_12345",
        defaultMemoryScope: "isolated",
      }),
    ).rejects.toThrow(/baseUrl/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback baseUrl in local mode without probing or touching the database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, upsert } = makeDeps();
    await expect(
      persistSupermemoryConfig(deps as never, actor, {
        mode: "local",
        apiKey: "sm_test_key_12345",
        baseUrl: "http://169.254.169.254/latest/meta-data/",
        defaultMemoryScope: "isolated",
      }),
    ).rejects.toThrow(/loopback/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("probes before persisting, and rejects (without writing) when the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const { deps, upsert } = makeDeps();
    await expect(
      persistSupermemoryConfig(deps as never, actor, {
        mode: "local",
        apiKey: "sm_bad_key",
        baseUrl: "http://localhost:6767",
        defaultMemoryScope: "isolated",
      }),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("connects cloud mode, defaulting the base URL, and returns the serialized config", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const { deps, upsert, transaction } = makeDeps();
    const result = await persistSupermemoryConfig(deps as never, actor, {
      mode: "cloud",
      apiKey: "sm_test_key_12345",
      defaultMemoryScope: "isolated",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
        create: expect.objectContaining({ mode: "cloud", baseUrl: "https://api.supermemory.ai" }),
      }),
    );
    expect(result).toEqual({
      mode: "cloud",
      baseUrl: "https://api.supermemory.ai",
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
    await persistSupermemoryConfig(deps as never, actor, {
      mode: "cloud",
      apiKey: "sm_new_key_12345",
      defaultMemoryScope: "isolated",
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
    vi.unstubAllGlobals();
  });
});
