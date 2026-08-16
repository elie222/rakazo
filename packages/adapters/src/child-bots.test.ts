import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { confirmSpawnedBotName, spawnBot } from "./child-bots.js";

describe("spawned bot creation", () => {
  it("returns the existing child when a spawn is retried", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "child-1",
      name: "Scout",
      title: "Venue researcher",
      thread: { id: "thread-1" },
    });
    const enqueue = vi.fn();

    const result = await spawnBot(
      {
        prisma: { bot: { findFirst } } as unknown as PrismaClient,
        jobs: { enqueue } as unknown as JobPublisher,
      },
      {
        spawnedBy: {
          id: "parent-1",
          name: "Chief",
          workspaceId: "workspace-1",
          userId: "user-1",
        },
        runId: "run-retry",
        name: " Scout ",
        title: "Ignored on a retry",
        prompt: "Do not enqueue this twice",
      },
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        userId: "user-1",
        parentBotId: "parent-1",
        name: "Scout",
      },
      include: { thread: true },
      orderBy: { createdAt: "asc" },
    });
    expect(result).toEqual({
      ok: true,
      duplicate: true,
      botId: "child-1",
      name: "Scout",
      title: "Venue researcher",
      threadId: "thread-1",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("spawned bot deletion", () => {
  it("refuses when confirm_name does not match exactly", () => {
    expect(confirmSpawnedBotName("scout", "Scout")).toMatchObject({ ok: false });
    expect(confirmSpawnedBotName("Scout ", "Scout")).toMatchObject({ ok: false });
  });

  it("accepts an exact name match", () => {
    expect(confirmSpawnedBotName("Scout", "Scout")).toEqual({ ok: true });
  });
});
