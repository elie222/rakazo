import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { confirmSpawnedBotName, spawnBot } from "./child-bots.js";

describe("spawned bot creation", () => {
  it("returns the existing child when a spawn is retried", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: "child-1",
      name: "Scout",
      title: "Venue researcher",
      thread: { id: "thread-1" },
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      bot: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue({ id: "parent-1" }),
        findUnique,
      },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      run: { findUnique: vi.fn().mockResolvedValue({ id: "child-run-1" }) },
      $transaction: vi.fn().mockRejectedValue(new Error("unique spawn key")),
    } as unknown as PrismaClient;

    const result = await spawnBot(
      {
        prisma,
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
        spawnKey: "tool-call-1",
        name: " Scout ",
        title: "Ignored on a retry",
        prompt: "Do not enqueue this twice",
      },
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_spawnKey: {
          workspaceId: "workspace-1",
          spawnKey: "tool-call-1",
        },
      },
      include: { thread: true },
    });
    expect(result).toEqual({
      ok: true,
      duplicate: true,
      botId: "child-1",
      name: "Scout",
      title: "Venue researcher",
      threadId: "thread-1",
    });
    expect(enqueue).toHaveBeenCalledOnce();
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
