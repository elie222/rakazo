import { execFileSync } from "node:child_process";
import type * as fsPromises from "node:fs/promises";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  CommandRequest,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import type { createRepos, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  archiveBot,
  archiveSpawnedBot,
  confirmSpawnedBotName,
  destroyBot,
  spawnBot,
} from "./child-bots.js";
import { BrowserStoppedReleaseError } from "./computer-screens.js";
import { LocalAgentHomeStore } from "./home.js";

const fsHooks = vi.hoisted(() => ({
  afterRealpath: undefined as ((resolved: string) => Promise<void>) | undefined,
}));

// Lets a test change the disk between a path check and the delete that follows it.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = await actual.realpath(...args);
      await fsHooks.afterRealpath?.(String(resolved));
      return resolved;
    },
  };
});

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

  it("passes computerMode through to createBot", async () => {
    const createBot = vi.fn().mockResolvedValue({
      id: "child-2",
      name: "Painter",
      title: "",
      threadId: "thread-2",
    });
    const createReposSpy = vi.spyOn(await import("@rakazo/db"), "createRepos").mockReturnValue({
      createBot,
    } as unknown as ReturnType<typeof createRepos>);

    const result = await spawnBot(
      {
        prisma: {} as PrismaClient,
        jobs: { enqueue: vi.fn() } as unknown as JobPublisher,
      },
      {
        spawnedBy: {
          id: "parent-1",
          name: "Chief",
          spaceId: "workspace-1",
          userId: "user-1",
        },
        runId: "run-1",
        spawnKey: "tool-call-2",
        name: "Painter",
        computerMode: "dedicated",
      },
    );

    expect(createBot).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", spaceId: "workspace-1" }),
      expect.objectContaining({
        name: "Painter",
        computerMode: "dedicated",
        parentBotId: "parent-1",
      }),
    );
    expect(result).toEqual({
      ok: true,
      botId: "child-2",
      name: "Painter",
      title: "",
      threadId: "thread-2",
    });
    createReposSpy.mockRestore();
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
        {
          id: "bot-1",
          userId: "user-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
        },
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

  it("stops the deleted team bot's screen and removes only its browser profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-delete-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const deletedProfile = path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"));
      const keptProfile = path.join(teamHome, ".browser-profiles", profileDirectory("bot-2"));
      const keptNotes = path.join(teamHome, "bots", "bot-2", "notes.txt");
      await mkdir(deletedProfile, { recursive: true });
      await mkdir(path.dirname(keptNotes), { recursive: true });
      await mkdir(keptProfile, { recursive: true });
      await writeFile(path.join(deletedProfile, "Cookies"), "gone");
      await writeFile(path.join(keptProfile, "Cookies"), "keep");
      await writeFile(keptNotes, "keep");
      const releaseScreen = vi.fn().mockResolvedValue(undefined);
      // A running Docker computer removes the profile inside its mounted home.
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(teamHome, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "running",
      };
      const prisma = deletionPrisma(team);

      await destroyBot(
        {
          prisma,
          sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        { ...context, botId: "parent-1", screenLeaseId: "run-parent:4" },
        { deleteMemories: true },
      );

      expect(releaseScreen).toHaveBeenCalledWith(
        {
          id: "container-1",
          botId: "team-workspace-1",
          kind: "docker",
          providerRef: "container-1",
        },
        expect.objectContaining({ botId: "bot-1", cancelRunWork: true }),
      );
      const releaseContext = releaseScreen.mock.calls[0]?.[1] as AdapterContext;
      expect(releaseContext.botId).toBe("bot-1");
      expect(releaseContext.screenLeaseId).toBeUndefined();
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "docker" }),
        {
          argv: [
            "bash",
            "-eu",
            "-c",
            expect.any(String),
            "bash",
            ".browser-profiles",
            profileDirectory("bot-1"),
          ],
          cwd: ".",
        },
        expect.objectContaining({ botId: "bot-1", screenLeaseId: undefined }),
      );
      await expect(access(deletedProfile)).rejects.toThrow();
      await expect(readFile(path.join(keptProfile, "Cookies"), "utf8")).resolves.toBe("keep");
      await expect(readFile(keptNotes, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unlinks a profile symlink instead of following it into another bot's profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-symlink-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const linkedProfile = path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"));
      const keptProfile = path.join(teamHome, ".browser-profiles", profileDirectory("bot-2"));
      await mkdir(keptProfile, { recursive: true });
      await mkdir(path.dirname(linkedProfile), { recursive: true });
      await writeFile(path.join(keptProfile, "Cookies"), "keep");
      await symlink(keptProfile, linkedProfile);
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: null,
        scope: "team",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(access(linkedProfile)).rejects.toThrow();
      await expect(readFile(path.join(keptProfile, "Cookies"), "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked profile directory instead of deleting the directory it points at", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-parent-symlink-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const decoy = path.join(teamHome, "decoy-profiles");
      const victim = path.join(decoy, profileDirectory("bot-1"));
      const notes = path.join(teamHome, "notes.txt");
      await mkdir(victim, { recursive: true });
      await writeFile(path.join(victim, "Cookies"), "keep");
      await writeFile(notes, "keep");
      await symlink(decoy, path.join(teamHome, ".browser-profiles"));
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: null,
        scope: "team",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(path.join(victim, "Cookies"), "utf8")).resolves.toBe("keep");
      await expect(readFile(notes, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["e2b", "createos"])(
    "removes the deleted bot's profile from a %s sandbox after the browser stops",
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-remote-delete-"));
      const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-remote-workspace-"));
      try {
        const home = new LocalAgentHomeStore(root);
        const teamHome = home.pathFor("team-workspace-1");
        await seedProfile(teamHome, "bot-1", "local-gone");
        await seedProfile(teamHome, "bot-2", "local-keep");
        await seedProfile(remote, "bot-1", "remote-gone");
        await seedProfile(remote, "bot-2", "remote-keep");
        const releaseScreen = vi.fn().mockResolvedValue(undefined);
        const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
          const result = runInWorkspace(remote, request.argv);
          if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
          yield { type: "exit" as const, code: result.code };
        });
        const team = {
          id: "team-computer",
          homeKey: "team-workspace-1",
          kind,
          providerRef: "sandbox-1",
          scope: "team",
          state: "running",
        };

        await destroyBot(
          {
            prisma: deletionPrisma(team),
            sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
            home,
            jobs: { cancel: vi.fn() } as unknown as JobPublisher,
          },
          {
            id: "bot-1",
            spaceId: "workspace-1",
            name: "Researcher",
            archivedAt: null,
            computerId: team.id,
          },
          { ...context, botId: "parent-1", screenLeaseId: "run-parent:4" },
          { deleteMemories: true },
        );

        expect(releaseScreen.mock.invocationCallOrder[0]).toBeLessThan(
          execute.mock.invocationCallOrder[0] ?? 0,
        );
        expect(execute).toHaveBeenCalledWith(
          expect.objectContaining({ kind, providerRef: "sandbox-1" }),
          expect.objectContaining({
            cwd: ".",
            argv: [
              "bash",
              "-eu",
              "-c",
              expect.any(String),
              "bash",
              ".browser-profiles",
              profileDirectory("bot-1"),
            ],
          }),
          expect.objectContaining({ botId: "bot-1", screenLeaseId: undefined }),
        );
        await expect(
          access(path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"))),
        ).rejects.toThrow();
        await expect(readFile(profileCookies(teamHome, "bot-2"), "utf8")).resolves.toBe(
          "local-keep",
        );
        await expect(
          access(path.join(remote, ".browser-profiles", profileDirectory("bot-1"))),
        ).rejects.toThrow();
        await expect(readFile(profileCookies(remote, "bot-2"), "utf8")).resolves.toBe(
          "remote-keep",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(remote, { recursive: true, force: true });
      }
    },
  );

  it("leaves a remote profile in place when its parent directory is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-remote-symlink-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-remote-symlink-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedProfile(teamHome, "bot-1", "local-gone");
      const decoy = path.join(remote, "decoy-profiles");
      const victim = path.join(decoy, profileDirectory("bot-1"));
      await mkdir(victim, { recursive: true });
      await writeFile(path.join(victim, "Cookies"), "remote-keep");
      await symlink(decoy, path.join(remote, ".browser-profiles"));
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(remote, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "box",
        providerRef: "box-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(path.join(victim, "Cookies"), "utf8")).resolves.toBe("remote-keep");
      await expect(
        access(path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"))),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("does not remove a profile when stopping the browser fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-release-failed-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-release-failed-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedProfile(teamHome, "bot-1", "local-stay");
      await seedProfile(remote, "bot-1", "remote-stay");
      const execute = vi.fn();
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: "sandbox-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockRejectedValue(new Error("sandbox screen release timed out")),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      const profileCleanups = execute.mock.calls.filter((call) =>
        (call[1] as CommandRequest).argv.includes(".browser-profiles"),
      );
      expect(profileCleanups).toEqual([]);
      await expect(readFile(profileCookies(teamHome, "bot-1"), "utf8")).resolves.toBe("local-stay");
      await expect(readFile(profileCookies(remote, "bot-1"), "utf8")).resolves.toBe("remote-stay");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("removes local and remote profiles when the browser stopped but slot cleanup failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-slot-cleanup-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-slot-cleanup-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedProfile(teamHome, "bot-1", "local-gone");
      await seedProfile(teamHome, "bot-2", "local-keep");
      await seedProfile(remote, "bot-1", "remote-gone");
      await seedProfile(remote, "bot-2", "remote-keep");
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(remote, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "createos",
        providerRef: "sandbox-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockRejectedValue(new BrowserStoppedReleaseError()),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(
        access(path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"))),
      ).rejects.toThrow();
      await expect(readFile(profileCookies(teamHome, "bot-2"), "utf8")).resolves.toBe("local-keep");
      await expect(
        access(path.join(remote, ".browser-profiles", profileDirectory("bot-1"))),
      ).rejects.toThrow();
      await expect(readFile(profileCookies(remote, "bot-2"), "utf8")).resolves.toBe("remote-keep");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });
  it("does not wake a stopped remote Team Computer to remove the deleted bot's profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-profile-stopped-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedProfile(teamHome, "bot-1", "stored-gone");
      const execute = vi.fn();
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "daytona",
        providerRef: "sandbox-1",
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      expect(execute).not.toHaveBeenCalled();
      await expect(
        access(path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"))),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the deleted bot's folder inside a running Docker Team Computer and keeps other folders", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-delete-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-1/private.txt", "gone");
      await seedFile(teamHome, "bots/bot-10/notes.txt", "keep");
      await seedFile(teamHome, "bots/bot-2/notes.txt", "keep");
      await seedFile(teamHome, "shared/plan.txt", "keep");
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "running",
      };
      // The container sees the same mounted home.
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(teamHome, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "docker", providerRef: "container-1" }),
        { argv: ["bash", "-eu", "-c", expect.any(String), "bash", "bots", "bot-1"], cwd: "." },
        expect.objectContaining({ botId: "bot-1" }),
      );
      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
      await expect(readFile(path.join(teamHome, "bots/bot-10/notes.txt"), "utf8")).resolves.toBe(
        "keep",
      );
      await expect(readFile(path.join(teamHome, "bots/bot-2/notes.txt"), "utf8")).resolves.toBe(
        "keep",
      );
      await expect(readFile(path.join(teamHome, "shared/plan.txt"), "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the Team Computer folder of a bot that moved to its own computer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-moved-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-1/private.txt", "gone");
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: null,
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {} as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: "dedicated-computer",
        },
        context,
        { deleteMemories: true },
      );

      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports deletion success when the in-computer folder cleanup never finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let markStarted: () => void = () => undefined;
      const cleanupStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let commandSignal: AbortSignal | undefined;
      // Never finishes and ignores aborts, like a wedged provider call.
      const execute = vi.fn((_computer: unknown, _request: CommandRequest, commandContext) => {
        commandSignal = (commandContext as AdapterContext).signal;
        markStarted();
        return (async function* () {
          await new Promise(() => undefined);
          yield { type: "exit" as const, code: 0 };
        })();
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "running",
      };
      const prisma = deletionPrisma(team);

      const deleting = destroyBot(
        {
          prisma,
          sandbox: { execute } as unknown as SandboxProvider,
          home: new LocalAgentHomeStore(path.join(tmpdir(), "rakazo-unused-home")),
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(deleting).resolves.toBeUndefined();
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(commandSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports deletion success when the Team Computer lookup fails after the bot is deleted", async () => {
    const team = { id: "team-computer", homeKey: "team-workspace-1", scope: "team" };
    const prisma = deletionPrisma(team);
    vi.mocked(prisma.computer.findUnique).mockImplementation((async (query: {
      where: { scopeKey?: string };
    }) => {
      if (query.where.scopeKey === "team:workspace-1") throw new Error("database unavailable");
      return null;
    }) as never);

    await expect(
      destroyBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: new LocalAgentHomeStore(path.join(tmpdir(), "rakazo-unused-home")),
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: null,
        },
        context,
        { deleteMemories: true },
      ),
    ).resolves.toBeUndefined();
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("removes the deleted bot's folder from a running remote Team Computer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-remote-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-remote-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-1/private.txt", "stored-gone");
      await seedFile(remote, "bots/bot-1/private.txt", "remote-gone");
      await seedFile(remote, "bots/bot-2/notes.txt", "remote-keep");
      await seedFile(remote, "shared/plan.txt", "remote-keep");
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(remote, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: "sandbox-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        { ...context, botId: "parent-1", screenLeaseId: "run-parent:4" },
        { deleteMemories: true },
      );

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "e2b", providerRef: "sandbox-1" }),
        {
          argv: ["bash", "-eu", "-c", expect.any(String), "bash", "bots", "bot-1"],
          cwd: ".",
        },
        expect.objectContaining({ botId: "bot-1", screenLeaseId: undefined }),
      );
      await expect(access(path.join(remote, "bots", "bot-1"))).rejects.toThrow();
      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
      await expect(readFile(path.join(remote, "bots/bot-2/notes.txt"), "utf8")).resolves.toBe(
        "remote-keep",
      );
      await expect(readFile(path.join(remote, "shared/plan.txt"), "utf8")).resolves.toBe(
        "remote-keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("does not wake a stopped Team Computer to remove the deleted bot's folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-stopped-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-1/private.txt", "stored-gone");
      const execute = vi.fn(async function* (_computer: unknown, _request: CommandRequest) {
        yield { type: "exit" as const, code: 0 };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: "sandbox-1",
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      expect(execute.mock.calls.some(([, request]) => request.argv.includes("bots"))).toBe(false);
      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unlinks a symlinked bot folder instead of following it into another bot's folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-symlink-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-symlink-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-2/notes.txt", "stored-keep");
      await symlink(path.join(teamHome, "bots", "bot-2"), path.join(teamHome, "bots", "bot-1"));
      await seedFile(remote, "bots/bot-2/notes.txt", "remote-keep");
      await symlink("bot-2", path.join(remote, "bots", "bot-1"));
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(remote, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "box",
        providerRef: "box-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
      await expect(access(path.join(remote, "bots", "bot-1"))).rejects.toThrow();
      await expect(readFile(path.join(teamHome, "bots/bot-2/notes.txt"), "utf8")).resolves.toBe(
        "stored-keep",
      );
      await expect(readFile(path.join(remote, "bots/bot-2/notes.txt"), "utf8")).resolves.toBe(
        "remote-keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("leaves the Team Computer home alone when its bots folder is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-parent-symlink-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "decoy/bot-1/notes.txt", "keep");
      await symlink(path.join(teamHome, "decoy"), path.join(teamHome, "bots"));
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: null,
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {} as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(path.join(teamHome, "decoy/bot-1/notes.txt"), "utf8")).resolves.toBe(
        "keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["docker", "desktop"])(
    "leaves a stopped %s Team Computer's stored home to its next boot",
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-docker-stopped-"));
      try {
        const home = new LocalAgentHomeStore(root);
        const teamHome = home.pathFor("team-workspace-1");
        await seedFile(teamHome, "bots/bot-1/private.txt", "next-boot");
        const execute = vi.fn();
        const team = {
          id: "team-computer",
          homeKey: "team-workspace-1",
          kind,
          providerRef: "container-1",
          scope: "team",
          state: "stopped",
        };

        await destroyBot(
          {
            prisma: deletionPrisma(team),
            sandbox: { releaseScreen: vi.fn(), execute } as unknown as SandboxProvider,
            home,
            jobs: { cancel: vi.fn() } as unknown as JobPublisher,
          },
          {
            id: "bot-1",
            spaceId: "workspace-1",
            name: "Researcher",
            archivedAt: null,
            computerId: team.id,
          },
          context,
          { deleteMemories: true },
        );

        expect(execute).not.toHaveBeenCalled();
        await expect(readFile(path.join(teamHome, "bots/bot-1/private.txt"), "utf8")).resolves.toBe(
          "next-boot",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not delete outside a Docker home when a bot swaps bots/ for a symlink mid-cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-swap-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const victim = path.join(root, "victim");
      await seedFile(teamHome, "bots/bot-1/private.txt", "next-boot");
      await seedFile(victim, "bot-1/keep.txt", "keep");
      const folder = await realpath(path.join(teamHome, "bots", "bot-1"));
      // A bot in the container replaces bots/ with a symlink right after the folder is resolved.
      fsHooks.afterRealpath = async (resolved) => {
        if (resolved !== folder) return;
        fsHooks.afterRealpath = undefined;
        await rename(path.join(teamHome, "bots"), path.join(teamHome, "bots-before-swap"));
        await symlink(victim, path.join(teamHome, "bots"));
      };
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: { releaseScreen: vi.fn() } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(path.join(victim, "bot-1/keep.txt"), "utf8")).resolves.toBe("keep");
    } finally {
      fsHooks.afterRealpath = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not delete outside a Docker home when a bot swaps .browser-profiles/ mid-cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-profile-swap-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const victim = path.join(root, "victim");
      await seedProfile(teamHome, "bot-1", "next-boot");
      await seedProfile(victim, "bot-1", "keep");
      const profile = await realpath(
        path.join(teamHome, ".browser-profiles", profileDirectory("bot-1")),
      );
      // A bot in the container replaces .browser-profiles/ right after the profile is resolved.
      fsHooks.afterRealpath = async (resolved) => {
        if (resolved !== profile) return;
        fsHooks.afterRealpath = undefined;
        await rename(
          path.join(teamHome, ".browser-profiles"),
          path.join(teamHome, "profiles-before-swap"),
        );
        await symlink(
          path.join(victim, ".browser-profiles"),
          path.join(teamHome, ".browser-profiles"),
        );
      };
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(profileCookies(victim, "bot-1"), "utf8")).resolves.toBe("keep");
      await expect(readFile(profileCookies(teamHome, "bot-1"), "utf8")).resolves.toBe("next-boot");
    } finally {
      fsHooks.afterRealpath = undefined;
      await rm(root, { recursive: true, force: true });
    }
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

  it("releases the archived bot's screen and keeps its browser profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-archive-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const profile = path.join(teamHome, ".browser-profiles", profileDirectory("child-1"));
      await mkdir(profile, { recursive: true });
      await writeFile(path.join(profile, "Cookies"), "stay");
      const releaseScreen = vi.fn().mockResolvedValue(undefined);
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
      };
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
          findUnique: vi.fn(async (query: { where: { id?: string } }) =>
            query.where.id === team.id ? team : null,
          ),
        },
        run: { findMany: vi.fn().mockResolvedValue([]) },
        routine: { findMany: vi.fn().mockResolvedValue([]) },
        $transaction: transaction,
      } as unknown as PrismaClient;

      await archiveBot(
        {
          prisma,
          sandbox: { releaseScreen } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "child-1",
          spaceId: "workspace-1",
          name: "Scout",
          archivedAt: null,
          computerId: team.id,
        },
        { ...context, botId: "parent-1", screenLeaseId: "run-parent:4" },
      );

      expect(releaseScreen).toHaveBeenCalledWith(
        {
          id: "container-1",
          botId: "team-workspace-1",
          kind: "docker",
          providerRef: "container-1",
        },
        expect.objectContaining({ botId: "child-1" }),
      );
      const releaseContext = releaseScreen.mock.calls[0]?.[1] as AdapterContext;
      expect(releaseContext.botId).toBe("child-1");
      expect(releaseContext.screenLeaseId).toBeUndefined();
      expect(releaseContext.cancelRunWork).toBeUndefined();
      await expect(readFile(path.join(profile, "Cookies"), "utf8")).resolves.toBe("stay");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function profileDirectory(botId: string) {
  return path.posix.basename(browserProfilePathForScreen(botId));
}

function profileCookies(homeDir: string, botId: string) {
  return path.join(homeDir, ".browser-profiles", profileDirectory(botId), "Cookies");
}

async function seedProfile(homeDir: string, botId: string, cookies: string) {
  const profile = path.join(homeDir, ".browser-profiles", profileDirectory(botId));
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "Cookies"), cookies);
}

async function seedFile(root: string, relative: string, content: string) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function runInWorkspace(cwd: string, argv: readonly string[]) {
  try {
    execFileSync(argv[0] ?? "bash", argv.slice(1), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    return { code: failed.status ?? 1, stderr: failed.stderr ?? "" };
  }
}

function deletionPrisma(team: { id: string }) {
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      chatGroup: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifact: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      botDeletion: { create: vi.fn().mockResolvedValue({}) },
      bot: { delete: vi.fn().mockResolvedValue({}) },
    }),
  );
  return {
    computer: {
      findUnique: vi.fn(async (query: { where: { id?: string; scopeKey?: string } }) =>
        query.where.id === team.id || query.where.scopeKey === "team:workspace-1" ? team : null,
      ),
    },
    run: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    routine: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: transaction,
  } as unknown as PrismaClient;
}
