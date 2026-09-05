import type { MessageBlock } from "@rakazo/contracts";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  createRunExecutor,
  createRunWorkspaceCheckpoint,
  loadCurrentTurnImages,
  missingTurnImagesInstruction,
  runNotificationsEnabled,
  selectBuiltinToolsForRun,
  settleSteeringAttachmentLoads,
  threadContextForRun,
} from "./executor.js";

describe("run workspace checkpoint", () => {
  it("skips clean turns and flushes once after a mutation", async () => {
    const persist = vi.fn(async () => undefined);
    const checkpoint = createRunWorkspaceCheckpoint(persist);

    await expect(checkpoint.flush()).resolves.toBe(false);
    checkpoint.markDirty();
    await expect(checkpoint.flush()).resolves.toBe(true);
    await expect(checkpoint.flush()).resolves.toBe(false);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("marks materialized steering files for checkpointing", async () => {
    const persist = vi.fn(async () => undefined);
    const checkpoint = createRunWorkspaceCheckpoint(persist);

    checkpoint.markFiles([]);
    await expect(checkpoint.flush()).resolves.toBe(false);
    checkpoint.markFiles([{ path: "attachments/result.txt" }]);
    await expect(checkpoint.flush()).resolves.toBe(true);
  });

  it("keeps a failed checkpoint dirty for retry", async () => {
    const persist = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("checkpoint failed"))
      .mockResolvedValueOnce(undefined);
    const checkpoint = createRunWorkspaceCheckpoint(persist);
    checkpoint.markDirty();

    await expect(checkpoint.flush()).rejects.toThrow("checkpoint failed");
    await expect(checkpoint.flush()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

describe("run tool selection", () => {
  const toolNames = (trigger: string, groupId: string | null = null) =>
    selectBuiltinToolsForRun({
      graphicalToolsAllowed: true,
      groupId,
      trigger,
      semanticMemoryEnabled: false,
    }).map((tool) => tool.name);

  it("withholds schedule creation only from routine-triggered runs", () => {
    expect(toolNames("routine")).not.toContain("schedule_create");
    expect(toolNames("routine")).toEqual(
      expect.arrayContaining(["schedule_list", "schedule_cancel"]),
    );
    expect(toolNames("user")).toContain("schedule_create");
  });

  it("keeps schedule tools in group chats and still blocks create on routines", () => {
    expect(toolNames("user", "group-1")).toEqual(
      expect.arrayContaining(["schedule_create", "schedule_list", "schedule_cancel"]),
    );
    expect(toolNames("routine", "group-1")).not.toContain("schedule_create");
    expect(toolNames("routine", "group-1")).toEqual(
      expect.arrayContaining(["schedule_list", "schedule_cancel"]),
    );
  });
});

describe("steering attachment hydration", () => {
  it("keeps successful attachment parts when another part is unavailable", async () => {
    const imageBlocks: MessageBlock[] = [
      { kind: "image", artifactId: "image-1", name: "one.png", mimeType: "image/png" },
      { kind: "image", artifactId: "image-2", name: "two.png", mimeType: "image/png" },
    ];
    const withoutImage = await settleSteeringAttachmentLoads(
      Promise.reject(new Error("image missing")),
      Promise.resolve(["attachment.pdf"]),
    );
    expect(withoutImage).toMatchObject({ images: undefined, files: ["attachment.pdf"] });
    expect(withoutImage.unavailableInstruction).toContain("do not guess its contents");

    const withoutFile = await settleSteeringAttachmentLoads(
      Promise.resolve(["image.png"]),
      Promise.reject(new Error("file missing")),
    );
    expect(withoutFile).toMatchObject({ images: ["image.png"], files: [] });
    expect(withoutFile.unavailableInstruction).toContain("do not guess its contents");

    const partiallyHydratedImages = await loadCurrentTurnImages(
      {
        artifacts: { get: vi.fn(async () => new Uint8Array([1])) },
        prisma: {
          artifact: {
            findMany: vi.fn(async () => [{ id: "image-1", storageKey: "one.png" }]),
          },
        },
      } as never,
      imageBlocks,
      {
        operationId: "run-1",
        traceId: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      },
    );
    expect(partiallyHydratedImages).toHaveLength(1);
    const withPartiallyMissingImages = await settleSteeringAttachmentLoads(
      Promise.resolve(partiallyHydratedImages),
      Promise.resolve([]),
      imageBlocks,
    );
    expect(withPartiallyMissingImages).toMatchObject({
      images: partiallyHydratedImages,
      files: [],
    });
    expect(withPartiallyMissingImages.unavailableInstruction).toContain(
      "do not guess its contents",
    );

    const withAllImagesMissing = await settleSteeringAttachmentLoads(
      Promise.resolve(undefined),
      Promise.resolve([]),
      imageBlocks.slice(0, 1),
    );
    expect(withAllImagesMissing.unavailableInstruction).toContain("do not guess its contents");

    const withoutMissingImages = await settleSteeringAttachmentLoads(
      Promise.resolve(["image.png"]),
      Promise.resolve([]),
      imageBlocks.slice(0, 1),
    );
    expect(withoutMissingImages.unavailableInstruction).toBe("");

    const withoutExpectedImages = await settleSteeringAttachmentLoads(
      Promise.resolve(undefined),
      Promise.resolve([]),
    );
    expect(withoutExpectedImages.unavailableInstruction).toBe("");
  });

  it("propagates cancellation while steering attachments settle", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    controller.abort();

    await expect(
      settleSteeringAttachmentLoads(
        Promise.reject(cancellation),
        Promise.resolve([]),
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(cancellation);
  });

  it("treats unreadable image bytes as missing instead of failing hydration", async () => {
    const blocks: MessageBlock[] = [
      { kind: "image", artifactId: "image-1", name: "one.png", mimeType: "image/png" },
      { kind: "image", artifactId: "image-2", name: "two.png", mimeType: "image/png" },
    ];
    const images = await loadCurrentTurnImages(
      {
        artifacts: {
          get: vi.fn(async (storageKey: string) => {
            if (storageKey === "bad.png") throw new Error("read failed");
            return new Uint8Array([1]);
          }),
        },
        prisma: {
          artifact: {
            findMany: vi.fn(async () => [
              { id: "image-1", storageKey: "one.png" },
              { id: "image-2", storageKey: "bad.png" },
            ]),
          },
        },
      } as never,
      blocks,
      {
        operationId: "run-1",
        traceId: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      },
    );
    expect(images).toHaveLength(1);
    expect(missingTurnImagesInstruction(blocks, images)).toContain("do not guess its contents");
    const settled = await settleSteeringAttachmentLoads(
      Promise.resolve(images),
      Promise.resolve([]),
      blocks,
    );
    expect(settled.unavailableInstruction).toContain("do not guess its contents");
  });

  it("does not swallow image hydration cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    controller.abort(cancellation);

    await expect(
      loadCurrentTurnImages(
        {
          artifacts: { get: vi.fn(async () => Promise.reject(cancellation)) },
          prisma: {
            artifact: {
              findMany: vi.fn(async () => [{ id: "image-1", storageKey: "one.png" }]),
            },
          },
        } as never,
        [{ kind: "image", artifactId: "image-1", name: "one.png", mimeType: "image/png" }],
        {
          operationId: "run-1",
          traceId: "run-1",
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          runId: "run-1",
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(cancellation);
  });

  it("warns when an ordinary turn expects more images than were loaded", () => {
    const blocks: MessageBlock[] = [
      { kind: "image", artifactId: "image-1", name: "one.png", mimeType: "image/png" },
      { kind: "image", artifactId: "image-2", name: "two.png", mimeType: "image/png" },
    ];
    expect(missingTurnImagesInstruction(blocks, [{ name: "one.png" } as never])).toContain(
      "do not guess its contents",
    );
    expect(
      missingTurnImagesInstruction(blocks, [
        { name: "one.png" } as never,
        { name: "two.png" } as never,
      ]),
    ).toBe("");
    expect(missingTurnImagesInstruction(blocks, undefined)).toContain("do not guess its contents");
    expect(missingTurnImagesInstruction(undefined, undefined)).toBe("");
  });
});

function modelPreference({
  provider,
  secretId,
  modelId,
  isDefault,
}: {
  provider: string;
  secretId: string;
  modelId: string;
  isDefault: boolean;
}) {
  const now = new Date("2026-08-30T00:00:00.000Z");
  return {
    id: `preference-${provider}`,
    isDefault,
    modelId,
    credential: {
      id: `credential-${provider}`,
      userId: "user-1",
      provider,
      label: provider,
      secretId,
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe("run notification preference", () => {
  it("silences direct messages but leaves group notifications enabled", async () => {
    let source: { bot: { notifyOnFinish: boolean }; thread: { groupId: string | null } } | null = {
      bot: { notifyOnFinish: false },
      thread: { groupId: null },
    };
    const findFirst = vi.fn(async () => source);
    const prisma = { run: { findFirst } } as unknown as PrismaClient;

    await expect(
      runNotificationsEnabled(prisma, {
        botId: "bot-1",
        threadId: "thread-1",
        spaceId: "workspace-1",
        userId: "user-1",
      }),
    ).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        botId: "bot-1",
        threadId: "thread-1",
        spaceId: "workspace-1",
        userId: "user-1",
      },
      select: {
        bot: { select: { notifyOnFinish: true } },
        thread: { select: { groupId: true } },
      },
    });

    source = { bot: { notifyOnFinish: false }, thread: { groupId: "group-1" } };
    await expect(
      runNotificationsEnabled(prisma, {
        botId: "bot-1",
        threadId: "thread-1",
        spaceId: "workspace-1",
        userId: "user-1",
      }),
    ).resolves.toBe(true);
  });
});

describe("createRunExecutor", () => {
  it("isolates routine runs from every thread-history source", () => {
    const threadContext = {
      messages: [{ role: "user", content: "Create this routine" }],
      summary: "The user just configured this routine.",
      historyCompactedUpToSeq: 4,
    };

    expect(threadContextForRun("routine", threadContext)).toEqual({
      messages: [],
      summary: null,
      historyCompactedUpToSeq: null,
      includeSemanticRecall: false,
    });
    expect(threadContextForRun("user", threadContext)).toEqual({
      ...threadContext,
      includeSemanticRecall: true,
    });
  });

  it("deactivates one-shot routines after wake without scheduling another wakeup", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const taskCreate = vi.fn(async () => ({ id: "task-1" }));
    const runCreate = vi.fn(async () => ({ id: "run-1" }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          threadId: "group-thread-1",
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      thread: {
        findFirst: vi.fn(async () => ({ id: "group-thread-1" })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany },
          task: { create: taskCreate },
          run: { create: runCreate },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel, close: vi.fn(async () => undefined) },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ active: false, nextRunAt: null }),
      }),
    );
    expect(cancel).toHaveBeenCalledWith("routine:routine-1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread-1" }) }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread-1" }) }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "routine.fired",
        runId: "run-1",
        threadId: "group-thread-1",
      }),
    );
  });

  it("wakes a tool-created group routine into the group thread, not the bot DM", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const taskCreate = vi.fn(async () => ({ id: "task-1" }));
    const runCreate = vi.fn(async () => ({ id: "run-1" }));
    const append = vi.fn(async () => undefined);
    const findFirst = vi.fn(async () => ({ id: "group-thread-1" }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "remind the group",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          threadId: "group-thread-1",
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "dm-thread-1" },
        })),
      },
      thread: { findFirst },
      agentSkill: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
          task: { create: taskCreate },
          run: { create: runCreate },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "group-thread-1", spaceId: "ws-1" }),
      }),
    );
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread-1" }) }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread-1" }) }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fired", threadId: "group-thread-1" }),
    );
  });

  it("wakes a tool-created 1:1 routine into the bot DM thread", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const taskCreate = vi.fn(async () => ({ id: "task-1" }));
    const runCreate = vi.fn(async () => ({ id: "run-1" }));
    const append = vi.fn(async () => undefined);
    const findFirst = vi.fn(async () => ({ id: "dm-thread-1" }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "remind me",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          threadId: "dm-thread-1",
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "dm-thread-1" },
        })),
      },
      thread: { findFirst },
      agentSkill: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
          task: { create: taskCreate },
          run: { create: runCreate },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "dm-thread-1", spaceId: "ws-1" }),
      }),
    );
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "dm-thread-1" }) }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "dm-thread-1" }) }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fired", threadId: "dm-thread-1" }),
    );
  });

  it("expands @skill mentions in the routine prompt at fire time", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    let createdPrompt = "";
    const taskCreate = vi.fn(async (args: { data: { prompt: string } }) => {
      createdPrompt = args.data.prompt;
      return { id: "task-1" };
    });
    const skillContent = `---
name: Daily standup
description: Prepare standup notes
---

1. Summarize wins.
`;
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "Run @Daily standup, then email me",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => [
          {
            id: "skill-1",
            name: "Daily standup",
            description: "Prepare standup notes",
            content: skillContent,
            source: "user",
          },
        ]),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
          task: { create: taskCreate },
          run: { create: vi.fn(async () => ({ id: "run-1" })) },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
      events: { append: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(createdPrompt).toContain("Use skill: Daily standup");
    expect(createdPrompt).toContain("Summarize wins");
    expect(createdPrompt).not.toMatch(/@Daily standup/);
  });

  it("still continues the run when routine.fired append fails", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const append = vi.fn(async () => {
      throw new Error("append failed");
    });
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          lastRunAt: null,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany },
          task: { create: vi.fn(async () => ({ id: "task-1" })) },
          run: { create: vi.fn(async () => ({ id: "run-1", taskId: "task-1" })) },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel, close: vi.fn(async () => undefined) },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.wakeRoutine("routine-1", scheduledAt.toISOString()),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(cancel).toHaveBeenCalledWith("routine:routine-1");
  });

  it("restores the routine claim when run.continue enqueue fails", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const previousLastRunAt = new Date(Date.now() - 60_000);
    const enqueue = vi.fn(async () => {
      throw new Error("enqueue failed");
    });
    const claimUpdateMany = vi.fn(async () => ({ count: 1 }));
    const restoreUpdateMany = vi.fn(async () => ({ count: 1 }));
    const deleteRunMany = vi.fn(async () => ({ count: 1 }));
    const deleteTaskMany = vi.fn(async () => ({ count: 1 }));
    let transactionCalls = 0;
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          lastRunAt: previousLastRunAt,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          return callback({
            routine: { updateMany: claimUpdateMany },
            task: { create: vi.fn(async () => ({ id: "task-1" })) },
            run: { create: vi.fn(async () => ({ id: "run-1", taskId: "task-1" })) },
          });
        }
        return callback({
          routine: { updateMany: restoreUpdateMany },
          task: { deleteMany: deleteTaskMany },
          run: { deleteMany: deleteRunMany },
        });
      }),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
      events: { append: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await expect(executor.wakeRoutine("routine-1", scheduledAt.toISOString())).rejects.toThrow(
      "enqueue failed",
    );
    expect(deleteRunMany).toHaveBeenCalledWith({ where: { id: "run-1", status: "queued" } });
    expect(deleteTaskMany).toHaveBeenCalledWith({ where: { id: "task-1", status: "queued" } });
    expect(restoreUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "routine-1", active: false, nextRunAt: null }),
        data: expect.objectContaining({
          nextRunAt: scheduledAt,
          active: true,
          lastRunAt: previousLastRunAt,
        }),
      }),
    );
  });

  it("consumes a persisted takeover checkpoint when claiming the run", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          botId: "bot-1",
          status: "queued",
          checkpoint: "takeover-skipped",
          leaseFence: 0,
        })),
        updateMany,
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({ prisma } as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ checkpoint: null }),
      }),
    );
  });

  it("restores a takeover checkpoint when a switching computer requeues the run", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const enqueue = vi.fn(async () => undefined);
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          botId: "bot-1",
          status: "queued",
          checkpoint: "takeover-skipped",
          leaseFence: 0,
        })),
        findUniqueOrThrow: vi.fn(async () => ({ status: "leased", startedAt: null })),
        updateMany,
      },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          computerId: "computer-1",
          computerSwitching: true,
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({ prisma, jobs: { enqueue } } as unknown as Parameters<
      typeof createRunExecutor
    >[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "queued",
          checkpoint: "takeover-skipped",
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("fails a run clearly without calling the real runtime when no model is configured", async () => {
    let status = "queued";
    const runtimeRun = vi.fn();
    const finalizeRun = vi.fn(async () => {
      status = "failed";
      return { continuationRunId: null };
    });
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      userId: "user-1",
      spaceId: "ws-1",
      status: "queued",
      trigger: "user",
      routineId: null,
      sourceMessageId: null,
      checkpoint: null,
      leaseFence: 0,
    };
    const botLookup = vi.fn(async (args: { select?: { computerId?: boolean } }) =>
      args.select?.computerId
        ? { computerId: "computer-1", computerSwitching: false }
        : {
            id: "bot-1",
            name: "Assistant",
            modelProvider: null,
            modelId: null,
            thinkingLevel: null,
            memoryScope: "isolated",
            computer: { id: "computer-1", scope: "private" },
          },
    );
    const prisma = {
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => ({ status: "leased", startedAt: null })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { findUniqueOrThrow: botLookup },
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ scope: "private", state: "running" })),
      },
      attempt: {
        create: vi.fn(async () => ({ id: "attempt-1" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "thread-1",
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          historyCompactionGeneration: 0,
        })),
      },
      message: { findMany: vi.fn(async () => []) },
      task: { findUniqueOrThrow: vi.fn(async () => ({ id: "task-1", prompt: "hello" })) },
      connection: { findMany: vi.fn(async () => []) },
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      taughtSkill: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: runtimeRun,
      },
      memoryProviders: { resolve: vi.fn(async () => null) },
      memory: { read: vi.fn(async () => ({ documents: [] })) },
      events: { append: vi.fn(async () => undefined), finalizeRun },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(status).toBe("failed");
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: "Connect a model in Settings before running bots.",
      }),
    );
    expect(runtimeRun).not.toHaveBeenCalled();
  });

  it("resolves a per-bot model override with that provider’s credential", async () => {
    const findFirst = vi.fn(
      async (args: { where: { credential?: { provider?: string }; isDefault?: boolean } }) => {
        if (args.where.credential?.provider === "xai") {
          return modelPreference({
            provider: "xai",
            secretId: "secret-xai",
            modelId: "grok-4.6",
            isDefault: false,
          });
        }
        if (args.where.isDefault) {
          return modelPreference({
            provider: "openrouter",
            secretId: "secret-or",
            modelId: "deepseek/deepseek-v4-flash-0731",
            isDefault: true,
          });
        }
        return null;
      },
    );
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      spaceModelPreference: { findFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "xai",
      id: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ credential: { provider: "xai" } }),
      }),
    );
  });

  it("falls back to the Space default when the override provider has no credential", async () => {
    const findFirst = vi.fn(
      async (args: { where: { credential?: { provider?: string }; isDefault?: boolean } }) => {
        if (args.where.credential?.provider === "xai") return null;
        if (args.where.isDefault) {
          return modelPreference({
            provider: "openrouter",
            secretId: "secret-or",
            modelId: "deepseek/deepseek-v4-flash-0731",
            isDefault: true,
          });
        }
        return null;
      },
    );
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      spaceModelPreference: { findFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
      deploymentModelKey: "deployment-openrouter-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      // Override thinking must drop with the override provider/credential unit.
      thinkingLevel: null,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ credential: { provider: "xai" } }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isDefault: true }),
      }),
    );
  });

  it("withholds the deployment key when settings name a different provider", async () => {
    const prisma = {
      bot: { findFirst: vi.fn(async () => null) },
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "anthropic",
          defaultModelId: "claude-sonnet-5",
        })),
      },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
      // PI_DEFAULT_PROVIDER is unset here, so this key belongs to OpenRouter.
      deploymentModelKey: "deployment-openrouter-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({ userId: "user-1", spaceId: "ws-1" });

    expect(model.provider).toBe("anthropic");
    expect(model.apiKey).toBeUndefined();
  });

  it("keeps per-bot thinking when using the Space default model", async () => {
    const findFirst = vi.fn(async (args: { where: { isDefault?: boolean } }) => {
      if (!args.where.isDefault) return null;
      return modelPreference({
        provider: "openrouter",
        secretId: "secret-or",
        modelId: "deepseek/deepseek-v4-flash-0731",
        isDefault: true,
      });
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: null,
          modelId: null,
          thinkingLevel: "high",
        })),
      },
      spaceModelPreference: { findFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      thinkingLevel: "high",
    });
  });
});
