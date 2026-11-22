import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueTeachComputerInput,
  isTeachInputStopping,
  stopAfterTeachInput,
} from "./teach-computer-input-chain";

describe("enqueueTeachComputerInput", () => {
  it("runs one bot's input in order and still continues after a rejection", async () => {
    const botId = "chain-order";
    const order: string[] = [];
    const gate = deferred();

    const first = enqueueTeachComputerInput(botId, async () => {
      order.push("first");
      await gate.promise;
      throw new Error("drop");
    });
    const second = enqueueTeachComputerInput(botId, async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first"]);
    gate.resolve();
    await expect(first).rejects.toThrow("drop");
    await second;
    expect(order).toEqual(["first", "second"]);
  });
});

it("allows Stop to finish even if a queued input never answers", async () => {
  vi.useFakeTimers();
  const gate = deferred();
  const pendingInput = enqueueTeachComputerInput("unresponsive-bot", () => gate.promise);
  const stop = vi.fn(async () => undefined);
  try {
    const stopped = stopAfterTeachInput("unresponsive-bot", "skill-1", stop);
    expect(isTeachInputStopping("skill-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(isTeachInputStopping("skill-1")).toBe(false);
  } finally {
    gate.resolve();
    await pendingInput;
    vi.useRealTimers();
  }
});

it("proceeds with Stop after a simulated release fails", async () => {
  const release = enqueueTeachComputerInput("failed-release-bot", async () => {
    throw new Error("release failed");
  });
  const stop = vi.fn(async () => undefined);
  await stopAfterTeachInput("failed-release-bot", "skill-1", stop);
  await expect(release).rejects.toThrow("release failed");
  expect(stop).toHaveBeenCalledTimes(1);
  expect(isTeachInputStopping("skill-1")).toBe(false);
});
