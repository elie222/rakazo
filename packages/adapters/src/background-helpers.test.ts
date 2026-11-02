import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { startBackgroundHelper } from "./background-helpers.js";
import type { RunContext } from "./run-context.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "card" })),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

const START = {
  name: "scout",
  task: "compare the venues",
  instructions: "",
  modelProvider: "",
  modelId: "",
  executionId: "call-1",
  effectKey: "effect-1",
};

function harness(overrides: { trigger?: string; threadBotId?: string | null } = {}) {
  const createRun = vi.fn(async (_args: unknown) => ({ id: "helper-run" }));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: { create: vi.fn(async () => ({ id: "helper-thread" })) },
    task: { create: vi.fn(async () => ({ id: "helper-task" })) },
    run: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: createRun,
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const enqueue = vi.fn(async () => undefined);
  const ctx = {
    deps: { prisma, events: { notify: vi.fn(async () => undefined) }, jobs: { enqueue } },
    run: { id: "run-1", spaceId: "space", userId: "user", trigger: overrides.trigger ?? "user" },
    runId: "run-1",
    bot: { id: "bot" },
    thread: {
      id: "chat",
      botId: overrides.threadBotId === undefined ? "bot" : overrides.threadBotId,
    },
  } as unknown as RunContext;
  return { ctx, prisma, createRun, enqueue };
}

describe("starting a background helper", () => {
  it("starts one from the owner's own chat and queues its run", async () => {
    const h = harness();
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toMatchObject({ ok: true });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "helper-thread",
        trigger: "helper",
        sourceMessageId: "card",
        status: "queued",
      }),
      select: { id: true },
    });
    expect(h.createRun.mock.calls[0]?.[0]).not.toHaveProperty("data.modelPinned");
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("helper-run"));
  });

  it.each([
    ["a group or connected team chat", { threadBotId: null }],
    ["a linked Telegram or SMS chat", { trigger: "messaging" }],
    ["a routine", { trigger: "routine" }],
    ["another bot's request", { trigger: "bot_message" }],
    ["a helper's result coming back", { trigger: "helper_result" }],
  ])("refuses to start one from %s", async (_label, overrides) => {
    const h = harness(overrides);
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toEqual({
      error: expect.stringContaining("only from the user's own app chat"),
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("pins the model it was asked for, and needs both halves of it", async () => {
    const h = harness();
    await startBackgroundHelper(h.ctx, { ...START, modelProvider: "openai", modelId: "gpt-x" });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelProvider: "openai",
        modelId: "gpt-x",
        modelPinned: true,
      }),
      select: { id: true },
    });
    const half = harness();
    await expect(
      startBackgroundHelper(half.ctx, { ...START, modelProvider: "openai" }),
    ).resolves.toEqual({ error: "model_provider and model_id must both be set" });
    expect(half.prisma.$transaction).not.toHaveBeenCalled();
  });
});
