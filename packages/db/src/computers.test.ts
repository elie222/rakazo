import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  assertComputerQuotaForRestore,
  ComputerLimitError,
  ensureComputerRecord,
  resolveMaxComputersPerUser,
} from "./computers.js";

function fakePrisma(count = 0, existing = false) {
  return {
    // Looks like a TransactionClient: $queryRaw present, no $transaction.
    $queryRaw: vi.fn(async () => [{ lock: "1" }]),
    computer: {
      findUnique: vi.fn(async () => (existing ? { id: "existing" } : null)),
      count: vi.fn(async () => count),
      upsert: vi.fn(async (args) => args.update as object),
    },
  } as unknown as PrismaClient;
}

function fakeRestorePrisma(results: { alreadyLive: number; inUse: number }) {
  const count = vi.fn(async (args: { where: { id?: string } }) =>
    args.where.id ? results.alreadyLive : results.inUse,
  );
  return {
    computer: { count },
  } as unknown as PrismaClient;
}

/**
 * Root PrismaClient mock whose $transaction + $queryRaw simulate a per-user
 * pg_advisory_xact_lock: concurrent quota transactions for the same user queue,
 * and creating a new computer increments the in-use count (as createBot /
 * setBotComputer do by linking a live bot in the same transaction).
 */
function fakeSerializingPrisma(initialInUse = 0) {
  const state = { inUse: initialInUse };
  const rows = new Map<string, { id: string }>();
  let locked = false;
  const waiters: Array<() => void> = [];

  async function acquireLock() {
    if (!locked) {
      locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    locked = true;
  }

  function releaseLock() {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    locked = false;
  }

  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      let held = false;
      const tx = {
        $queryRaw: vi.fn(async () => {
          if (!held) {
            await acquireLock();
            held = true;
          }
          return [{ lock: "1" }];
        }),
        computer: {
          findUnique: vi.fn(async (args: { where: { scopeKey: string } }) => {
            const row = rows.get(args.where.scopeKey);
            return row ? { id: row.id } : null;
          }),
          count: vi.fn(async () => state.inUse),
          upsert: vi.fn(async (args: { where: { scopeKey: string } }) => {
            const existing = rows.get(args.where.scopeKey);
            if (existing) return existing;
            const row = { id: `comp-${rows.size + 1}` };
            rows.set(args.where.scopeKey, row);
            // Same-transaction bot link makes the new row count as in-use.
            state.inUse += 1;
            return row;
          }),
        },
      };
      try {
        return await callback(tx);
      } finally {
        if (held) releaseLock();
      }
    }),
  } as unknown as PrismaClient;

  return { prisma, state };
}

const baseInput = {
  mode: "dedicated" as const,
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-4",
  kind: "docker",
};

const savedEnv = process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
  else process.env.SANDBOX_MAX_COMPUTERS_PER_USER = savedEnv;
  vi.restoreAllMocks();
});

describe("resolveMaxComputersPerUser", () => {
  it("treats unset, empty, and 0 as no configured cap", () => {
    expect(resolveMaxComputersPerUser(undefined)).toBe(0);
    expect(resolveMaxComputersPerUser("")).toBe(0);
    expect(resolveMaxComputersPerUser("0")).toBe(0);
    expect(resolveMaxComputersPerUser("  ")).toBe(0);
  });

  it("accepts positive integers and rejects anything else", () => {
    expect(resolveMaxComputersPerUser("3")).toBe(3);
    for (const value of ["-1", "1.5", "not-a-number"])
      expect(() => resolveMaxComputersPerUser(value)).toThrow(/positive integer/);
  });
});

describe("ensureComputerRecord", () => {
  it("enforces the cap for a new computer when the user is at the limit", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "2";
    const prisma = fakePrisma(2, false);
    await expect(ensureComputerRecord(prisma, { ...baseInput, botId: "bot-new" })).rejects.toThrow(
      ComputerLimitError,
    );
    expect(prisma.computer.upsert).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it("does not count archived-bot computers against the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const prisma = fakePrisma(0, false);
    await ensureComputerRecord(prisma, baseInput);
    expect(prisma.computer.upsert).toHaveBeenCalledOnce();
  });

  it("allows a team computer reuse even when the user is at the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const prisma = fakePrisma(1, true);
    await expect(
      ensureComputerRecord(prisma, { ...baseInput, mode: "team" }),
    ).resolves.toBeDefined();
  });

  it("does not enforce anything when the cap is unset", async () => {
    const prisma = fakePrisma(99, false);
    await ensureComputerRecord(prisma, baseInput);
    expect(prisma.computer.upsert).toHaveBeenCalledOnce();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("serializes parallel creates so concurrent callers cannot exceed the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { prisma, state } = fakeSerializingPrisma(0);

    const results = await Promise.allSettled([
      ensureComputerRecord(prisma, {
        ...baseInput,
        spaceId: "space-a",
        botId: "bot-a",
      }),
      ensureComputerRecord(prisma, {
        ...baseInput,
        spaceId: "space-b",
        botId: "bot-b",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toBeInstanceOf(
      ComputerLimitError,
    );
    expect(state.inUse).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

describe("assertComputerQuotaForRestore", () => {
  it("rejects the archive, create, restore bypass when the user is at the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    // The archived bot's computer has no live bot referencing it (alreadyLive=0)
    // and the user already has 1 in-use computer (the newly created bot's).
    const prisma = fakeRestorePrisma({ alreadyLive: 0, inUse: 1 });
    await expect(
      assertComputerQuotaForRestore(prisma, { userId: "user-1", computerId: "computer-a" }),
    ).rejects.toThrow(ComputerLimitError);
  });

  it("allows the restore when the user is below the cap", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const prisma = fakeRestorePrisma({ alreadyLive: 0, inUse: 0 });
    await expect(
      assertComputerQuotaForRestore(prisma, { userId: "user-1", computerId: "computer-a" }),
    ).resolves.toBeUndefined();
  });

  it("allows the restore when another live bot already references the computer", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    // Team computer shared by a still-live bot in the same space: restoring an
    // archived sibling bot adds nothing to the count, so it must not be refused.
    const prisma = fakeRestorePrisma({ alreadyLive: 1, inUse: 1 });
    await expect(
      assertComputerQuotaForRestore(prisma, { userId: "user-1", computerId: "team-computer" }),
    ).resolves.toBeUndefined();
  });

  it("does not enforce anything when the cap is unset", async () => {
    const prisma = fakeRestorePrisma({ alreadyLive: 0, inUse: 99 });
    await expect(
      assertComputerQuotaForRestore(prisma, { userId: "user-1", computerId: "computer-a" }),
    ).resolves.toBeUndefined();
  });
});
