import type {
  BackgroundJobHandlers,
  SandboxProvider,
  UnreferencedMachine,
} from "@rakazo/adapter-kit";
import { machineCleanupJobKey } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { machineCleanupRecords, retryMachineCleanup } from "./machine-cleanup.js";
import { deleteUnreferencedMachine, recordUnreferencedMachine } from "./sandbox-cleanup.js";
import { settleMachineCleanup } from "./sandbox-test-support.js";
import { InMemoryJobQueue } from "./wakeup.js";

type ComputerRow = {
  id: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  state: string;
  updatedAt: Date;
  maintenanceId: string | null;
  restorePending: boolean;
  /** Whether a run on this computer still heartbeats, or an execution lease on it is live. */
  held?: "run" | "lease";
};

/**
 * Stored computers, answering the job's read as the database would, and the lifecycle's write
 * that ends an abandoned boot: it lands only on the claim it was read with, and never while an
 * execution lease is live.
 */
function computers(rows: ComputerRow[]) {
  const findMany = vi.fn(async ({ where }: { where: { OR: Array<Partial<ComputerRow>> } }) =>
    rows
      .filter((row) =>
        where.OR.some((filter) =>
          Object.entries(filter).every(([key, value]) => row[key as keyof ComputerRow] === value),
        ),
      )
      .map((row) => ({ ...row })),
  );
  const updateMany = vi.fn(
    async ({ where, data }: { where: Partial<ComputerRow>; data: Partial<ComputerRow> }) => {
      const row = rows.find(
        (candidate) =>
          candidate.id === where.id &&
          candidate.state === where.state &&
          candidate.updatedAt.getTime() === where.updatedAt?.getTime() &&
          candidate.maintenanceId === where.maintenanceId &&
          candidate.held !== "lease",
      );
      if (!row) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date() });
      return { count: 1 };
    },
  );
  const findFirst = vi.fn(async ({ where }: { where: { bot: { computerId: string } } }) =>
    rows.some((row) => row.id === where.bot.computerId && row.held === "run")
      ? { id: "run-1" }
      : null,
  );
  return { computer: { findMany, updateMany }, run: { findFirst } } as unknown as PrismaClient;
}

/** A provider's machines, deleted by id alone. */
function provider(existing: string[]) {
  const machines = new Set(existing);
  const deleteMachine = vi.fn(async (machine: UnreferencedMachine) => {
    machines.delete(machine.machineId);
  });
  return { machines, deleteMachine, sandbox: { deleteMachine } as unknown as SandboxProvider };
}

const machine = { provider: "fake", machineId: "machine-1", homeKey: "home-1" };
const key = machineCleanupJobKey(machine.provider, machine.machineId);
const stored = (row: Partial<ComputerRow>): ComputerRow => ({
  id: row.homeKey ?? "home-1",
  homeKey: "home-1",
  kind: "fake",
  providerRef: null,
  state: "running",
  updatedAt: new Date(),
  maintenanceId: null,
  restorePending: false,
  ...row,
});
/** Older than the lifecycle takes a live boot's claim to be. */
const longAgo = () => new Date(Date.now() - 60 * 60_000);

afterEach(() => installLogger(createLogger({ service: "test", level: "off", sinks: [] })));

