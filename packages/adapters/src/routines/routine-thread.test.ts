import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { routineGroupThreadId } from "./routine-thread.js";

function prismaFinding(found: { id: string } | null) {
  const findFirst = vi.fn(async () => found);
  return {
    findFirst,
    prisma: { thread: { findFirst } } as unknown as Pick<PrismaClient, "thread">,
  };
}

describe("routineGroupThreadId", () => {
  it("looks up nothing for a routine without a thread", async () => {
    const { findFirst, prisma } = prismaFinding({ id: "unused" });
    await expect(
      routineGroupThreadId(prisma, { threadId: null, spaceId: "space-1" }, "bot-1"),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("accepts only the bot's own thread or a live group the bot belongs to, in the routine's Space", async () => {
    const { findFirst, prisma } = prismaFinding({ id: "group-thread" });
    await expect(
      routineGroupThreadId(prisma, { threadId: "group-thread", spaceId: "space-1" }, "bot-1"),
    ).resolves.toBe("group-thread");
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "group-thread",
        spaceId: "space-1",
        OR: [
          { botId: "bot-1" },
          { group: { archivedAt: null, members: { some: { botId: "bot-1" } } } },
        ],
      },
      select: { id: true },
    });
  });

  it("is null when the thread no longer qualifies", async () => {
    const { prisma } = prismaFinding(null);
    await expect(
      routineGroupThreadId(prisma, { threadId: "gone", spaceId: "space-1" }, "bot-1"),
    ).resolves.toBeNull();
  });
});
