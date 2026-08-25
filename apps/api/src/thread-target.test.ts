import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  resolveDelegationTarget,
  stopThreadRuns,
  type ThreadTarget,
  threadSnapshot,
} from "./thread-target.js";

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

describe("resolveDelegationTarget", () => {
  const actor = { workspaceId: "workspace-1", userId: "user-1" } as Actor;

  function txWithBots(bots: Array<{ id: string; name: string; hasThread?: boolean }>) {
    return {
      bot: {
        findMany: vi.fn().mockResolvedValue(
          bots.map((bot) => ({
            id: bot.id,
            name: bot.name,
            thread: bot.hasThread === false ? null : { id: `thread-${bot.id}` },
          })),
        ),
      },
    } as unknown as Prisma.TransactionClient;
  }

  it("matches an @mention at the start of the message", async () => {
    const tx = txWithBots([{ id: "bot-sarah", name: "Sarah" }]);
    const result = await resolveDelegationTarget(tx, actor, "bot-origin", "@Sarah check email");
    expect(result).toEqual({
      botId: "bot-sarah",
      botName: "Sarah",
      threadId: "thread-bot-sarah",
      prompt: "Sarah check email",
    });
  });

  it("matches an @mention in the middle of a sentence", async () => {
    const tx = txWithBots([{ id: "bot-sarah", name: "Sarah" }]);
    const result = await resolveDelegationTarget(
      tx,
      actor,
      "bot-origin",
      "Can you see what @Sarah is upto",
    );
    expect(result).toEqual({
      botId: "bot-sarah",
      botName: "Sarah",
      threadId: "thread-bot-sarah",
      prompt: "Can you see what Sarah is upto",
    });
  });

  it("does not match @BotFoo when the bot is named Bot", async () => {
    const tx = txWithBots([{ id: "bot-1", name: "Bot" }]);
    const result = await resolveDelegationTarget(tx, actor, "bot-origin", "ping @BotFoo now");
    expect(result).toBeNull();
  });

  it("prefers the longest matching name", async () => {
    const tx = txWithBots([
      { id: "bot-chief", name: "Chief" },
      { id: "bot-chief-of-staff", name: "Chief of Staff" },
    ]);
    const result = await resolveDelegationTarget(
      tx,
      actor,
      "bot-origin",
      "@Chief of Staff please review this",
    );
    expect(result?.botId).toBe("bot-chief-of-staff");
  });

  it("returns null for a bare mention with no task text", async () => {
    const tx = txWithBots([{ id: "bot-sarah", name: "Sarah" }]);
    const result = await resolveDelegationTarget(tx, actor, "bot-origin", "@Sarah");
    expect(result).toBeNull();
  });

  it("returns null when the mentioned bot has no thread", async () => {
    const tx = txWithBots([{ id: "bot-sarah", name: "Sarah", hasThread: false }]);
    const result = await resolveDelegationTarget(tx, actor, "bot-origin", "@Sarah check email");
    expect(result).toBeNull();
  });

  it("returns null when the text has no @ at all", async () => {
    const tx = txWithBots([{ id: "bot-sarah", name: "Sarah" }]);
    const result = await resolveDelegationTarget(tx, actor, "bot-origin", "just a normal message");
    expect(result).toBeNull();
  });

  it("does not match a bot owned by a different userId in the same workspace", async () => {
    // Same workspace, other member's bot named Sarah — Prisma would exclude it via userId.
    const findMany = vi.fn().mockImplementation(async ({ where }) => {
      const bots = [
        {
          id: "bot-sarah-other",
          name: "Sarah",
          userId: "user-2",
          thread: { id: "thread-bot-sarah-other" },
        },
        {
          id: "bot-sarah-own",
          name: "Other",
          userId: "user-1",
          thread: { id: "thread-bot-sarah-own" },
        },
      ];
      return bots
        .filter(
          (bot) =>
            bot.userId === where.userId &&
            where.workspaceId === actor.workspaceId &&
            bot.id !== where.id.not,
        )
        .map(({ id, name, thread }) => ({ id, name, thread }));
    });
    const tx = { bot: { findMany } } as unknown as Prisma.TransactionClient;

    const result = await resolveDelegationTarget(tx, actor, "bot-origin", "@Sarah check email");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace-1",
          userId: "user-1",
          archivedAt: null,
          id: { not: "bot-origin" },
        }),
      }),
    );
    expect(result).toBeNull();
  });
});
