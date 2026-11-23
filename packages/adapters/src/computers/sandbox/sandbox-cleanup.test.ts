import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { deleteUnreferencedMachine, recordUnreferencedMachine } from "./sandbox-cleanup.js";
import { MachineRecords, settleMachineCleanup, untilAborted } from "./sandbox-test-support.js";

type Remove = Parameters<typeof deleteUnreferencedMachine>[2];

const BUDGET_MS = 20_000;
const machine = { provider: "fake", machineId: "machine-1" };

/** Runs the cleanup on a faked clock: the machines it reported, and how long it took there. */
async function cleanup(remove: Remove) {
  let elapsedMs = 0;
  const outcome = await settleMachineCleanup(async () => {
    const startedAt = Date.now();
    await deleteUnreferencedMachine(undefined, machine, remove);
    elapsedMs = Date.now() - startedAt;
  });
  return { ...outcome, elapsedMs };
}

describe("deleting a machine nothing points at", () => {
  it("tries a failed delete again and reports nothing once it succeeds", async () => {
    const remove = vi
      .fn<Remove>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(1);

    const { error, left } = await cleanup(remove);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(error).toBeUndefined();
    expect(left).toEqual([]);
  });

  it("reports the machine, without rejecting, when the delete keeps failing", async () => {
    const remove = vi.fn<Remove>().mockRejectedValue(new Error("connection reset"));

    const { error, left } = await cleanup(remove);

    expect(remove).toHaveBeenCalledTimes(4);
    expect(error).toBeUndefined();
    expect(left).toEqual([machine]);
  });

  it("tries again after a refusal, which a machine still being created gives", async () => {
    const remove = vi
      .fn<Remove>()
      .mockRejectedValueOnce(Object.assign(new Error("still creating"), { status: 409 }))
      .mockResolvedValue(undefined);

    const { left } = await cleanup(remove);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(left).toEqual([]);
  });

  it("stops at its budget when the provider asks for a longer wait", async () => {
    const remove = vi
      .fn<Remove>()
      .mockRejectedValue(Object.assign(new Error("rate limited"), { retryAfterMs: 5 * 60_000 }));

    const { left, elapsedMs } = await cleanup(remove);

    expect(remove).toHaveBeenCalledOnce();
    expect(elapsedMs).toBe(BUDGET_MS);
    expect(left).toEqual([machine]);
  });

  it("stops waiting at its budget for a delete that never settles", async () => {
    const remove = vi.fn<Remove>(() => new Promise(() => {}));

    const { error, left, elapsedMs } = await cleanup(remove);

    expect(elapsedMs).toBe(BUDGET_MS);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(error).toBeUndefined();
    expect(left).toEqual([machine]);
  });

  it("ends each try's request with the try, and every try within the budget", async () => {
    const signals: AbortSignal[] = [];
    const allowed: number[] = [];
    const remove = vi.fn<Remove>((signal, timeoutMs) => {
      signals.push(signal);
      allowed.push(timeoutMs);
      return untilAborted(signal);
    });

    const { left, elapsedMs } = await cleanup(remove);

    expect(elapsedMs).toBe(BUDGET_MS);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(allowed[0]).toBe(10_000);
    // The second try gets what the first try and the pause after it left of the budget.
    expect(allowed[1]).toBeGreaterThan(9_000);
    expect(allowed[1]).toBeLessThan(10_000);
    expect(allowed).toHaveLength(2);
    expect(left).toEqual([machine]);
  });

  it("is not held past the budget by a delete with a longer timeout of its own", async () => {
    const remove = vi.fn<Remove>(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("provider timeout")), 60_000);
        }),
    );

    const { left, elapsedMs } = await cleanup(remove);

    expect(elapsedMs).toBe(BUDGET_MS);
    expect(left).toEqual([machine]);
  });

  it("leaves no unhandled rejection when a delete it stopped waiting for fails later", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let fail: Deferred | undefined;
      const remove = vi.fn<Remove>(() => {
        fail = deferred();
        return fail.promise;
      });

      await cleanup(remove);
      fail?.reject(new Error("connection reset, long after"));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("reports the delete's own last failure", async () => {
    const sink = createTestSink();
    vi.useFakeTimers();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      const done = deleteUnreferencedMachine(undefined, machine, () =>
        Promise.reject(new Error("connection reset")),
      );
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      await done;

      expect(sink.events).toMatchObject([
        {
          level: "error",
          message: "sandbox.cleanup_failed",
          ...machine,
          error: { message: "connection reset" },
        },
      ]);
    } finally {
      vi.useRealTimers();
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  describe("with records to hand a machine to", () => {
    /** Runs the cleanup on a faked clock, from a record made when the machine was created. */
    async function cleanupRecorded(remove: Remove, records = new MachineRecords()) {
      let startedAt = 0;
      const outcome = await settleMachineCleanup(async () => {
        startedAt = Date.now();
        await recordUnreferencedMachine(records, machine);
        await deleteUnreferencedMachine(records, machine, remove);
      });
      return { ...outcome, records, due: records.dueIn(startedAt) };
    }

    it("makes the delete due at once when it kept failing", async () => {
      const { due, left } = await cleanupRecorded(
        vi.fn<Remove>().mockRejectedValue(new Error("connection reset")),
      );

      expect(left).toEqual([machine]);
      // When the tries ended, not the 16 minutes the record first allowed its creator.
      expect(due).toMatchObject([machine]);
      expect(due[0]?.dueInMs).toBeLessThanOrEqual(BUDGET_MS);
    });

    it("drops the record once the machine is deleted", async () => {
      const { due, left } = await cleanupRecorded(vi.fn<Remove>().mockResolvedValue(undefined));

      expect(left).toEqual([]);
      expect(due).toEqual([]);
    });

    it("gives a new machine's creator its time before the delete is due", async () => {
      const records = new MachineRecords();
      const startedAt = Date.now();

      await recordUnreferencedMachine(records, machine);
      await recordUnreferencedMachine(records, { ...machine, machineId: "build-1" }, 30 * 60_000);

      const due = records.dueIn(startedAt);
      // A minute past the time given, so the creator's own delete can finish first.
      expect(due[0]?.dueInMs).toBeGreaterThanOrEqual(16 * 60_000);
      expect(due[0]?.dueInMs).toBeLessThan(17 * 60_000);
      expect(due[1]?.dueInMs).toBeGreaterThanOrEqual(31 * 60_000);
    });

    it("writes a record again when the first write fails", async () => {
      const records = new MachineRecords();
      const write = records.record.bind(records);
      const record = vi
        .fn<typeof write>()
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockImplementation(write);
      records.record = record;
      const startedAt = Date.now();

      await settleMachineCleanup(() => recordUnreferencedMachine(records, machine));

      expect(record).toHaveBeenCalledTimes(2);
      expect(records.dueIn(startedAt)).toMatchObject([machine]);
    });

    it("never rejects when the records cannot be written", async () => {
      const broken = new MachineRecords();
      broken.record = () => Promise.reject(new Error("database unavailable"));
      broken.clear = () => Promise.reject(new Error("database unavailable"));

      await settleMachineCleanup(() => recordUnreferencedMachine(broken, machine));
      const failed = await cleanupRecorded(
        vi.fn<Remove>().mockRejectedValue(new Error("connection reset")),
        broken,
      );
      const deleted = await cleanupRecorded(vi.fn<Remove>().mockResolvedValue(undefined), broken);

      expect(failed.error).toBeUndefined();
      expect(failed.left).toEqual([machine]);
      expect(deleted.error).toBeUndefined();
    });
  });
});