describe("the cleanup of a machine no computer points at", () => {
  /** The queue running the cleanup job against these computers and this provider. */
  function queued(rows: ComputerRow[], existing = [machine.machineId]) {
    const queue = new InMemoryJobQueue();
    const fake = provider(existing);
    const deps = { prisma: computers(rows), sandbox: fake.sandbox };
    void queue.start({
      "computer.machine-cleanup": (payload, _execution, attempt) =>
        retryMachineCleanup(deps, payload, attempt),
    } as BackgroundJobHandlers);
    return { queue, records: machineCleanupRecords(queue), ...fake };
  }

  it("deletes later, from the job's payload alone, a machine whose delete kept failing", async () => {
    const { queue, records, machines, deleteMachine } = queued([]);

    const { left } = await settleMachineCleanup(() =>
      deleteUnreferencedMachine(records, machine, () =>
        Promise.reject(new Error("connection reset")),
      ),
    );
    expect(left).toEqual([{ provider: "fake", machineId: "machine-1" }]);
    await queue.awaitIdle();

    expect(deleteMachine).toHaveBeenCalledWith(machine, expect.any(AbortSignal));
    expect(machines.size).toBe(0);
    expect(queue.keyedJob(key)).toBeUndefined();
    expect(queue.failureCounts()).toEqual([]);
  });

  it("removes the job when the machine is deleted where it was created", async () => {
    const { queue, records, deleteMachine } = queued([]);

    await recordUnreferencedMachine(records, machine);
    expect(queue.keyedJob(key)?.availableAt?.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);
    await deleteUnreferencedMachine(records, machine, async () => undefined);

    expect(queue.keyedJob(key)).toBeUndefined();
    await queue.awaitIdle();
    expect(deleteMachine).not.toHaveBeenCalled();
  });

  it("counts a machine that is already gone as deleted", async () => {
    const { sandbox, deleteMachine } = provider([]);

    await expect(
      retryMachineCleanup({ prisma: computers([]), sandbox }, machine),
    ).resolves.toBeUndefined();
    expect(deleteMachine).toHaveBeenCalledOnce();
  });

  it("never deletes a machine a computer stores, whatever that computer's state", async () => {
    for (const state of ["running", "stopped", "error"]) {
      const { sandbox, machines, deleteMachine } = provider(["machine-1"]);
      const prisma = computers([stored({ providerRef: "machine-1", state })]);

      await expect(retryMachineCleanup({ prisma, sandbox }, machine)).resolves.toBeUndefined();

      expect(deleteMachine).not.toHaveBeenCalled();
      expect(machines.has("machine-1")).toBe(true);
    }
  });

  it("ends without deleting when its record outlived the start that stored the machine", async () => {
    const { queue, records, machines, deleteMachine } = queued([
      stored({ providerRef: "machine-1" }),
    ]);

    await records.record(machine, new Date());
    await queue.awaitIdle();

    expect(deleteMachine).not.toHaveBeenCalled();
    expect(machines.has("machine-1")).toBe(true);
    expect(queue.keyedJob(key)).toBeUndefined();
    expect(queue.failureCounts()).toEqual([]);
  });

  it("deletes a machine only another kind's computer names", async () => {
    const { sandbox, machines } = provider(["machine-1"]);
    const prisma = computers([
      stored({ homeKey: "home-2", kind: "other", providerRef: "machine-1" }),
    ]);

    await retryMachineCleanup({ prisma, sandbox }, machine);

    expect(machines.size).toBe(0);
  });

  it("waits while the computer it was created for is still starting, then keeps what that start stored", async () => {
    const row = stored({ state: "booting" });
    const { sandbox, machines, deleteMachine } = provider(["machine-1"]);
    const deps = { prisma: computers([row]), sandbox };

    await expect(retryMachineCleanup(deps, machine)).rejects.toThrow("still in progress");
    expect(deleteMachine).not.toHaveBeenCalled();

    // Activation stores the machine and leaves "booting" in one write.
    Object.assign(row, { state: "running", providerRef: "machine-1" });
    await expect(retryMachineCleanup(deps, machine)).resolves.toBeUndefined();

    expect(deleteMachine).not.toHaveBeenCalled();
    expect(machines.has("machine-1")).toBe(true);
  });

  it("deletes the machine once that start ended without storing it", async () => {
    const row = stored({ state: "booting" });
    const { sandbox, machines } = provider(["machine-1"]);
    const deps = { prisma: computers([row]), sandbox };

    await expect(retryMachineCleanup(deps, machine)).rejects.toThrow("still in progress");
    Object.assign(row, { state: "running", providerRef: "machine-2" });
    await retryMachineCleanup(deps, machine);

    expect(machines.size).toBe(0);
  });

  it("waits while a computer that stores the machine is starting, as it may be replacing it", async () => {
    const { sandbox, deleteMachine } = provider(["machine-1"]);
    const prisma = computers([
      stored({ homeKey: "home-2", providerRef: "machine-1", state: "booting" }),
    ]);

    await expect(
      retryMachineCleanup({ prisma, sandbox }, { provider: "fake", machineId: "machine-1" }),
    ).rejects.toThrow("still in progress");
    expect(deleteMachine).not.toHaveBeenCalled();
  });

  it("ends a start that died, then deletes the machine it never stored", async () => {
    const row = stored({ state: "booting", updatedAt: longAgo() });
    const { sandbox, machines } = provider(["machine-1"]);

    await retryMachineCleanup({ prisma: computers([row]), sandbox }, machine);

    expect(machines.size).toBe(0);
    // Left as a failed start leaves it: startable, and restored when it next starts.
    expect(row).toMatchObject({ state: "error", providerRef: null, restorePending: true });
  });

  it("ends a start that died but keeps the machine its computer stores", async () => {
    const row = stored({ state: "booting", providerRef: "machine-1", updatedAt: longAgo() });
    const { sandbox, machines, deleteMachine } = provider(["machine-1"]);

    await retryMachineCleanup({ prisma: computers([row]), sandbox }, machine);

    expect(deleteMachine).not.toHaveBeenCalled();
    expect(machines.has("machine-1")).toBe(true);
    expect(row).toMatchObject({ state: "error", providerRef: "machine-1" });
  });

  it.each([
    ["a run on its computer still heartbeats", { held: "run" }],
    ["an execution lease on its computer is live", { held: "lease" }],
    ["an update has reserved its computer", { maintenanceId: "update-1" }],
  ] as const)("leaves an old start alone while %s", async (_name, holder) => {
    const row = stored({ state: "booting", updatedAt: longAgo(), ...holder });
    const { sandbox, deleteMachine } = provider(["machine-1"]);

    await expect(
      retryMachineCleanup({ prisma: computers([row]), sandbox }, machine),
    ).rejects.toThrow("still in progress");

    expect(deleteMachine).not.toHaveBeenCalled();
    expect(row.state).toBe("booting");
  });

  it("leaves a start alone that took the abandoned one over after the read", async () => {
    const row = stored({ state: "booting", updatedAt: longAgo() });
    const { sandbox, deleteMachine } = provider(["machine-1"]);
    const prisma = computers([row]);
    // A new start claims the computer between the job's read and its write.
    vi.mocked(prisma.computer.findMany).mockImplementationOnce((async () => {
      const read = [{ ...row }];
      row.updatedAt = new Date();
      return read;
    }) as unknown as typeof prisma.computer.findMany);

    await expect(retryMachineCleanup({ prisma, sandbox }, machine)).rejects.toThrow(
      "still in progress",
    );

    expect(deleteMachine).not.toHaveBeenCalled();
    expect(row.state).toBe("booting");
  });

  it("keeps failing, and so being retried, while no provider can delete by id", async () => {
    const deps = { prisma: computers([]), sandbox: {} as SandboxProvider };

    await expect(retryMachineCleanup(deps, machine)).rejects.toThrow("cannot delete");
  });

  it("reports the machine at error level only when its last try fails", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const outage = new Error("provider unavailable");
    const sandbox = { deleteMachine: () => Promise.reject(outage) } as unknown as SandboxProvider;
    const deps = { prisma: computers([]), sandbox };

    await expect(retryMachineCleanup(deps, machine, { number: 19, max: 20 })).rejects.toBe(outage);
    expect(sink.events).toEqual([]);

    await expect(retryMachineCleanup(deps, machine, { number: 20, max: 20 })).rejects.toBe(outage);
    expect(sink.events).toMatchObject([
      {
        level: "error",
        message: "sandbox.cleanup_exhausted",
        provider: "fake",
        machineId: "machine-1",
        error: { message: "provider unavailable" },
      },
    ]);
  });
});
