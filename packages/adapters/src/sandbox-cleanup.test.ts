import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { deleteUnreferencedMachine } from "./sandbox-cleanup.js";
import { settleMachineCleanup, untilAborted } from "./sandbox-test-support.js";

type Remove = Parameters<typeof deleteUnreferencedMachine>[2];

const BUDGET_MS = 20_000;
const machine = { provider: "fake", machineId: "machine-1" };

/** Runs the cleanup on a faked clock: the machines it reported, and how long it took there. */
async function cleanup(remove: Remove) {
  let elapsedMs = 0;
  const outcome = await settleMachineCleanup(async () => {
    const startedAt = Date.now();
    await deleteUnreferencedMachine("fake", "machine-1", remove);
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
      let fail: (error: Error) => void = () => {};
      const remove = vi.fn<Remove>(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      );

      await cleanup(remove);
      fail(new Error("connection reset, long after"));
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
      const done = deleteUnreferencedMachine("fake", "machine-1", () =>
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
});
