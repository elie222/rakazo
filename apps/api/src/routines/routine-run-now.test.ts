import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterContext } from "../routes/context.js";
import { routineRunNowTarget } from "./routines.js";

const actor = { spaceId: "space-1", userId: "user-1", email: "a@example.test" } as Actor;

function setup(routine: { threadId: string | null }, groupThread: { id: string } | null) {
  const prisma = {
    routine: {
      findFirst: vi.fn(async () => ({
        id: "routine-1",
        botId: "bot-1",
        spaceId: "space-1",
        ...routine,
      })),
    },
    thread: { findFirst: vi.fn(async () => groupThread) },
  } as unknown as PrismaClient;
  const repos = {
    getBot: vi.fn(async () => ({ id: "bot-1", thread: { id: "bot-thread" } })),
  } as unknown as RouterContext["repos"];
  return { prisma, repos };
}

describe("routineRunNowTarget", () => {
  it("runs a group routine in its group chat", async () => {
    const { prisma, repos } = setup({ threadId: "group-thread" }, { id: "group-thread" });
    await expect(routineRunNowTarget(prisma, repos, actor, "routine-1")).resolves.toMatchObject({
      botId: "bot-1",
      threadId: "group-thread",
    });
  });

  it("falls back to the bot's chat when the group is archived or the bot left it", async () => {
    const { prisma, repos } = setup({ threadId: "group-thread" }, null);
    await expect(routineRunNowTarget(prisma, repos, actor, "routine-1")).resolves.toMatchObject({
      threadId: "bot-thread",
    });
  });

  it("keeps the bot's chat for a routine without a thread", async () => {
    const { prisma, repos } = setup({ threadId: null }, { id: "unused" });
    await expect(routineRunNowTarget(prisma, repos, actor, "routine-1")).resolves.toMatchObject({
      threadId: "bot-thread",
    });
    expect(prisma.thread.findFirst).not.toHaveBeenCalled();
  });
});
