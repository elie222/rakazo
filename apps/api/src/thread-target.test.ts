import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { stopThreadRuns, type ThreadTarget, threadSnapshot } from "./thread-target.js";

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
    const prisma = {
      message: { findMany: vi.fn().mockResolvedValue([]) },
      event: {
        findFirst: vi.fn().mockResolvedValue({ seq: 4 }),
        findMany: findManyEvents,
      },
      run: { findFirst: vi.fn().mockResolvedValue(run) },
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma }, target);

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
});

describe("stopThreadRuns", () => {
  it("releases every active group member screen immediately", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a" },
          { id: "run-b", botId: "bot-b" },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      bot: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "bot-a",
            computer: { homeKey: "home-a", kind: "fake", providerRef: "computer-a" },
          },
          {
            id: "bot-b",
            computer: { homeKey: "home-b", kind: "fake", providerRef: "computer-b" },
          },
        ]),
      },
      computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      event: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const actor = {
      workspaceId: "workspace-1",
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
      { prisma, sandbox: { releaseScreen } as unknown as SandboxProvider },
      actor,
      target,
    );

    expect(releaseScreen).toHaveBeenCalledTimes(2);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({ workspaceId: "workspace-1", userId: "user-1", botId: "bot-a" }),
    );
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-b" }),
      expect.objectContaining({ workspaceId: "workspace-1", userId: "user-1", botId: "bot-b" }),
    );
  });
});
