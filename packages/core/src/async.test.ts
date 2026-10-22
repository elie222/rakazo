import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableDelay, anySignal } from "./async.js";

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
