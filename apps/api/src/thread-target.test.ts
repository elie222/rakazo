import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  cancelSupersededQueuedRuns,
  reactToThreadMessage,
  stopThreadRuns,
  type ThreadTarget,
  threadHead,
  threadSnapshot,
} from "./thread-target.js";

describe("threadHead", () => {
  it("returns the durable cursor without loading a snapshot", async () => {
    const findFirst = vi.fn().mockResolvedValue({ seq: 12 });
    const prisma = { event: { findFirst } } as unknown as PrismaClient;
    const target = { threadId: "thread-1" } as ThreadTarget;

    await expect(threadHead(prisma, target)).resolves.toEqual({
      threadId: "thread-1",
      cursor: 12,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { threadId: "thread-1" },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
  });
});

describe("queued run supersession", () => {
  it("only cancels queued runs started by user messages or reactions", async () => {
    const tx = {
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-old", taskId: "task-old" }]),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
    };
    await cancelSupersededQueuedRuns(tx as never, {
      threadId: "thread-1",
      botIds: ["bot-1"],
      keepRunIds: ["run-new"],
    });
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ trigger: "user", sourceMessage: { role: "user" } }, { trigger: "reaction" }],
        }),
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["run-old"] } } }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-old"] } },
      data: { status: "cancelled" },
    });
  });
});

describe("message thumbs-up", () => {
  it("wakes once on add and not on replay or removal", async () => {
    let thumbsUp = false;
    let busy = false;
    let eventSeq = 0;
    const tx = {
      $queryRaw: vi.fn(async () => [
        { id: "message-1", role: "bot", blocks: [{ kind: "text", text: "Done" }], thumbsUp },
      ]),
      message: {
        update: vi.fn(async ({ data }: { data: { thumbsUp: boolean } }) => {
          thumbsUp = data.thumbsUp;
          return { id: "message-1" };
        }),
      },
      run: {
        findFirst: vi.fn(async () => (busy ? { id: "run-active" } : null)),
        create: vi.fn().mockResolvedValue({ id: "run-1", status: "queued" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: ++eventSeq })),
      },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: `event-${eventSeq}`,
          createdAt: new Date(),
          ...data,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      reactToThreadMessage({ prisma }, actor, target, "message-1", true),
    ).resolves.toEqual(expect.objectContaining({ changed: true, runId: "run-1" }));
    await expect(
      reactToThreadMessage({ prisma }, actor, target, "message-1", true),
    ).resolves.toEqual(expect.objectContaining({ changed: false, runId: null }));
    await expect(
      reactToThreadMessage({ prisma }, actor, target, "message-1", false),
    ).resolves.toEqual(expect.objectContaining({ changed: true, runId: null }));
    busy = true;
    await expect(
      reactToThreadMessage({ prisma }, actor, target, "message-1", true),
    ).resolves.toEqual(expect.objectContaining({ changed: true, runId: null }));

    expect(tx.task.create).toHaveBeenCalledOnce();
    expect(tx.run.create).toHaveBeenCalledOnce();
    expect(String(tx.$queryRaw.mock.calls[0]?.[0])).toContain("SELECT id FROM threads");
    expect(String(tx.$queryRaw.mock.calls[0]?.[0])).toContain("FOR UPDATE");
    expect(String(tx.$queryRaw.mock.calls[1]?.[0])).toContain(
      'SELECT id, "thumbsUp" FROM messages',
    );
    expect(String(tx.$queryRaw.mock.calls[1]?.[0])).toContain("FOR UPDATE");
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceMessageId: "message-1", trigger: "reaction" }),
      }),
    );
    expect(tx.event.create).toHaveBeenCalledTimes(3);
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "thread.message.reaction",
          payload: { messageId: "message-1", thumbsUp: true },
        }),
      }),
    );
    expect(thumbsUp).toBe(true);
  });
});

