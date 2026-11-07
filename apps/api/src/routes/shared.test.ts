import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT, HEARTBEAT_MS, withHeartbeats } from "./shared.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withHeartbeats", () => {
  it("keeps the in-flight read across heartbeats so events stay in order", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const reads = vi.fn();
    async function* follow() {
      reads();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield "first";
      yield "second";
    }
    const stream = withHeartbeats({}, follow);

    const heartbeat = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await expect(heartbeat).resolves.toEqual({ done: false, value: HEARTBEAT });

    const first = stream.next();
    release?.();
    await expect(first).resolves.toEqual({ done: false, value: "first" });
    await expect(stream.next()).resolves.toEqual({ done: false, value: "second" });
    expect(reads).toHaveBeenCalledOnce();
    await stream.return(undefined);
  });

  it("ends on revocation without waiting for a read the abort never lands on", async () => {
    vi.useFakeTimers();
    let sourceSignal: AbortSignal | undefined;
    const stillAuthorized = vi.fn(async () => false);
    const stream = withHeartbeats({ stillAuthorized }, async function* (signal) {
      sourceSignal = signal;
      await new Promise<never>(() => {});
      yield "never";
    });

    const ended = expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await ended;
    expect(stillAuthorized).toHaveBeenCalledOnce();
    expect(sourceSignal?.aborted).toBe(true);
  });
});
