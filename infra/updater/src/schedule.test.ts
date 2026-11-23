import { deferred, flush } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startUpdateSchedule } from "./schedule.js";

afterEach(() => vi.useRealTimers());

describe("scheduled updates", () => {
  it("does nothing unless explicitly enabled", async () => {
    vi.useFakeTimers();
    const update = vi.fn(async () => {});
    const stop = startUpdateSchedule(0, update, vi.fn());
    await vi.advanceTimersByTimeAsync(7 * 24 * 3_600_000);
    expect(update).not.toHaveBeenCalled();
    await stop();
  });

  it("waits a full interval on startup and between checks", async () => {
    vi.useFakeTimers();
    const update = vi.fn(async () => {});
    const stop = startUpdateSchedule(6 * 3_600_000, update, vi.fn());
    await vi.advanceTimersByTimeAsync(6 * 3_600_000 - 1);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 3_600_000);
    expect(update).toHaveBeenCalledTimes(2);
    await stop();
    await vi.advanceTimersByTimeAsync(6 * 3_600_000);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("never overlaps long updates and waits for one to finish during shutdown", async () => {
    vi.useFakeTimers();
    const work = deferred<void>();
    const update = vi.fn(() => work.promise);
    const stop = startUpdateSchedule(1_000, update, vi.fn());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(update).toHaveBeenCalledTimes(1);
    let stopped = false;
    const shutdown = stop().then(() => {
      stopped = true;
    });
    const flushed = flush();
    await vi.advanceTimersByTimeAsync(0);
    await flushed;
    expect(stopped).toBe(false);
    work.resolve();
    await shutdown;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopped).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("reports failures and checks again after the configured interval", async () => {
    vi.useFakeTimers();
    const error = new Error("registry unavailable");
    const update = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startUpdateSchedule(1_000, update, onError);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledWith(error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(update).toHaveBeenCalledTimes(2);
    await stop();
  });
});
