import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import * as db from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnBot } from "./child-bots.js";

const input = {
  spawnedBy: { id: "parent", name: "Chief", userId: "user", spaceId: "source" },
  runId: "source-run",
  spawnKey: "approved-call",
  name: "Scout",
};
const source = {
  organizationId: "org",
  space: { id: "source", name: "Personal", deletingAt: null },
};
afterEach(() => vi.restoreAllMocks());

describe("spawn authorization boundaries", () => {
  it("never interprets a resolved destination ID as another space's name", async () => {
    const createBot = vi
      .fn()
      .mockResolvedValue({ id: "child", name: "Scout", title: "", threadId: "thread" });
    vi.spyOn(db, "createRepos").mockReturnValue({ createBot } as unknown as ReturnType<
      typeof db.createRepos
    >);
    const prisma = {
      spaceMember: {
        findUnique: vi.fn().mockResolvedValue(source),
        findMany: vi.fn().mockResolvedValue([
          {
            spaceId: "other",
            space: { id: "other", name: "approved-space-id", deletingAt: null },
          },
        ]),
      },
    } as unknown as PrismaClient;
    const result = await spawnBot(
      { prisma, jobs: { enqueue: vi.fn() } as unknown as JobPublisher },
      {
        ...input,
        targetSpace: "approved-space-id",
        resolvedTargetSpaceId: "approved-space-id",
      } as Parameters<typeof spawnBot>[1],
    );
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(createBot).not.toHaveBeenCalled();
  });

  it("does not queue a first task if destination access was revoked after bot creation", async () => {
    const createBot = vi
      .fn()
      .mockResolvedValue({ id: "child", name: "Scout", title: "", threadId: "thread" });
    vi.spyOn(db, "createRepos").mockReturnValue({ createBot } as unknown as ReturnType<
      typeof db.createRepos
    >);
    const message = vi.fn();
    const task = vi.fn().mockResolvedValue({ id: "task" });
    const run = vi.fn().mockResolvedValue({ id: "run" });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      spaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
      thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
      message: { create: message },
      task: { create: task },
      run: { create: run },
    };
    const prisma = {
      spaceMember: {
        findUnique: vi.fn().mockResolvedValue(source),
        findMany: vi
          .fn()
          .mockResolvedValue([
            { spaceId: "target", space: { id: "target", name: "Lab", deletingAt: null } },
          ]),
      },
      run: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (f: (tx: unknown) => unknown) => f(tx)),
    } as unknown as PrismaClient;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const result = await spawnBot(
      { prisma, jobs: { enqueue } as unknown as JobPublisher },
      {
        ...input,
        targetSpace: "Lab",
        prompt: "Start a harmless task",
      },
    );
    expect(result).toMatchObject({ error: expect.any(String), botId: "child" });
    expect(message).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
