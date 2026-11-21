import type { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { findPendingRoutineTick, routineTimerNonce } from "./routine-coalescing.js";

const config = {
  routineId: "routine-1",
  spaceId: "space-1",
  botId: "bot-1",
  userId: "user-1",
  threadId: "thread-1",
  prompt: "check current work",
};
function fixture(
  clientNonce: string | null = routineTimerNonce("routine-1", "2026-01-01T00:00:00Z"),
) {
  const updatedAt = new Date("2026-01-01T00:00:00Z");
  const findMany = vi.fn(async (_args: Prisma.RunFindManyArgs) =>
    clientNonce?.startsWith("routine-timer:routine-1:")
      ? [
          {
            id: "run-1",
            taskId: "task-1",
            leaseFence: 0,
            updatedAt,
            task: { prompt: config.prompt },
          },
        ]
      : [],
  );
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const tx = {
    run: { findMany, updateMany },
    computerExecutionLease: { findMany: vi.fn(async () => []) },
  } as unknown as Prisma.TransactionClient;
  return { tx, findMany, updateMany, updatedAt };
}
describe("pending routine timer coalescing", () => {
  it("reuses only pristine matching work and keeps its schedule and timestamps", async () => {
    const { tx, findMany, updateMany, updatedAt } = fixture();
    expect(await findPendingRoutineTick(tx, config)).toEqual({ id: "run-1", taskId: "task-1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "queued",
          retryOfRunId: null,
          firstResponseAt: null,
          attempts: { none: {} },
          effects: { none: {} },
          steeringMessages: { none: {} },
          task: { status: "queued" },
          modelPinned: false,
          modelProvider: null,
          modelId: null,
        }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { ...findMany.mock.calls[0]![0]!.where, id: "run-1", leaseFence: 0 },
      data: { updatedAt },
    });
  });
  it("passes over queued work started under an older prompt", async () => {
    const { tx, findMany } = fixture();
    const updatedAt = new Date("2026-01-01T00:00:00Z");
    const older = Array.from({ length: 100 }, (_, index) => ({
      id: `old-${index}`,
      taskId: `old-task-${index}`,
      leaseFence: 0,
      updatedAt,
      createdAt: updatedAt,
      task: { prompt: "an earlier prompt" },
    }));
    findMany.mockResolvedValueOnce(older as never).mockResolvedValueOnce([
      {
        id: "run-1",
        taskId: "task-1",
        leaseFence: 0,
        updatedAt,
        task: { prompt: config.prompt },
      },
    ] as never);
    expect(await findPendingRoutineTick(tx, config)).toEqual({ id: "run-1", taskId: "task-1" });
    expect(findMany.mock.calls[1]![0]!.where!.OR).toEqual([
      { createdAt: { gt: updatedAt } },
      { createdAt: updatedAt, id: { gt: "old-99" } },
    ]);
  });
  it("looks past a page whose only match holds the computer", async () => {
    const { tx, findMany } = fixture();
    const updatedAt = new Date("2026-01-01T00:00:00Z");
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: `held-${index}`,
      taskId: `held-task-${index}`,
      leaseFence: 0,
      updatedAt,
      createdAt: updatedAt,
      task: { prompt: index === 0 ? config.prompt : "an earlier prompt" },
    }));
    findMany.mockResolvedValueOnce(first as never).mockResolvedValueOnce([
      {
        id: "run-1",
        taskId: "task-1",
        leaseFence: 0,
        updatedAt,
        task: { prompt: config.prompt },
      },
    ] as never);
    vi.mocked(tx.computerExecutionLease.findMany).mockResolvedValueOnce([
      { runId: "held-0" },
    ] as never);
    expect(await findPendingRoutineTick(tx, config)).toEqual({ id: "run-1", taskId: "task-1" });
  });
  it("preserves manual runs even with no client nonce", async () => {
    const { tx, updateMany } = fixture(null);
    expect(await findPendingRoutineTick(tx, config)).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });
  it("never mistakes an explicitly identified manual test for a timer", async () => {
    const { tx, updateMany } = fixture("manual-test-1");
    expect(await findPendingRoutineTick(tx, config)).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });
  it("does not reuse a run claimed between selection and locking", async () => {
    const { tx, updateMany } = fixture();
    updateMany.mockResolvedValue({ count: 0 });
    expect(await findPendingRoutineTick(tx, config)).toBeNull();
  });
  it("requires the same explicit model pin", async () => {
    const { tx, findMany } = fixture();
    await findPendingRoutineTick(tx, {
      ...config,
      modelProvider: "provider-1",
      modelId: "model-1",
      modelPinned: true,
      thinkingLevel: "high",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          modelProvider: "provider-1",
          modelId: "model-1",
          modelPinned: true,
          thinkingLevel: "high",
        }),
      }),
    );
  });
  it("preserves a run holding the computer", async () => {
    const { tx, updateMany } = fixture();
    vi.mocked(tx.computerExecutionLease.findMany).mockResolvedValue([{ runId: "run-1" }] as never);
    expect(await findPendingRoutineTick(tx, config)).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
