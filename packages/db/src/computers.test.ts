import { describe, expect, it, vi, afterEach } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  ComputerLimitError,
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
