import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  archiveBot,
  archiveSpawnedBot,
  confirmSpawnedBotName,
  destroyBot,
  spawnBot,
} from "./child-bots.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

function noGroupMemberships() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    chatGroup: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    chatGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

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
          spaceId: "workspace-1",
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
        spaceId_spawnKey: {
          spaceId: "workspace-1",
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
describe("spawned bot archival", () => {
  it("refuses when confirm_name does not match exactly", () => {
    expect(confirmSpawnedBotName("scout", "Scout")).toMatchObject({ ok: false });
    expect(confirmSpawnedBotName("Scout ", "Scout")).toMatchObject({ ok: false });
  });

  it("accepts an exact name match", () => {
    expect(confirmSpawnedBotName("Scout", "Scout")).toEqual({ ok: true });
  });

  it("reconciles a retry when the child is already archived", async () => {
    const archivedAt = new Date("2026-08-16T12:00:00.000Z");
    const prisma = {
      bot: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "child-1",
            spaceId: "workspace-1",
            userId: "user-1",
            parentBotId: "parent-1",
            name: "Scout",
            archivedAt,
          },
        ]),
      },
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback({
          ...noGroupMemberships(),
          run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          routine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          bot: { update: vi.fn().mockResolvedValue({}) },
        }),
      ),
    } as unknown as PrismaClient;

    await expect(
      archiveSpawnedBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: {} as AgentHomeStore,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          spawnedByBotId: "parent-1",
          userId: "user-1",
          spaceId: "workspace-1",
          confirmName: "Scout",
          botId: "child-1",
        },
        context,
      ),
    ).resolves.toMatchObject({ ok: true, botId: "child-1", name: "Scout" });
  });
});

