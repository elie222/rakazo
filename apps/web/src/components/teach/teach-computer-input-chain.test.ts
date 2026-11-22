import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { enqueueTeachComputerInput, settleTeachComputerInput } from "./teach-computer-input-chain";

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

describe("settleTeachComputerInput", () => {
  it("waits for queued input, but not for one request that never answers", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred();
      void enqueueTeachComputerInput("settle", () => gate.promise);
      let settled = false;
      const settling = settleTeachComputerInput("settle").then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settling;
      expect(settled).toBe(true);
      gate.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles once queued input lands", async () => {
    const gate = deferred();
    const order: string[] = [];
    void enqueueTeachComputerInput("settle-ok", async () => {
      await gate.promise;
      order.push("release");
    });
    const settling = settleTeachComputerInput("settle-ok").then(() => order.push("stop"));
    gate.resolve();
    await settling;
    expect(order).toEqual(["release", "stop"]);
  });
});
