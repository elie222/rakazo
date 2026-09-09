import { describe, expect, it, vi, afterEach } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  ComputerLimitError,
  assertComputerQuotaForRestore,
  ensureComputerRecord,
  resolveMaxComputersPerUser,
} from "./computers.js";

function fakePrisma(count = 0, existing = false) {
  return {
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
