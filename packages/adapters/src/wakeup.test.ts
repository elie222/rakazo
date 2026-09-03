import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryJobQueue } from "./wakeup.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
  };
}

describe("InMemoryJobQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("delivers delayed jobs", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.enqueue({
      name: "run.continue",
      payload: { runId: "run-1" },
      availableAt: new Date(Date.now() + 1_000),
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(target["run.continue"]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(target["run.continue"]).toHaveBeenCalledWith({ runId: "run-1" });
    await queue.close();
  });

  it("replaces and cancels keyed jobs", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "old" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "computer.sleep:1",
    });
    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "new" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "computer.sleep:1",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["computer.sleep"]).toHaveBeenCalledTimes(1);
    expect(target["computer.sleep"]).toHaveBeenCalledWith({ computerId: "new" });

    await queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "cancelled" },
      availableAt: new Date(Date.now() + 1_000),
      replaceKey: "computer.sleep:2",
    });
    await queue.cancel("computer.sleep:2");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target["computer.sleep"]).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it.each([
    ["stop", "stop"],
    ["close", "close"],
    ["stop", "close"],
    ["close", "stop"],
  ] as const)("waits for an active handler before %s/%s", async (first, second) => {
    const queue = new InMemoryJobQueue();
    let releaseHandler: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    let nestedEnqueueFailed = false;
    let delayedEnqueueFailed = false;
    let chainedEnqueueFailed = false;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const target = handlers();
    target["computer.sleep"] = vi.fn(async () => {
      try {
        await queue.enqueue({ name: "run.continue", payload: { runId: "chained-run" } });
      } catch {
        chainedEnqueueFailed = true;
      }
    });
    target["run.continue"] = vi.fn(async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      try {
        await queue.enqueue({
          name: "computer.sleep",
          payload: { computerId: "computer-1" },
          replaceKey: "keep-during-close",
        });
        await queue.enqueue({
          name: "computer.sleep",
          payload: { computerId: "cancelled-computer" },
          replaceKey: "cancel-during-close",
        });
        await queue.cancel("cancel-during-close");
      } catch {
        nestedEnqueueFailed = true;
      }
      try {
        await queue.enqueue({
          name: "routine.wakeup",
          payload: { routineId: "routine-1", scheduledFor: "2099-01-01T00:00:00.000Z" },
          availableAt: new Date("2099-01-01T00:00:00.000Z"),
        });
      } catch {
        delayedEnqueueFailed = true;
      }
    });
    await queue.start(target);
    await queue.enqueue({ name: "run.continue", payload: { runId: "run-1" } });
    await started;

    const closing = Promise.all([queue[first](), queue[second]()] as const);
    const closeState = await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 5)),
    ]);
    releaseHandler();
    await closing;
    expect(closeState).toBe("waiting");
    expect(nestedEnqueueFailed).toBe(false);
    expect(delayedEnqueueFailed).toBe(false);
    expect(chainedEnqueueFailed).toBe(true);
    expect(target["computer.sleep"]).toHaveBeenCalledTimes(1);
    expect(target["run.continue"]).toHaveBeenCalledTimes(1);
    expect(target["routine.wakeup"]).not.toHaveBeenCalled();
    await queue.close();
  });

  it("rejects a keyed enqueue that resumes after close", async () => {
    const queue = new InMemoryJobQueue();
    let releaseCancel: () => void = () => undefined;
    let markCancelling: () => void = () => undefined;
    const cancelling = new Promise<void>((resolve) => {
      markCancelling = resolve;
    });
    vi.spyOn(queue, "cancel").mockImplementationOnce(async () => {
      markCancelling();
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
    });

    const enqueue = queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "computer-1" },
      replaceKey: "computer:computer-1",
    });
    await cancelling;
    await queue.close();
    releaseCancel();

    await expect(enqueue).rejects.toThrow("Background job publisher is closed");
  });

  it("rejects a keyed enqueue that resumes after stop", async () => {
    const queue = new InMemoryJobQueue();
    await queue.start(handlers());
    let releaseCancel: () => void = () => undefined;
    let markCancelling: () => void = () => undefined;
    const cancelling = new Promise<void>((resolve) => {
      markCancelling = resolve;
    });
    vi.spyOn(queue, "cancel").mockImplementationOnce(async () => {
      markCancelling();
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
    });

    const enqueue = queue.enqueue({
      name: "computer.sleep",
      payload: { computerId: "computer-1" },
      replaceKey: "computer:computer-1",
    });
    await cancelling;
    await queue.stop();
    releaseCancel();

    await expect(enqueue).rejects.toThrow("Background job publisher is stopped");
  });

  it("drains an accepted immediate timer during close", async () => {
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);

    await queue.enqueue({ name: "computer.sleep", payload: { computerId: "computer-1" } });
    await queue.close();

    expect(target["computer.sleep"]).toHaveBeenCalledOnce();
  });

  it("rejects jobs after stop until the worker restarts", async () => {
    const queue = new InMemoryJobQueue();
    const target = handlers();
    await queue.start(target);
    await queue.stop();

    await expect(
      queue.enqueue({ name: "computer.sleep", payload: { computerId: "computer-1" } }),
    ).rejects.toThrow("Background job publisher is stopped");

    await queue.start(target);
    await queue.enqueue({ name: "computer.sleep", payload: { computerId: "computer-1" } });
    await queue.close();
    expect(target["computer.sleep"]).toHaveBeenCalledOnce();
  });
});
