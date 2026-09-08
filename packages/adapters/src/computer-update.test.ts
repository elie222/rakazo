import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { replaceComputer } from "./computer-lifecycle.js";
import {
  performComputerUpdate,
  queueComputerUpdate,
  reconcileComputerUpdates,
} from "./computer-update.js";

vi.mock("./computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycleModule>()),
  replaceComputer: vi.fn(),
}));
const replacement = vi.mocked(replaceComputer);
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
function fixture(status = "queued") {
  const row = {
    id: "update-1",
    computerId: "computer-1",
    botId: "bot-1",
    action: "update",
    status,
    stage: "preparing",
    updatedAt: new Date(0),
    computer: {
      id: "computer-1",
      kind: "fake",
      scope: "team",
      spaceId: "space",
      userId: "user",
      bots: [{ id: "bot-1", name: "Writer" }],
    },
  };
  const computer = {
    updateMany: vi.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: vi.fn(async () => row.computer),
  };
  const computerUpdate = {
    create: vi.fn(async () => row),
    findUniqueOrThrow: vi.fn(async () => row),
    findMany: vi.fn(async () => [row]),
    updateMany: vi.fn(async ({ where, data }) => {
      if (
        where.status &&
        (typeof where.status === "string"
          ? where.status !== row.status
          : !where.status.in.includes(row.status))
      )
        return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    computer,
    bot: { findFirst: vi.fn(async () => ({ userId: "user" })) },
    computerUpdate,
    $transaction: vi.fn(async (fn) => fn(prisma)),
  };
  const jobs = { enqueue: vi.fn(async () => {}) };
  const deps = { prisma, jobs } as unknown as Parameters<typeof performComputerUpdate>[0];
  return { row, computer, computerUpdate, deps, jobs };
}
describe("background computer maintenance", () => {
  it("persists stages and releases its reservation only after completion; redelivery is harmless", async () => {
    const { row, computer, deps } = fixture();
    replacement.mockImplementationOnce(async (_deps, _id, _mode, _ctx, _holder, progress) => {
      for (const stage of ["saving", "recreating", "restoring", "reconnecting"] as const)
        await progress?.(stage);
      return {} as Awaited<ReturnType<typeof replaceComputer>>;
    });
    await performComputerUpdate(deps, row.id);
    expect(row).toMatchObject({ status: "completed", stage: "reconnecting" });
    expect(computer.updateMany).toHaveBeenCalledWith({
      where: { id: row.computerId, maintenanceId: row.id },
      data: { maintenanceId: null },
    });
    await performComputerUpdate(deps, row.id);
    expect(replacement).toHaveBeenCalledOnce();
  });
  it("records a failure without exposing the provider error or replaying replacement", async () => {
    const { row, deps } = fixture();
    replacement.mockRejectedValueOnce(new Error("provider-private-detail"));
    await performComputerUpdate(deps, row.id);
    expect(row.status).toBe("failed");
    expect(JSON.stringify(row)).not.toContain("provider-private-detail");
    await performComputerUpdate(deps, row.id);
    expect(replacement).toHaveBeenCalledOnce();
  });
  it("republishes queued intent after an enqueue failure", async () => {
    const { row, deps, jobs } = fixture();
    jobs.enqueue.mockRejectedValueOnce(new Error("offline"));
    await queueComputerUpdate(deps, row.computerId, row.botId);
    await reconcileComputerUpdates(deps);
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
  });
  it("keeps an interrupted worker reserved instead of repeating a destructive step", async () => {
    const { row, deps, computer } = fixture("running");
    await reconcileComputerUpdates(deps);
    expect(row.status).toBe("interrupted");
    expect(computer.updateMany).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
  });
  it("releases an interrupted reservation only after the worker has settled", async () => {
    const { row, deps, computer } = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    replacement.mockImplementationOnce(async (_deps, _id, _mode, _ctx, _holder, progress) => {
      await pending;
      await progress?.("recreating");
      return {} as Awaited<ReturnType<typeof replaceComputer>>;
    });
    const work = performComputerUpdate(deps, row.id);
    await vi.waitFor(() => expect(replacement).toHaveBeenCalled());
    await reconcileComputerUpdates(deps);
    expect(row.status).toBe("interrupted");
    expect(computer.updateMany).not.toHaveBeenCalled();
    release();
    await work;
    expect(row.status).toBe("failed");
    expect(computer.updateMany).toHaveBeenCalledOnce();
  });

  it("rejects a busy computer before publishing an operation", async () => {
    const { row, deps, computer, jobs } = fixture();
    computer.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(queueComputerUpdate(deps, row.computerId, row.botId)).rejects.toThrow(
      "Computer is busy",
    );
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
