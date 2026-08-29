import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

describe("createRunExecutor", () => {
  it("deactivates one-shot routines after wake without scheduling another wakeup", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          workspaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
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
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany },
          task: { create: vi.fn(async () => ({ id: "task-1" })) },
          run: { create: vi.fn(async () => ({ id: "run-1" })) },
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
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fired", runId: "run-1" }),
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
          workspaceId: "ws-1",
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
          workspaceId: "ws-1",
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
          workspaceId: "ws-1",
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

  it("resolves a per-bot model override with that provider’s credential", async () => {
    const findFirst = vi.fn(async (args: { where: { provider?: string; isDefault?: boolean } }) => {
      if (args.where.provider === "xai") {
        return {
          id: "cred-xai",
          provider: "xai",
          secretId: "secret-xai",
          defaultModel: "grok-4.6",
          isDefault: false,
        };
      }
      if (args.where.isDefault) {
        return {
          id: "cred-default",
          provider: "openrouter",
          secretId: "secret-or",
          defaultModel: "deepseek/deepseek-v4-flash-0731",
          isDefault: true,
        };
      }
      return null;
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      userModelCredential: { findFirst },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "xai",
      id: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: "xai" }),
      }),
    );
  });

  it("falls back to the workspace default when the override provider has no credential", async () => {
    const findFirst = vi.fn(async (args: { where: { provider?: string; isDefault?: boolean } }) => {
      if (args.where.provider === "xai") return null;
      if (args.where.isDefault) {
        return {
          id: "cred-default",
          provider: "openrouter",
          secretId: "secret-or",
          defaultModel: "deepseek/deepseek-v4-flash-0731",
          isDefault: true,
        };
      }
      return null;
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      userModelCredential: { findFirst },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
      deploymentModelKey: "deployment-openrouter-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      workspaceId: "ws-1",
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
        where: expect.objectContaining({ provider: "xai" }),
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
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "anthropic",
          defaultModelId: "claude-sonnet-5",
        })),
      },
      secret: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
      // PI_DEFAULT_PROVIDER is unset here, so this key belongs to OpenRouter.
      deploymentModelKey: "deployment-openrouter-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({ userId: "user-1", workspaceId: "ws-1" });

    expect(model.provider).toBe("anthropic");
    expect(model.apiKey).toBeUndefined();
  });

  it("keeps per-bot thinking when using the workspace default model", async () => {
    const findFirst = vi.fn(async (args: { where: { provider?: string; isDefault?: boolean } }) => {
      if (args.where.isDefault) {
        return {
          id: "cred-default",
          provider: "openrouter",
          secretId: "secret-or",
          defaultModel: "deepseek/deepseek-v4-flash-0731",
          isDefault: true,
        };
      }
      return null;
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: null,
          modelId: null,
          thinkingLevel: "high",
        })),
      },
      userModelCredential: { findFirst },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      thinkingLevel: "high",
    });
  });
});
