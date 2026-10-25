import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { clearEndedRunState } from "./run-secrets.js";

describe("clearEndedRunState", () => {
  it("drops each cancelled run's checkpoint and waiting one-time answer", async () => {
    const prisma = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 2 })) },
      run: {
        findMany: vi.fn(async () => [
          { id: "run-1", userId: "user-1", spaceId: "space-1" },
          { id: "run-2", userId: "user-2", spaceId: "space-1" },
        ]),
      },
      secret: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    };
    await clearEndedRunState(prisma as unknown as PrismaClient, ["run-1", "run-2"]);
    expect(prisma.externalEffect.deleteMany).toHaveBeenCalledOnce();
    // Each answer is matched under its own run's user and space, which the secrets index covers.
    expect(prisma.secret.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1", spaceId: "space-1", kind: "run-secret:run-1" },
          { userId: "user-2", spaceId: "space-1", kind: "run-secret:run-2" },
        ],
      },
    });
  });

  it("does nothing without runs", async () => {
    const prisma = {
      externalEffect: { deleteMany: vi.fn() },
      run: { findMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
    };
    await clearEndedRunState(prisma as unknown as PrismaClient, []);
    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(prisma.secret.deleteMany).not.toHaveBeenCalled();
  });
});
