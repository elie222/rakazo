import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopWithin } from "./shutdown.js";

afterEach(() => {
  vi.useRealTimers();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("stopWithin", () => {
  it("returns when the step completes", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    await stopWithin(Promise.resolve(), "healthy step", 20);
    expect(sink.events).toEqual([]);
  });

  it("rejects when the step fails", async () => {
    const failure = new Error("fixture step failure");
    await expect(stopWithin(Promise.reject(failure), "failing step", 20)).rejects.toBe(failure);
  });

  it("returns with a warning when the step stalls", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    vi.useFakeTimers();
    let returned = false;
    void stopWithin(new Promise(() => undefined), "stalled step", 20).then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(19);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(returned).toBe(true);
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "worker.shutdown_step_timed_out",
        step: "stalled step",
      }),
    ]);
  });

  it("leaves a failure that arrives after the bound unreported as unhandled", async () => {
    let rejectStep!: (reason: unknown) => void;
    const step = new Promise<void>((_resolve, reject) => {
      rejectStep = reject;
    });
    vi.useFakeTimers();
    const stopped = stopWithin(step, "late failure", 20);
    await vi.advanceTimersByTimeAsync(20);
    await stopped;
    vi.useRealTimers();
    rejectStep(new Error("arrived after the bound"));
    // Node reports an unhandled rejection once the event loop turns; vitest fails on it.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
