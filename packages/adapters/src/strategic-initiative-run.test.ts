import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { turnMemoryCaptureEligible } from "./run-context.js";
import { threadContextForRun } from "./run-instructions.js";
import { createReplyState } from "./run-progress.js";
import { completeRun, consumeRunEvents } from "./run-turn.js";

async function context() {
  const createMany = vi.fn(async () => ({ count: 1 }));
  const append = vi.fn();
  const finalizeRun = vi.fn(async () => ({}));
  const enqueue = vi.fn(async () => {});
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
    jobs: { enqueue },
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
    // No memory provider is configured in these runs, so nothing is recalled or captured.
    memory: {
      semantic: null,
      turnMemory: null,
      scope: null,
      captureEligible: false,
      injectedIds: [],
    },
    allowSilentEmptyRun: true,
    settleRunningHelpers: async () => {},
    stopHeartbeatAfterCompletion: () => {},
  } as unknown as RunContext;
  return { ctx, createMany, append, finalizeRun, enqueue };
}

async function* events(...items: AgentRuntimeEvent[]) {
  yield* items;
}

describe("turn memory capture eligibility", () => {
  it.each([
    { label: "a non-owner message", trigger: "messaging", nonOwner: true, channel: false },
    { label: "a messaging channel", trigger: "messaging", nonOwner: true, channel: true },
    { label: "a routine", trigger: "routine", nonOwner: false, channel: false },
    { label: "a webhook", trigger: "webhook", nonOwner: false, channel: false },
    { label: "ticket work", trigger: "tickets", nonOwner: false, channel: false },
    { label: "a peer request", trigger: "bot_message", nonOwner: false, channel: false },
    { label: "a creation intro", trigger: "created", nonOwner: false, channel: false },
  ])("does not mark or enqueue capture for $label", async ({ trigger, nonOwner, channel }) => {
    const { ctx, finalizeRun, enqueue } = await context();
    ctx.run.trigger = trigger;
    const threadContext = threadContextForRun(
      trigger,
      { messages: [], summary: null, historyCompactedUpToSeq: null },
      nonOwner || channel,
    );
    ctx.memory.turnMemory = { beforeTurn: vi.fn(), captureTurn: vi.fn() };
    ctx.memory.scope = "isolated";
    ctx.memory.captureEligible = turnMemoryCaptureEligible({
      hasLifecycle: true,
      memoryScope: ctx.memory.scope,
      includeSemanticRecall: threadContext.includeSemanticRecall,
      nonOwnerChatRun: nonOwner || channel,
      trigger,
    });

    expect(ctx.memory.captureEligible).toBe(false);
    await completeRun(ctx);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ memoryCapture: null }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("allows an owner's conversation only with a lifecycle and scope", () => {
    const options = {
      hasLifecycle: true,
      memoryScope: "isolated" as const,
      includeSemanticRecall: true,
      nonOwnerChatRun: false,
      trigger: "user",
      // A user turn always carries the message it came from; the gate now requires it.
      sourceMessageId: "message-1",
      sourceRole: "user",
    };
    expect(turnMemoryCaptureEligible(options)).toBe(true);
    expect(turnMemoryCaptureEligible({ ...options, sourceMessageId: null })).toBe(false);
    expect(turnMemoryCaptureEligible({ ...options, hasLifecycle: false })).toBe(false);
    expect(turnMemoryCaptureEligible({ ...options, memoryScope: null })).toBe(false);
  });

  it("does not capture a run that handed off after recall", async () => {
    const { ctx, finalizeRun, enqueue } = await context();
    ctx.memory.turnMemory = { beforeTurn: vi.fn(), captureTurn: vi.fn() };
    ctx.memory.scope = "isolated";
    ctx.memory.captureEligible = true;
    ctx.memory.injectedIds = ["memory-1"];
    ctx.state.handedOff = true;

    await completeRun(ctx);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ memoryCapture: null }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("passes the frozen scope and injected ids to finalization and enqueues capture", async () => {
    const { ctx, finalizeRun, enqueue } = await context();
    ctx.memory.turnMemory = { beforeTurn: vi.fn(), captureTurn: vi.fn() };
    ctx.memory.captureEligible = true;
    ctx.memory.scope = "shared";
    ctx.memory.injectedIds = ["injected-memory-1"];

    await completeRun(ctx);
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryCapture: { sourceMemoryIds: ["injected-memory-1"], scope: "shared" },
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "memory.capture", payload: { runId: ctx.runId } }),
    );
  });

  it("does not finalize or enqueue capture without a scope", async () => {
    const { ctx, finalizeRun, enqueue } = await context();
    ctx.memory.captureEligible = true;
    ctx.memory.scope = null;

    await completeRun(ctx);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ memoryCapture: null }));
    expect(enqueue).not.toHaveBeenCalled();
  });
});

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
