import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { createReplyState } from "./run-progress.js";
import { completeRun, consumeRunEvents } from "./run-turn.js";

async function context() {
  const createMany = vi.fn(async () => ({ count: 1 }));
  const append = vi.fn();
  const finalizeRun = vi.fn(async () => ({}));
  const tx = { usageRecord: { createMany } };
  const deps = {
    prisma: {
      message: { findMany: async () => [] },
      run: { updateMany: async () => ({ count: 1 }) },
      thread: {
        findUniqueOrThrow: async () => ({ nextMessageSeq: 0, historyCompactedUpToSeq: null }),
      },
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    },
    events: { append, finalizeRun },
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    taskId: "task-1",
    trigger: "routine",
    clientNonce: "strategic-initiative:bot-1:1",
  };
  const reply = await createReplyState(deps as never, run as never, []);
  const ctx = {
    deps,
    run,
    runId: run.id,
    workerId: "worker-1",
    fence: 1,
    bot: { id: run.botId },
    thread: { id: run.threadId },
    attempt: { id: "attempt-1" },
    state: {
      reply,
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: Date.now() },
      computerUse: {},
    },
    abortController: new AbortController(),
    computer: { lazy: { throwIfFailed: () => {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained: () => {} } },
    source: {},
    secrets: [],
    allowSilentEmptyRun: true,
    settleRunningHelpers: async () => {},
    stopHeartbeatAfterCompletion: () => {},
  } as unknown as RunContext;
  return { ctx, createMany, append, finalizeRun };
}

async function* events(...items: AgentRuntimeEvent[]) {
  yield* items;
}

describe("daily check-in routine execution", () => {
  it("records ordinary routine usage even when the reply is silent", async () => {
    const { ctx, createMany, finalizeRun, append } = await context();
    await consumeRunEvents(
      ctx,
      events(
        {
          type: "usage",
          provider: "fixture",
          model: "test",
          inputTokens: 10,
          outputTokens: 2,
          costUsd: 0.01,
        },
        { type: "done", text: "NO_RESPONSE" },
      ),
    );
    await completeRun(ctx);
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            runId: "run-1",
            userId: "user-1",
            spaceId: "space-1",
            costUsd: 0.01,
            operationKind: "answer",
          }),
        ],
      }),
    );
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [], markUnread: false }),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("posts a non-empty final reply to the bot's chat", async () => {
    const { ctx, finalizeRun } = await context();
    const reminder = "The release check is still open. Next step: compare the latest tag.";
    await consumeRunEvents(ctx, events({ type: "done", text: reminder }));
    await completeRun(ctx);
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [{ kind: "text", text: reminder }],
        markUnread: true,
      }),
    );
  });

  it("does not apply scripted files or memory on completion", async () => {
    const { ctx } = await context();
    ctx.script = [
      {
        files: [{ path: "injected.txt", content: "untrusted" }],
        memory: [{ scope: "bot", path: "injected.md", content: "untrusted" }],
      },
    ];
    await completeRun(ctx);
    // The context deliberately has no sandbox or memory writer: reaching either fails.
    expect(ctx.state.terminalCheckpointComplete).toBe(true);
  });

  it("refuses a runtime takeover before starting the computer", async () => {
    const { ctx } = await context();
    await expect(
      consumeRunEvents(ctx, events({ type: "takeover", reason: "injected" })),
    ).rejects.toThrow("Daily check-ins cannot start a computer or helper.");
  });
});
