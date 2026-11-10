import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { stopWithin } from "./shutdown.js";

afterEach(() => {
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
    const stalled = new Promise(() => undefined);
    const returned = await Promise.race([
      stopWithin(stalled, "stalled step", 20).then(() => "returned" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(returned).toBe("returned");
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
    await stopWithin(step, "late failure", 20);
    rejectStep(new Error("arrived after the bound"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