describe("threadSnapshot", () => {
  it("reloads tool-only live messages for an active run", async () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyEvents = vi.fn().mockResolvedValue([
      {
        id: "event-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: 4,
        type: "agent.tool.called",
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: new Date("2026-08-23T00:00:00.000Z"),
      },
    ]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue({ seq: 4 }),
        findMany: findManyEvents,
      },
      run: { findFirst: vi.fn().mockResolvedValue(run) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(findManyEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: { in: ["thread.progress", "thread.subagent", "agent.tool.called"] },
        }),
      }),
    );
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        botId: "bot-1",
        blocks: [
          {
            kind: "steps",
            steps: [{ label: "Slack find channels", count: 1 }],
          },
        ],
      }),
    ]);
  });

  it("returns the latest failed run so the client can show its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "Provider is not configured: openrouter",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyEvents = vi.fn();
    const findFirstRun = vi
      .fn()
      .mockResolvedValueOnce(run)
      // The failure is itself the newest terminal run, so it stays visible.
      .mockResolvedValueOnce({ id: run.id });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          threadId: "thread-1",
          trigger: { not: "bot_message" },
          status: {
            in: ["queued", "leased", "running", "waiting_input", "waiting_takeover", "failed"],
          },
        }),
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: "Provider is not configured: openrouter",
      }),
    );
    expect(findManyEvents).not.toHaveBeenCalled();
  });

  it("drops a failed run once a newer run has finished", async () => {
    const failed = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "This operation was aborted",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findFirstRun = vi
      .fn()
      .mockResolvedValueOnce(failed)
      // The supersession probe finds a newer completed run.
      .mockResolvedValueOnce({ id: "run-completed" });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(snapshot.run).toBeNull();
  });

  it("does not return a cancelled or completed run", async () => {
    const findManyEvents = vi.fn();
    const findFirstRun = vi.fn().mockResolvedValue(null);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: findManyEvents,
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: ["queued", "leased", "running", "waiting_input", "waiting_takeover", "failed"],
          },
        }),
      }),
    );
    expect(snapshot.run).toBeNull();
    expect(findManyEvents).not.toHaveBeenCalled();
  });
  it("returns a group's latest failed run so a refresh keeps its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "member exploded",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyRuns = groupRunFindMany({ terminals: [run] });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          trigger: { not: "bot_message" },
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([]);
  });

  it("omits peer bot_message runs from group activeRuns and displayed terminal run", async () => {
    const peerActive = {
      id: "run-peer-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "running",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const peerFailed = {
      id: "run-peer-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-peer-fail",
      status: "failed",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: "peer exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const findManyRuns = groupRunFindMany({
      active: [peerActive],
      terminals: [peerFailed],
    });
    const snapshot = await threadSnapshot({ prisma: groupPrisma(findManyRuns) }, groupTarget());

    expect(snapshot.activeRuns).toEqual([]);
    expect(snapshot.run).toBeNull();
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { not: "bot_message" },
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        }),
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
      }),
    );
  });

  it("does not revive an older group failure after a newer run completed", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-newer-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [completed, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
    expect(snapshot.activeRuns).toEqual([]);
  });

  it("does not revive a failure when a newer cancelled run has null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const cancelled = {
      id: "run-newer-cancelled",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "cancelled",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [cancelled, failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("prefers a timestamped terminal over an older failure with null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [failed, completed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("clamps a long persisted group failure error on refresh", async () => {
    const longError = "x".repeat(400);
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: longError,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ terminals: [run] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: `${"x".repeat(300)}…`,
      }),
    );
  });

  it("keeps a concurrent member failure in run while another member is still active", async () => {
    const active = {
      id: "run-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      { prisma: groupPrisma(groupRunFindMany({ active: [active], terminals: [failed] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-active", status: "running" }),
    ]);
  });

  it("keeps a failure on refresh when another member starts after it", async () => {
    const lateActive = {
      id: "run-late",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:03.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        prisma: groupPrisma(groupRunFindMany({ active: [lateActive], terminals: [failed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-late", status: "running" }),
    ]);
  });
});

function isTerminalRunQuery(where: { status?: { in?: string[] } } | undefined) {
  const statuses = where?.status?.in;
  return Array.isArray(statuses) && statuses.includes("failed") && statuses.includes("completed");
}

function excludesPeerRuns(where: { trigger?: { not?: string } } | undefined) {
  return where?.trigger?.not === "bot_message";
}

function groupRunFindMany(input: { active?: unknown[]; terminals?: unknown[] }) {
  return vi
    .fn()
    .mockImplementation(
      async (args: { where?: { status?: { in?: string[] }; trigger?: { not?: string } } }) => {
        const rows = isTerminalRunQuery(args.where)
          ? (input.terminals ?? [])
          : (input.active ?? []);
        if (!excludesPeerRuns(args.where)) return rows;
        return rows.filter((row) => (row as { trigger?: string }).trigger !== "bot_message");
      },
    );
}

function groupPrisma(findManyRuns: ReturnType<typeof groupRunFindMany>) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
    message: { findMany: vi.fn().mockResolvedValue([]) },
    event: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    run: { findMany: findManyRuns },
  };
  return {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
}

function groupTarget() {
  return {
    kind: "group",
    groupId: "group-1",
    groupName: "Group",
    members: [],
    threadId: "thread-1",
  } as unknown as ThreadTarget;
}

describe("stopThreadRuns", () => {
  it("releases every active group member screen immediately", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const transaction = {
      $queryRaw: vi.fn(),
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a" },
          { id: "run-b", botId: "bot-b" },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      computer: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "computer-db-a",
            homeKey: "home-a",
            kind: "fake",
            providerRef: "computer-a",
            executionBotId: "bot-a",
            executionRunId: "run-a",
          },
          {
            id: "computer-db-b",
            homeKey: "home-b",
            kind: "fake",
            providerRef: "computer-b",
            executionBotId: "bot-b",
            executionRunId: "run-b",
          },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      computerExecutionLease: {
        findMany: vi.fn().mockResolvedValue([
          { computerId: "computer-db-a", runId: "run-a", fence: 2 },
          { computerId: "computer-db-b", runId: "run-b", fence: 4 },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      event: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      { prisma, sandbox: { releaseScreen, execute } as unknown as SandboxProvider },
      actor,
      target,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "computer-db-a", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a" }),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(2);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-a",
        cancelRunWork: true,
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-b" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-b",
        cancelRunWork: true,
        runId: "run-b",
        screenLeaseId: "run-b:4",
      }),
    );
    expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executionRunId: { in: ["run-a", "run-b"] } } }),
    );
  });
});
