import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableDelay } from "./async.js";

afterEach(() => {
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