describe("destroyBot", () => {
  it("moves bot memories into shared memory before the cascading delete", async () => {
    const createDeletion = vi.fn().mockResolvedValue({});
    const deleteBot = vi.fn().mockResolvedValue({});
    const executeRaw = vi.fn().mockResolvedValue(1);
    const releaseComputers = vi.fn().mockResolvedValue({ count: 1 });
    const removeArtifact = vi.fn().mockResolvedValue(undefined);
    const findArtifacts = vi.fn().mockResolvedValue([{ storageKey: "stored-artifact" }]);
    const deleteArtifacts = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
        chatGroup: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        artifact: { findMany: findArtifacts, deleteMany: deleteArtifacts },
        computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: { updateMany: releaseComputers },
        $executeRaw: executeRaw,
        botDeletion: { create: createDeletion },
        bot: { delete: deleteBot },
      }),
    );
    const prisma = {
      bot: {
        findUnique: vi.fn(),
      },
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await destroyBot(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        artifacts: { remove: removeArtifact } as unknown as ArtifactStore,
      },
      { id: "bot-1", spaceId: "workspace-1", name: "Researcher", archivedAt: null },
      context,
      { deleteMemories: false },
    );

    expect(transaction).toHaveBeenCalledOnce();
    expect(releaseComputers).toHaveBeenCalledWith({
      where: {
        OR: [{ controlBotId: "bot-1" }, { executionBotId: "bot-1" }],
      },
      data: expect.objectContaining({
        controlHolder: "none",
        controlBotId: null,
        executionBotId: null,
      }),
    });
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(executeRaw.mock.calls[0]?.slice(1)).toEqual([
      "Archived bots/Researcher (bot-1)",
      "bot-1",
    ]);
    expect(createDeletion).toHaveBeenCalledWith({
      data: {
        id: "bot-1",
        spaceId: "workspace-1",
        name: "Researcher",
        deletedByUserId: "user-1",
        memoriesPreserved: true,
      },
    });
    expect(deleteBot).toHaveBeenCalledWith({ where: { id: "bot-1" } });
    expect(findArtifacts).toHaveBeenCalledWith({
      where: { botId: "bot-1", groupId: null, spaceId: "workspace-1" },
      select: { storageKey: true },
    });
    expect(deleteArtifacts).toHaveBeenCalledWith({
      where: { botId: "bot-1", groupId: null, spaceId: "workspace-1" },
    });
    expect(deleteArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      deleteBot.mock.invocationCallOrder[0]!,
    );
    expect(removeArtifact).toHaveBeenCalledWith("stored-artifact", context);
  });

  it("dissolves groups with fewer than two active members after deleting the bot", async () => {
    const deleteGroups = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMemberships = vi.fn().mockResolvedValue({ count: 1 });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const cancelRuns = vi.fn().mockResolvedValue({ count: 1 });
    const cancelAttempts = vi.fn().mockResolvedValue({ count: 1 });
    const cancelTasks = vi.fn().mockResolvedValue({ count: 1 });
    const deleteExecutionLeases = vi.fn().mockResolvedValue({ count: 1 });
    const expireExecutionLeases = vi.fn().mockResolvedValue({ count: 1 });
    const clearExecution = vi.fn().mockResolvedValue({ count: 1 });
    const queryRaw = vi.fn().mockResolvedValue([{ id: "group-1" }, { id: "group-2" }]);
    const findRuns = vi.fn().mockResolvedValue([
      {
        id: "group-run",
        taskId: "group-task",
        botId: "bot-2",
        bot: {
          computer: { homeKey: "team-home", kind: "fake", providerRef: "screen-1" },
        },
      },
    ]);
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        $queryRaw: queryRaw,
        chatGroup: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "group-1",
              thread: { id: "thread-1" },
              members: [
                { botId: "bot-1", bot: { archivedAt: null } },
                { botId: "bot-2", bot: { archivedAt: null } },
              ],
            },
            {
              id: "group-2",
              thread: { id: "thread-2" },
              members: [
                { botId: "bot-1", bot: { archivedAt: null } },
                { botId: "bot-2", bot: { archivedAt: null } },
                { botId: "bot-3", bot: { archivedAt: null } },
              ],
            },
            {
              id: "group-3",
              thread: { id: "thread-3" },
              members: [
                { botId: "bot-1", bot: { archivedAt: null } },
                { botId: "bot-2", bot: { archivedAt: new Date() } },
                { botId: "bot-3", bot: { archivedAt: null } },
              ],
            },
          ]),
          deleteMany: deleteGroups,
        },
        run: {
          findMany: findRuns,
          updateMany: cancelRuns,
        },
        attempt: { updateMany: cancelAttempts },
        task: { updateMany: cancelTasks },
        chatGroupMember: { deleteMany: deleteMemberships },
        artifact: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        computerExecutionLease: {
          deleteMany: deleteExecutionLeases,
          updateMany: expireExecutionLeases,
        },
        computer: { updateMany: clearExecution },
        $executeRaw: vi.fn(),
        botDeletion: { create: vi.fn() },
        bot: { delete: vi.fn() },
      }),
    );
    const prisma = {
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await destroyBot(
      {
        prisma,
        sandbox: { releaseScreen } as unknown as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel } as unknown as JobPublisher,
      },
      { id: "bot-1", spaceId: "workspace-1", name: "Researcher", archivedAt: null },
      context,
      { deleteMemories: true },
    );

    expect(deleteGroups).toHaveBeenCalledWith({ where: { id: { in: ["group-1", "group-3"] } } });
    expect(deleteMemberships).toHaveBeenCalledWith({ where: { botId: "bot-1" } });
    expect(deleteMemberships.mock.invocationCallOrder[0]!).toBeLessThan(
      deleteGroups.mock.invocationCallOrder[0]!,
    );
    expect(queryRaw.mock.calls.some(([query]) => String(query).includes("FROM chat_groups"))).toBe(
      true,
    );
    expect(findRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: { in: ["thread-1", "thread-3"] },
        }),
      }),
    );
    expect(cancelRuns).toHaveBeenCalledWith({
      where: { id: { in: ["group-run"] } },
      data: {
        status: "cancelled",
        completedAt: expect.any(Date),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    expect(cancelAttempts).toHaveBeenCalledWith({
      where: { runId: { in: ["group-run"] }, status: "running" },
      data: { status: "cancelled", finishedAt: expect.any(Date) },
    });
    expect(cancelTasks).toHaveBeenCalledWith({
      where: { id: { in: ["group-task"] } },
      data: { status: "cancelled" },
    });
    expect(expireExecutionLeases).toHaveBeenCalledWith({
      where: { runId: { in: ["group-run"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(deleteExecutionLeases).toHaveBeenCalledWith({ where: { botId: "bot-1" } });
    expect(clearExecution).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["group-run"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    expect(cancel).toHaveBeenCalledWith("run:group-run");
    expect(releaseScreen).toHaveBeenCalledWith(
      { id: "screen-1", botId: "team-home", kind: "fake", providerRef: "screen-1" },
      expect.objectContaining({
        operationId: "destroy-group-run:bot-2",
        botId: "bot-2",
      }),
    );
  });

  it("surfaces transaction failures instead of reporting deletion success", async () => {
    const transaction = vi.fn().mockRejectedValue(new Error("delete failed"));
    const prisma = {
      bot: {
        findUnique: vi.fn(),
      },
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await expect(
      destroyBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: {} as AgentHomeStore,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
          dataDir: "/tmp/rakazo-destroy-bot-test",
        },
        { id: "bot-1", spaceId: "workspace-1", name: "Researcher", archivedAt: null },
        context,
        { deleteMemories: true },
      ),
    ).rejects.toThrow("delete failed");
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("retries retryable transaction conflicts during deletion", async () => {
    const conflict = Object.assign(new Error("deadlock"), {
      code: "P2039",
      meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
    });
    const finalError = new Error("second attempt reached");
    const transaction = vi.fn().mockRejectedValueOnce(conflict).mockRejectedValueOnce(finalError);
    const prisma = {
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await expect(
      destroyBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: {} as AgentHomeStore,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        { id: "bot-1", spaceId: "workspace-1", name: "Researcher", archivedAt: null },
        context,
        { deleteMemories: true },
      ),
    ).rejects.toBe(finalError);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});

describe("archiveBot", () => {
  it("stops work and routines while preserving the bot", async () => {
    const updateBot = vi.fn().mockResolvedValue({});
    const disableRoutines = vi.fn().mockResolvedValue({ count: 2 });
    const groupCleanup = noGroupMemberships();
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        ...groupCleanup,
        run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        routine: { updateMany: disableRoutines },
        computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        bot: { update: updateBot },
      }),
    );
    const cancel = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      bot: {
        findUnique: vi.fn().mockResolvedValue({
          id: "bot-1",
          spaceId: "workspace-1",
          archivedAt: null,
        }),
      },
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: { findMany: vi.fn().mockResolvedValue([{ id: "run-1" }]) },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await archiveBot(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel } as unknown as JobPublisher,
      },
      { id: "bot-1", spaceId: "workspace-1", name: "Researcher", archivedAt: null },
      context,
    );

    expect(disableRoutines).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      data: { active: false, nextRunAt: null },
    });
    expect(updateBot).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { archivedAt: expect.any(Date), pinned: false },
    });
    expect(groupCleanup.$queryRaw).not.toHaveBeenCalled();
    expect(groupCleanup.chatGroup.deleteMany).not.toHaveBeenCalled();
    expect(groupCleanup.chatGroupMember.deleteMany).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("run:run-1");
  });

  it("surfaces computer stop failures and leaves the provider state retryable", async () => {
    const archivedAt = new Date("2026-08-16T12:00:00.000Z");
    const updateComputer = vi.fn().mockResolvedValue({});
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        ...noGroupMemberships(),
        run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        routine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        bot: { update: vi.fn().mockResolvedValue({}) },
      }),
    );
    const dedicated = {
      id: "computer-1",
      homeKey: "bot-1",
      kind: "cloud",
      providerRef: "provider-1",
      state: "running",
    };
    const stop = vi.fn().mockRejectedValue(new Error("stop failed"));
    const prisma = {
      computer: {
        findUnique: vi.fn().mockResolvedValue(dedicated),
        update: updateComputer,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;
    const sandbox = {
      exportWorkspace: async function* () {},
      stop,
    } as unknown as SandboxProvider;
    const home = {
      commit: vi.fn().mockResolvedValue("revision-1"),
    } as unknown as AgentHomeStore;

    await expect(
      archiveBot(
        {
          prisma,
          sandbox,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        { id: "bot-1", spaceId: "workspace-1", name: "Researcher", archivedAt },
        context,
      ),
    ).rejects.toThrow("stop failed");

    expect(stop).toHaveBeenCalledOnce();
    expect(updateComputer).not.toHaveBeenCalled();
  });

  it("stops a provider that finishes booting while the bot is archived", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const booting = {
      id: "computer-1",
      homeKey: "bot-1",
      kind: "cloud",
      providerRef: null,
      state: "booting",
    };
    const running = { ...booting, providerRef: "provider-1", state: "running" };
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        ...noGroupMemberships(),
        run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        routine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        bot: { update: vi.fn().mockResolvedValue({}) },
      }),
    );
    const prisma = {
      computer: {
        findUnique: vi.fn().mockResolvedValueOnce(booting).mockResolvedValueOnce(running),
        updateMany,
      },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;
    const sandbox = {
      exportWorkspace: async function* () {},
      stop,
    } as unknown as SandboxProvider;
    const home = {
      commit: vi.fn().mockResolvedValue("revision-1"),
    } as unknown as AgentHomeStore;

    await archiveBot(
      {
        prisma,
        sandbox,
        home,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      },
      { id: "bot-1", spaceId: "workspace-1", name: "Researcher", archivedAt: null },
      context,
    );

    expect(stop).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "computer-1", state: "running", providerRef: "provider-1" },
      data: { state: "stopped" },
    });
  });
});
