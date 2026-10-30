import { describe, expect, it, vi } from "vitest";
import {
  BotRuntimeProfileConflictError,
  listBotRuntimeProfileRevisions,
  readBotRuntimeProfile,
  readBotRuntimeProfileRevision,
  writeBotRuntimeProfile,
} from "./bot-runtime-profiles.js";
import { IsolationError } from "./scope.js";

describe("bot runtime profiles", () => {
  it("authorizes scoped reads and represents legacy profiles as absent", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "bot-1" });
    const findUnique = vi.fn().mockResolvedValue(null);
    const prisma = { bot: { findFirst }, botRuntimeProfile: { findUnique } };

    await expect(
      readBotRuntimeProfile(prisma as never, {
        botId: "bot-1",
        spaceId: "space-1",
        userId: "user-1",
      }),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bot-1", spaceId: "space-1", userId: "user-1" },
      select: { id: true },
    });
  });

  it("does not disclose profiles outside the supplied owner scope", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const findUnique = vi.fn();
    await expect(
      readBotRuntimeProfile({ bot: { findFirst }, botRuntimeProfile: { findUnique } } as never, {
        botId: "bot-1",
        spaceId: "space-1",
        userId: "other-user",
      }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("lists revision snapshots in descending order with a cursor and page limit", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "bot-1" });
    const findMany = vi.fn().mockResolvedValue([{ revision: 4 }, { revision: 3 }]);
    const prisma = {
      bot: { findFirst },
      botRuntimeProfileRevision: { findMany },
    };
    await expect(
      listBotRuntimeProfileRevisions(
        prisma as never,
        { botId: "bot-1", spaceId: "space-1", userId: "user-1" },
        { limit: 2, beforeRevision: 5 },
      ),
    ).resolves.toEqual([{ revision: 4 }, { revision: 3 }]);
    expect(findMany).toHaveBeenCalledWith({
      where: { botId: "bot-1", revision: { lt: 5 } },
      orderBy: { revision: "desc" },
      take: 2,
    });
  });

  it("does not query revision content for another owner", async () => {
    const findMany = vi.fn();
    const findUnique = vi.fn();
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue(null) },
      botRuntimeProfileRevision: { findMany, findUnique },
    };
    const scope = { botId: "bot-1", spaceId: "space-1", userId: "wrong-user" };
    await expect(
      listBotRuntimeProfileRevisions(prisma as never, scope, { limit: 10 }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(readBotRuntimeProfileRevision(prisma as never, scope, 1)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([0, -1, 51, 1.5])("rejects invalid revision page limit %s", async (limit) => {
    const findFirst = vi.fn();
    await expect(
      listBotRuntimeProfileRevisions(
        { bot: { findFirst } } as never,
        { botId: "bot-1", spaceId: "space-1", userId: "user-1" },
        { limit },
      ),
    ).rejects.toThrow(RangeError);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("reads a full revision snapshot only for an owned bot", async () => {
    const snapshot = { botId: "bot-1", revision: 2, settings: { value: "snapshot" } };
    const findUnique = vi.fn().mockResolvedValue(snapshot);
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1" }) },
      botRuntimeProfileRevision: { findUnique },
    };
    await expect(
      readBotRuntimeProfileRevision(
        prisma as never,
        { botId: "bot-1", spaceId: "space-1", userId: "user-1" },
        2,
      ),
    ).resolves.toEqual(snapshot);
    expect(findUnique).toHaveBeenCalledWith({
      where: { botId_revision: { botId: "bot-1", revision: 2 } },
    });
  });

  it("locks the authorized bot before first creation and stores the revision snapshot", async () => {
    const calls: string[] = [];
    const tx = {
      $queryRaw: vi.fn().mockImplementation(async () => {
        calls.push("lock");
        return [{ id: "bot-1" }];
      }),
      botRuntimeProfile: {
        findUnique: vi.fn().mockImplementation(async () => {
          calls.push("read");
          return null;
        }),
        create: vi.fn().mockImplementation(async ({ data }) => {
          calls.push("profile");
          return data;
        }),
        update: vi.fn(),
        revisions: undefined,
      },
      botRuntimeProfileRevision: {
        create: vi.fn().mockImplementation(async ({ data }) => {
          calls.push("revision");
          return data;
        }),
      },
    };
    const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) };
    const settings = { persona: "Distinct" };

    await expect(
      writeBotRuntimeProfile(prisma as never, {
        botId: "bot-1",
        spaceId: "space-1",
        userId: "user-1",
        expectedRevision: 0,
        settings,
        reason: "Initial profile",
      }),
    ).resolves.toMatchObject({ revision: 1, settings });

    expect(calls).toEqual(["lock", "read", "profile", "revision"]);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.botRuntimeProfileRevision.create).toHaveBeenCalledWith({
      data: {
        botId: "bot-1",
        revision: 1,
        settings,
        actorUserId: "user-1",
        reason: "Initial profile",
      },
    });
  });

  it("rejects unauthorized writes before reading or changing profile data", async () => {
    const profileRead = vi.fn();
    const profileCreate = vi.fn();
    const revisionCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      botRuntimeProfile: {
        findUnique: profileRead,
        create: profileCreate,
        update: vi.fn(),
      },
      botRuntimeProfileRevision: { create: revisionCreate },
    };
    const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) };

    await expect(
      writeBotRuntimeProfile(prisma as never, {
        botId: "bot-1",
        spaceId: "wrong-space",
        userId: "user-1",
        expectedRevision: 0,
        settings: { mode: "test" },
        reason: "Unauthorized",
      }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(profileRead).not.toHaveBeenCalled();
    expect(profileCreate).not.toHaveBeenCalled();
    expect(revisionCreate).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid expected revision (%s) before starting a transaction",
    async (expectedRevision) => {
      const transaction = vi.fn();
      await expect(
        writeBotRuntimeProfile({ $transaction: transaction } as never, {
          botId: "bot-1",
          spaceId: "space-1",
          userId: "user-1",
          expectedRevision,
          settings: {},
          reason: "Valid reason",
        }),
      ).rejects.toThrow(RangeError);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["", "   ", "r".repeat(501)])(
    "rejects an invalid revision reason before starting a transaction",
    async (reason) => {
      const transaction = vi.fn();
      await expect(
        writeBotRuntimeProfile({ $transaction: transaction } as never, {
          botId: "bot-1",
          spaceId: "space-1",
          userId: "user-1",
          expectedRevision: 0,
          settings: {},
          reason,
        }),
      ).rejects.toThrow(TypeError);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it("rejects settings larger than 128 KiB before starting a transaction", async () => {
    const transaction = vi.fn();
    await expect(
      writeBotRuntimeProfile({ $transaction: transaction } as never, {
        botId: "bot-1",
        spaceId: "space-1",
        userId: "user-1",
        expectedRevision: 0,
        settings: { payload: "x".repeat(128 * 1024) },
        reason: "Too large",
      }),
    ).rejects.toThrow("128 KiB");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects stale revisions without writing either record", async () => {
    const create = vi.fn();
    const revisionCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "bot-1" }]),
      botRuntimeProfile: {
        findUnique: vi.fn().mockResolvedValue({ revision: 3 }),
        create,
        update: vi.fn(),
      },
      botRuntimeProfileRevision: { create: revisionCreate },
    };
    const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) };

    await expect(
      writeBotRuntimeProfile(prisma as never, {
        botId: "bot-1",
        spaceId: "space-1",
        userId: "user-1",
        expectedRevision: 2,
        settings: { mode: "test" },
        reason: "Stale edit",
      }),
    ).rejects.toBeInstanceOf(BotRuntimeProfileConflictError);
    expect(create).not.toHaveBeenCalled();
    expect(revisionCreate).not.toHaveBeenCalled();
  });
});
