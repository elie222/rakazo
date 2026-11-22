import { getEventListeners } from "node:events";
import { IDLE_TIMEOUT_MS } from "@rakazo/core";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT, HEARTBEAT_MS, withHeartbeats } from "./shared.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withHeartbeats", () => {
  it("beats often enough that a client's idle timeout survives a missed beat", () => {
    expect(2 * HEARTBEAT_MS).toBeLessThan(IDLE_TIMEOUT_MS);
  });

  it("keeps the in-flight read across heartbeats so events stay in order", async () => {
    vi.useFakeTimers();
    const release = deferred();
    const reads = vi.fn();
    async function* follow() {
      reads();
      await release.promise;
      yield "first";
      yield "second";
    }
    const stream = withHeartbeats({}, follow);

    const heartbeat = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await expect(heartbeat).resolves.toEqual({ done: false, value: HEARTBEAT });

    const first = stream.next();
    release.resolve();
    await expect(first).resolves.toEqual({ done: false, value: "first" });
    await expect(stream.next()).resolves.toEqual({ done: false, value: "second" });
    expect(reads).toHaveBeenCalledOnce();
    await stream.return(undefined);
  });

  it("holds no abort listener once each event is delivered", async () => {
    const request = new AbortController();
    const stream = withHeartbeats({ signal: request.signal }, async function* () {
      for (let i = 0; i < 50; i++) yield i;
    });

    for (let i = 0; i < 50; i++) await stream.next();

    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
    await stream.return(undefined);
  });

  it("does not start reading when the request has already aborted", async () => {
    const request = new AbortController();
    request.abort();
    const reads = vi.fn();
    const stream = withHeartbeats({ signal: request.signal }, async function* () {
      reads();
      yield "event";
    });

    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(reads).not.toHaveBeenCalled();
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

  it("ends when the request aborts, without re-checking the session or waiting for the source", async () => {
    vi.useFakeTimers();
    const request = new AbortController();
    const stillAuthorized = vi.fn(async () => true);
    const stream = withHeartbeats({ signal: request.signal, stillAuthorized }, async function* () {
      await new Promise<never>(() => {});
      yield "never";
    });

    const first = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    request.abort();
    await expect(first).resolves.toEqual({ done: true, value: undefined });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(stillAuthorized).not.toHaveBeenCalled();
  });

  function scripted<T>() {
    const queued: T[] = [];
    let waiting: Deferred<T> | undefined;
    const emit = (value: T) => {
      const gate = waiting;
      if (gate) {
        waiting = undefined;
        gate.resolve(value);
        return;
      }
      queued.push(value);
    };
    async function* follow(): AsyncGenerator<T> {
      while (true) {
        const next = queued.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const gate = deferred<T>();
        waiting = gate;
        yield await gate.promise;
      }
    }
    return { follow, emit };
  }

  /** The frame if that read has already settled, so a missing heartbeat fails instead of waiting. */
  async function settled<T>(pending: Promise<T>): Promise<T | undefined> {
    let result: T | undefined;
    let ready = false;
    const tracked = pending.then((value) => {
      ready = true;
      result = value;
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (!ready) return undefined;
    await tracked;
    return result;
  }

  it("keeps beating on time when every event is dropped", async () => {
    vi.useFakeTimers();
    const { follow, emit } = scripted<string>();
    const started = Date.now();
    const stream = withHeartbeats({}, follow, () => false);
    const frames: number[] = [];
    let pending = stream.next();

    for (let step = 0; step < 4; step++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2);
      emit(`drop-${step}`);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2);
      expect(await settled(pending)).toEqual({ done: false, value: HEARTBEAT });
      frames.push(Date.now());
      if (step === 3) break;
      pending = stream.next();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(frames).toEqual([
      started + HEARTBEAT_MS,
      started + HEARTBEAT_MS * 2,
      started + HEARTBEAT_MS * 3,
      started + HEARTBEAT_MS * 4,
    ]);
    await stream.return(undefined);
  });

  it("yields forwarded events in order and restarts the silence window from one", async () => {
    vi.useFakeTimers();
    const { follow, emit } = scripted<string>();
    const stream = withHeartbeats({}, follow, (item) => item.startsWith("keep"));
    let pending = stream.next();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2);
    emit("drop-1");
    await vi.advanceTimersByTimeAsync(0);
    emit("keep-a");
    expect(await settled(pending)).toEqual({ done: false, value: "keep-a" });

    const forwardedAt = Date.now();
    pending = stream.next();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2);
    emit("drop-2");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2 - 1);
    expect(await settled(pending)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(pending)).toEqual({ done: false, value: HEARTBEAT });
    expect(Date.now() - forwardedAt).toBe(HEARTBEAT_MS);

    pending = stream.next();
    emit("keep-b");
    expect(await settled(pending)).toEqual({ done: false, value: "keep-b" });
    await stream.return(undefined);
  });

  it("spends an async drop's own wait inside the silence window", async () => {
    vi.useFakeTimers();
    const { follow, emit } = scripted<string>();
    const started = Date.now();
    const stream = withHeartbeats({}, follow, async () => {
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS / 2));
      return false;
    });
    const pending = stream.next();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2);
    emit("drop");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS / 2);
    expect(await settled(pending)).toEqual({ done: false, value: HEARTBEAT });
    expect(Date.now() - started).toBe(HEARTBEAT_MS);
    await stream.return(undefined);
  });

  it("ends when the source ends, without yielding a dropped event", async () => {
    async function* follow() {
      yield "drop";
      yield "keep";
    }
    const stream = withHeartbeats({}, follow, (item) => item === "keep");

    await expect(stream.next()).resolves.toEqual({ done: false, value: "keep" });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
