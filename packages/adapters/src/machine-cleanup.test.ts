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

type ComputerRow = { homeKey: string; kind: string; providerRef: string | null; state: string };

/** Stored computers, answering the one read the job makes as the database would. */
function computers(rows: ComputerRow[]) {
  const findMany = vi.fn(async ({ where }: { where: { OR: Array<Partial<ComputerRow>> } }) =>
    rows.filter((row) =>
      where.OR.some((filter) =>
        Object.entries(filter).every(([key, value]) => row[key as keyof ComputerRow] === value),
      ),
    ),
  );
  return { computer: { findMany } } as unknown as PrismaClient;
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
  homeKey: "home-1",
  kind: "fake",
  providerRef: null,
  state: "running",
  ...row,
});

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
