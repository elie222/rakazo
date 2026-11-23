import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortableDelay,
  anySignal,
  deadlineSignal,
  mapConcurrent,
  requestDeadline,
  withAbort,
} from "./async.js";
import { deferred, flush } from "./async.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("abortableDelay", () => {
  it("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableDelay(10_000, controller.signal)).resolves.toBeUndefined();
  });

  it("resolves on abort without waiting out the delay", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const done = abortableDelay(10_000, controller.signal);
    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });
});

describe("anySignal without AbortSignal.any", () => {
  function withoutAny() {
    vi.stubGlobal(
      "AbortSignal",
      Object.assign(Object.create(AbortSignal), { any: undefined, timeout: AbortSignal.timeout }),
    );
  }

  it("aborts with the reason of the first input to abort and drops the other listeners", () => {
    const first = new AbortController();
    const second = new AbortController();
    const removeListener = vi.spyOn(second.signal, "removeEventListener");
    withoutAny();
    const combined = anySignal([first.signal, second.signal]);
    expect(combined.aborted).toBe(false);
    first.abort("stop");
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe("stop");
    expect(removeListener).toHaveBeenCalled();
    second.abort("later");
    expect(combined.reason).toBe("stop");
  });

  it("is already aborted when an input is", () => {
    const controller = new AbortController();
    controller.abort("gone");
    withoutAny();
    const combined = anySignal([new AbortController().signal, controller.signal]);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe("gone");
  });
});

describe("withAbort", () => {
  it("settles with the promise while the signal stays live", async () => {
    await expect(withAbort(Promise.resolve(1), new AbortController().signal)).resolves.toBe(1);
    const failure = new Error("failed");
    await expect(withAbort(Promise.reject(failure), new AbortController().signal)).rejects.toBe(
      failure,
    );
  });

  it("rejects with the abort reason without waiting for the promise", async () => {
    const controller = new AbortController();
    const pending = withAbort(new Promise<never>(() => {}), controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });

  it("rejects at once on an aborted signal and swallows the late failure", async () => {
    const controller = new AbortController();
    controller.abort("gone");
    await expect(withAbort(Promise.reject(new Error("late")), controller.signal)).rejects.toBe(
      "gone",
    );
  });

  it("falls back to the given message when the signal carries no reason", async () => {
    const signal = { aborted: true, reason: undefined } as AbortSignal;
    await expect(withAbort(new Promise<never>(() => {}), signal, "Timed out")).rejects.toThrow(
      "Timed out",
    );
  });
});

describe("deadlineSignal", () => {
  const aborted = (signal: AbortSignal) =>
    new Promise<unknown>((resolve) => {
      signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
    });

  it("aborts with the parent's reason when the parent aborts first", () => {
    const parent = new AbortController();
    const signal = deadlineSignal(20_000, parent.signal);
    expect(signal.aborted).toBe(false);
    parent.abort("stop");
    expect(signal.reason).toBe("stop");
  });

  it("aborts with a TimeoutError once the time runs out, with or without a parent", async () => {
    for (const parent of [new AbortController().signal, undefined]) {
      await expect(aborted(deadlineSignal(1, parent))).resolves.toMatchObject({
        name: "TimeoutError",
      });
    }
  });
});

describe("requestDeadline", () => {
  it("aborts with the message once the time runs out", () => {
    vi.useFakeTimers();
    const deadline = requestDeadline(1_000, "Too slow.");
    vi.advanceTimersByTime(999);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect((deadline.signal.reason as Error).message).toBe("Too slow.");
  });

  it("follows the parent's abort and stops both after dispose", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = requestDeadline(1_000, "Too slow.", parent.signal);
    parent.abort("left");
    expect(deadline.signal.reason).toBe("left");

    const other = new AbortController();
    const disposed = requestDeadline(1_000, "Too slow.", other.signal);
    disposed.dispose();
    other.abort("later");
    vi.advanceTimersByTime(1_000);
    expect(disposed.signal.aborted).toBe(false);
  });

  it("starts aborted under an aborted parent", () => {
    const parent = new AbortController();
    parent.abort("gone");
    expect(requestDeadline(1_000, "Too slow.", parent.signal).signal.reason).toBe("gone");
  });
});

describe("mapConcurrent", () => {
  it("runs at most `limit` calls at once and keeps the items' order", async () => {
    const pending = Array.from({ length: 5 }, () => deferred<string>());
    const started: number[] = [];
    const done = mapConcurrent([0, 1, 2, 3, 4], 2, (item) => {
      started.push(item);
      return pending[item]!.promise;
    });
    await flush();
    expect(started).toEqual([0, 1]);
    pending[1]!.resolve("b");
    await flush();
    expect(started).toEqual([0, 1, 2]);
    pending[2]!.resolve("c");
    pending[0]!.resolve("a");
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    pending[4]!.resolve("e");
    pending[3]!.resolve("d");
    await expect(done).resolves.toEqual(["a", "b", "c", "d", "e"]);
  });

  it("resolves an empty list without calling", async () => {
    const fn = vi.fn();
    await expect(mapConcurrent([], 4, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects with the first failure and starts nothing after it", async () => {
    const first = deferred<number>();
    const started: number[] = [];
    const done = mapConcurrent([0, 1, 2, 3], 2, (item) => {
      started.push(item);
      return item === 1 ? Promise.reject(new Error("locked")) : first.promise;
    });
    await expect(done).rejects.toThrow("locked");
    first.resolve(0);
    await flush();
    expect(started).toEqual([0, 1]);
  });
});
