import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { IsolationError } from "./scope.js";

describe("archiveGroup", () => {
  const actor = {
    workspaceId: "workspace-1",
    userId: "user-1",
    email: "user@example.com",
    isDeploymentOwner: true,
  };
  let queryRaw: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let findManyRuns: ReturnType<typeof vi.fn>;
  let findManyComputers: ReturnType<typeof vi.fn>;
  let runUpdateMany: ReturnType<typeof vi.fn>;
  let attemptUpdateMany: ReturnType<typeof vi.fn>;
  let taskUpdateMany: ReturnType<typeof vi.fn>;
  let leaseDeleteMany: ReturnType<typeof vi.fn>;
  let computerUpdateMany: ReturnType<typeof vi.fn>;
  let eventDeleteMany: ReturnType<typeof vi.fn>;
  let groupUpdate: ReturnType<typeof vi.fn>;
  let prisma: PrismaClient;

  beforeEach(() => {
    queryRaw = vi.fn().mockResolvedValue([{ id: "group-1" }]);
    findFirst = vi.fn().mockResolvedValue({ thread: { id: "thread-1" } });
    findManyRuns = vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]);
    findManyComputers = vi.fn().mockResolvedValue([
      {
        homeKey: "home-1",
        kind: "fake",
        providerRef: "computer-1",
        executionBotId: "bot-1",
      },
    ]);
    runUpdateMany = vi.fn();
    attemptUpdateMany = vi.fn();
    taskUpdateMany = vi.fn();
    leaseDeleteMany = vi.fn();
    computerUpdateMany = vi.fn();
    eventDeleteMany = vi.fn();
    groupUpdate = vi.fn();
    const tx = {
      $queryRaw: queryRaw,
      chatGroup: { findFirst, update: groupUpdate },
      run: { findMany: findManyRuns, updateMany: runUpdateMany },
      attempt: { updateMany: attemptUpdateMany },
      task: { updateMany: taskUpdateMany },
      computerExecutionLease: { deleteMany: leaseDeleteMany },
      computer: { findMany: findManyComputers, updateMany: computerUpdateMany },
      event: { deleteMany: eventDeleteMany },
    };
    prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
  });

  it("locks the group, archives it, and cancels only that thread's runs", async () => {
    const repos = createGroupRepos(prisma);

    await expect(repos.archiveGroup(actor, "group-1")).resolves.toEqual({
      cancelledRunIds: ["run-1"],
      computers: [
        {
          homeKey: "home-1",
          kind: "fake",
          providerRef: "computer-1",
          executionBotId: "bot-1",
        },
      ],
    });

    expect(queryRaw).toHaveBeenCalled();
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1" }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "group-1",
          archivedAt: null,
        }),
      }),
    );
    expect(leaseDeleteMany).toHaveBeenCalledWith({ where: { runId: { in: ["run-1"] } } });
    expect(computerUpdateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    expect(groupUpdate).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: expect.objectContaining({ pinned: false, archivedAt: expect.any(Date) }),
    });
  });

  it("rejects when the group is already archived or missing", async () => {
    findFirst.mockResolvedValue(null);
    const repos = createGroupRepos(prisma);
    await expect(repos.archiveGroup(actor, "group-1")).rejects.toBeInstanceOf(IsolationError);
    expect(groupUpdate).not.toHaveBeenCalled();
  });
});
