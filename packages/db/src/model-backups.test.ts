import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { listSpaceBackupModels, replaceSpaceBackupModels } from "./model-backups.js";

const scope = { userId: "user-a", spaceId: "space-one" };

describe("space backup models", () => {
  it("does not clear any backups if the owning membership is missing", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      spaceBackupModel: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    await expect(
      replaceSpaceBackupModels({ $transaction: transaction } as unknown as PrismaClient, scope, []),
    ).rejects.toThrow("Space membership not found");
    expect(tx.spaceBackupModel.deleteMany).not.toHaveBeenCalled();
    expect(tx.spaceBackupModel.createMany).not.toHaveBeenCalled();
  });

  it("locks the owning membership before reading or replacing an empty list", async () => {
    const lock = vi.fn().mockResolvedValue([{ locked: 1 }]);
    const remove = vi.fn();
    const tx = { $queryRaw: lock, spaceBackupModel: { deleteMany: remove, createMany: vi.fn() } };
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    await replaceSpaceBackupModels(
      { $transaction: transaction } as unknown as PrismaClient,
      scope,
      [],
    );
    expect(lock).toHaveBeenCalledWith(expect.any(Array), scope.spaceId, scope.userId);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
  });

  it("retries transaction conflicts during locked replacement", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      spaceBackupModel: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce({ code: "P2034" })
      .mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    await replaceSpaceBackupModels(
      { $transaction: transaction } as unknown as PrismaClient,
      scope,
      [],
    );
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
  });

  it("reads the persisted order only inside the current user and Space", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { provider: "provider-b", modelId: "model-b" },
      { provider: "provider-c", modelId: "model-c" },
    ]);
    const prisma = { spaceBackupModel: { findMany } } as unknown as PrismaClient;

    await expect(listSpaceBackupModels(prisma, scope)).resolves.toEqual([
      { provider: "provider-b", modelId: "model-b" },
      { provider: "provider-c", modelId: "model-c" },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: scope.userId, spaceId: scope.spaceId },
      orderBy: { position: "asc" },
      select: { provider: true, modelId: true },
    });
  });

  it("replaces one Space's list atomically and assigns contiguous positions", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      spaceBackupModel: { deleteMany, createMany },
    };
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    const prisma = { ...tx, $transaction: transaction } as unknown as PrismaClient;

    await replaceSpaceBackupModels(prisma, scope, [
      { provider: "provider-b", modelId: "model-b" },
      { provider: "provider-c", modelId: "model-c" },
    ]);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: scope });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { ...scope, provider: "provider-b", modelId: "model-b", position: 0 },
        { ...scope, provider: "provider-c", modelId: "model-c", position: 1 },
      ],
    });
  });

  it("clears only the scoped list when the user saves no backups", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const createMany = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      spaceBackupModel: { deleteMany, createMany },
    };
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    const prisma = { ...tx, $transaction: transaction } as unknown as PrismaClient;

    await replaceSpaceBackupModels(prisma, { userId: "user-b", spaceId: "space-two" }, []);

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "user-b", spaceId: "space-two" } });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("retries a locked replacement after a transaction conflict", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      spaceBackupModel: { deleteMany, createMany },
    };
    const conflict = { code: "P2034" };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    const prisma = { $transaction: transaction } as unknown as PrismaClient;

    await replaceSpaceBackupModels(prisma, scope, [{ provider: "provider-b", modelId: "model-b" }]);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
    expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ ...scope, provider: "provider-b", modelId: "model-b", position: 0 }],
    });
  });

  it("does not retry a replacement that fails for a non-conflict reason", async () => {
    const error = Object.assign(new Error("unique constraint"), { code: "P2002" });
    const transaction = vi.fn().mockRejectedValue(error);
    const prisma = { $transaction: transaction } as unknown as PrismaClient;

    await expect(
      replaceSpaceBackupModels(prisma, scope, [{ provider: "provider-b", modelId: "model-b" }]),
    ).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
  });
});
