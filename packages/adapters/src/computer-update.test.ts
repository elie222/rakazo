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

  it("claims maintenance and an idle takeover together, then revokes before publishing", async () => {
    const harness = takeoverQueue();
    let revoked = false;
    harness.setScreenControl.mockImplementation(async () => {
      revoked = true;
    });
    harness.jobs.enqueue.mockImplementation(async () => {
      expect(revoked).toBe(true);
    });

    await queueComputerUpdate(harness.deps, "computer-1", "bot-1");

    expect(harness.computer.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          controlHolder: "user",
          controlBotId: "bot-1",
          controlRunId: null,
          controlLeaseId: "lease-1",
        }),
        data: { controlHolder: "none" },
      }),
    );
    expect(harness.computer.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          controlHolder: { not: "user" },
          controlLeaseId: "lease-1",
        }),
        data: { maintenanceId: "update-1" },
      }),
    );
    expect(harness.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          maintenanceId: "update-1",
          controlLeaseId: "lease-1",
          controlRunId: null,
        }),
        data: expect.objectContaining({ controlLeaseId: null, controlBotId: null }),
      }),
    );
    expect(harness.setScreenControl).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "provider-1" }),
      false,
      expect.anything(),
      "lease-1",
    );
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("drops the maintenance claim when provider revocation fails", async () => {
    const harness = takeoverQueue();
    harness.setScreenControl.mockRejectedValue(new Error("provider unavailable"));

    await expect(queueComputerUpdate(harness.deps, "computer-1", "bot-1")).rejects.toThrow(
      "Computer is busy",
    );

    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(harness.computer.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "computer-1",
        maintenanceId: "update-1",
        controlHolder: "none",
        controlLeaseId: "lease-1",
        controlRunId: null,
      },
      data: {
        maintenanceId: null,
        controlHolder: "user",
        controlBotId: "bot-1",
        controlRunId: null,
      },
    });
    expect(harness.computerUpdate.deleteMany).toHaveBeenCalledWith({
      where: { id: "update-1", status: "reserving" },
    });
  });

  it("does not release a takeover a run is already waiting on", async () => {
    const harness = takeoverQueue({ controlRunId: "run-1" });

    await expect(queueComputerUpdate(harness.deps, "computer-1", "bot-1")).rejects.toThrow(
      "Computer is busy",
    );

    expect(harness.computer.updateMany).not.toHaveBeenCalled();
    expect(harness.setScreenControl).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("aborts when the idle-takeover CAS loses to a waiting run", async () => {
    const harness = takeoverQueue();
    harness.computer.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(queueComputerUpdate(harness.deps, "computer-1", "bot-1")).rejects.toThrow(
      "Computer is busy",
    );

    expect(harness.setScreenControl).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(harness.computerUpdate.create).not.toHaveBeenCalled();
  });

  it("refuses maintenance while a failed revoke still holds a lease", async () => {
    const harness = takeoverQueue({
      controlHolder: "none",
      controlBotId: null,
      controlRunId: null,
    });

    await expect(queueComputerUpdate(harness.deps, "computer-1", "bot-1")).rejects.toThrow(
      "Computer is busy",
    );

    expect(harness.computer.updateMany).not.toHaveBeenCalled();
    expect(harness.setScreenControl).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });
});

function takeoverQueue(
  overrides: {
    controlHolder?: string;
    controlBotId?: string | null;
    controlRunId?: string | null;
  } = {},
) {
  const computerRow = {
    id: "computer-1",
    kind: "fake",
    scope: "team",
    spaceId: "space",
    userId: "user",
    homeKey: "bot-1",
    providerRef: "provider-1",
    state: "running",
    maintenanceId: null,
    controlHolder: "user",
    controlBotId: "bot-1" as string | null,
    controlRunId: null as string | null,
    controlLeaseId: "lease-1" as string | null,
    controlLeaseExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
  const updateRow = {
    id: "update-1",
    computerId: computerRow.id,
    botId: "bot-1",
    action: "update",
    status: "queued",
    stage: "preparing",
    computer: { ...computerRow, bots: [{ id: "bot-1", name: "Writer" }] },
  };
  const computer = {
    updateMany: vi.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: vi.fn(async () => computerRow),
  };
  const computerUpdate = {
    create: vi.fn(async ({ data }: { data?: { status?: string } }) => {
      if (data?.status) updateRow.status = data.status;
      return updateRow;
    }),
    findUniqueOrThrow: vi.fn(async () => updateRow),
    updateMany: vi.fn(
      async ({ where, data }: { where: { status?: string }; data?: { status?: string } }) => {
        if (where.status && where.status !== updateRow.status) return { count: 0 };
        if (data) Object.assign(updateRow, data);
        return { count: 1 };
      },
    ),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    computer,
    computerUpdate,
    bot: { findFirst: vi.fn(async () => ({ thread: { id: "thread-1" } })) },
  };
  const jobs = { enqueue: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
  const setScreenControl = vi.fn(async () => {});
  const events = { append: vi.fn(async () => ({ threadId: "thread-1", seq: 1 })) };
  const deps = { prisma, jobs, sandbox: { setScreenControl }, events } as unknown as Parameters<
    typeof queueComputerUpdate
  >[0];
  return { computer, computerRow, computerUpdate, deps, jobs, setScreenControl };
}
