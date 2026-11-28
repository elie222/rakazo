import type { ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ComputerBusyError, ComputerSpaceDeletingError } from "./computer-lifecycle.js";
import { ComputerWaitTimedOutError, startComputerWaitingOutBusy } from "./run-computer-wait.js";

describe("startComputerWaitingOutBusy", () => {
  const isBusy = (error: unknown) =>
    error instanceof ComputerBusyError && !(error instanceof ComputerSpaceDeletingError);
  const computer = { id: "c", botId: "b", kind: "e2b", providerRef: "c" } as ComputerRef;

  it("waits in place while the computer is busy, then returns it", async () => {
    vi.useFakeTimers();
    try {
      const start = vi
        .fn<() => Promise<ComputerRef>>()
        .mockRejectedValueOnce(new ComputerBusyError())
        .mockRejectedValueOnce(new ComputerBusyError())
        .mockResolvedValue(computer);
      const started = startComputerWaitingOutBusy(start, isBusy, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(started).resolves.toBe(computer);
      expect(start).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up with the tool-call error once the bound runs out, backing off between starts", async () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn(async (): Promise<ComputerRef> => {
        throw new ComputerBusyError();
      });
      const started = startComputerWaitingOutBusy(
        start,
        isBusy,
        new AbortController().signal,
        30_000,
      );
      const outcome = expect(started).rejects.toBeInstanceOf(ComputerWaitTimedOutError);
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;
      expect(start.mock.calls.length).toBeGreaterThan(2);
      expect(start.mock.calls.length).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait on any other failure, nor on a Space being deleted", async () => {
    const deleting = vi.fn(async (): Promise<ComputerRef> => {
      throw new ComputerSpaceDeletingError();
    });
    await expect(
      startComputerWaitingOutBusy(deleting, isBusy, new AbortController().signal),
    ).rejects.toBeInstanceOf(ComputerSpaceDeletingError);
    expect(deleting).toHaveBeenCalledOnce();
    const down = vi.fn(async (): Promise<ComputerRef> => {
      throw new Error("provider down");
    });
    await expect(
      startComputerWaitingOutBusy(down, isBusy, new AbortController().signal),
    ).rejects.toThrow("provider down");
    expect(down).toHaveBeenCalledOnce();
  });

  it("stops waiting when the run is aborted", async () => {
    const controller = new AbortController();
    const start = vi.fn(async (): Promise<ComputerRef> => {
      controller.abort(new Error("run stopped"));
      throw new ComputerBusyError();
    });
    await expect(startComputerWaitingOutBusy(start, isBusy, controller.signal)).rejects.toThrow(
      "run stopped",
    );
    expect(start).toHaveBeenCalledOnce();
  });
});
