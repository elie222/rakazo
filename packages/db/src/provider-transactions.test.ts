import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderTransactionGate,
  ProviderTransactionBusyError,
} from "./provider-transactions.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createProviderTransactionGate", () => {
  it("runs one transaction at a time and hands the slot to the next waiter", async () => {
    const gate = createProviderTransactionGate(1);
    const provider = deferred();
    const order: string[] = [];

    const first = gate.run(async () => {
      order.push("first started");
      await provider.promise;
      order.push("first finished");
    }, 1_000);
    const second = gate.run(async () => {
      order.push("second started");
    }, 1_000);

    await Promise.resolve();
    expect(order).toEqual(["first started"]);
    provider.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first started", "first finished", "second started"]);
  });

  it("stops a waiter after its wait without starting it, and keeps the slot usable", async () => {
    vi.useFakeTimers();
    const gate = createProviderTransactionGate(1);
    const provider = deferred();
    const started = vi.fn();

    const holder = gate.run(() => provider.promise, 60_000);
    const waiter = gate.run(async () => started(), 2_000);
    const rejected = expect(waiter).rejects.toBeInstanceOf(ProviderTransactionBusyError);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(started).not.toHaveBeenCalled();

    provider.resolve();
    await holder;
    await expect(gate.run(async () => "next", 0)).resolves.toBe("next");
  });

  it("frees the slot when the transaction fails", async () => {
    const gate = createProviderTransactionGate(1);
    await expect(
      gate.run(async () => {
        throw new Error("provider failed");
      }, 1_000),
    ).rejects.toThrow("provider failed");
    await expect(gate.run(async () => "after", 0)).resolves.toBe("after");
  });
});
