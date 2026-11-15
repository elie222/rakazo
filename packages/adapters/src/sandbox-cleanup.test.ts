import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteUnreferencedMachine } from "./sandbox-cleanup.js";

function reported() {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  return sink.events;
}

async function settled(cleanup: Promise<void>) {
  let done = false;
  void cleanup.then(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(1_000);
}

describe("deleting a machine nothing points at", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  it("tries a failed delete again and reports nothing once it succeeds", async () => {
    vi.useFakeTimers();
    const events = reported();
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(1);

    await settled(deleteUnreferencedMachine("fake", "machine-1", remove));

    expect(remove).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
  });

  it("reports the machine, without rejecting, when the delete keeps failing", async () => {
    vi.useFakeTimers();
    const events = reported();
    const remove = vi.fn().mockRejectedValue(new Error("connection reset"));

    await settled(deleteUnreferencedMachine("fake", "machine-1", remove));

    expect(remove).toHaveBeenCalledTimes(4);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      message: "sandbox.cleanup_failed",
      provider: "fake",
      machineId: "machine-1",
      error: { message: "connection reset" },
    });
  });

  it("tries again after a refusal, which a machine still being created gives", async () => {
    vi.useFakeTimers();
    const events = reported();
    const remove = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("still creating"), { status: 409 }))
      .mockResolvedValue(undefined);

    await settled(deleteUnreferencedMachine("fake", "machine-1", remove));

    expect(remove).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
  });

  it("stops waiting at its deadline and reports the delete's own failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("deadline")), ms);
      return controller.signal;
    });
    const events = reported();
    const remove = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("rate limited"), { retryAfterMs: 5 * 60_000 }));

    await settled(deleteUnreferencedMachine("fake", "machine-1", remove));

    expect(remove).toHaveBeenCalledOnce();
    expect(events).toMatchObject([{ machineId: "machine-1", error: { message: "rate limited" } }]);
  });
});
