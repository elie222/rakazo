import type { ProductEvent } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_TIMEOUT_MS, runThreadSubscription } from "./thread-subscription.js";

const head = { threadId: "thread", cursor: 10 };
function event(seq: number): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    seq,
    type: "thread.progress",
    payload: {},
    createdAt: "2026-01-01T00:00:00Z",
  };
}
function heartbeat(): ProductEvent {
  return { ...event(0), id: "heartbeat", type: "heartbeat" };
}
function stream() {
  let deliver: ((result: IteratorResult<ProductEvent>) => void) | undefined;
  const events: AsyncIterable<ProductEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      };
    },
  };
  return {
    events,
    send: (value: ProductEvent) => deliver?.({ value, done: false }),
    end: () => deliver?.({ value: undefined, done: true }),
  };
}
function setup(committed: typeof head | null = head) {
  const abort = new AbortController();
  const channel = stream();
  const state = { committed };
  const callbacks = {
    signal: abort.signal,
    loadInitial: vi.fn(async () => head as typeof head | null),
    loadHead: vi.fn(async () => head as typeof head | null),
    refresh: vi.fn(async () => {}),
    currentSnapshot: () => state.committed,
    subscribe: vi.fn(async (_cursor: number, _signal: AbortSignal) => channel.events),
    applyEvent: vi.fn(),
    onEvent: vi.fn(),
  };
  return { abort, channel, state, callbacks };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("thread subscription recovery", () => {
  it("falls back to head with backoff and buffers until a snapshot commits", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.loadHead.mockResolvedValueOnce(null);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 11 };
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.loadHead).toHaveBeenCalledTimes(2);
    expect(callbacks.subscribe).toHaveBeenCalledWith(10, expect.any(AbortSignal));
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([12]);
    abort.abort();
    channel.end();
    await running;
  });

  it("reconnects from the highest event cursor and resets backoff after delivery", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    callbacks.subscribe.mockRejectedValueOnce(new Error("offline"));
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls[0]?.[1].aborted).toBe(true);
    expect(callbacks.subscribe.mock.calls[1]?.[1].aborted).toBe(false);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10, 12]);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    expect(callbacks.onEvent).toHaveBeenLastCalledWith(event(11), head);
    abort.abort();
    channel.end();
    await running;
  });

  it("cancels a reconnect delay without rejecting or starting another request", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(running).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps receipt handling before applying events and effects afterward", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const order: string[] = [];
    callbacks.applyEvent.mockImplementation(() => {
      order.push("apply");
    });
    callbacks.onEvent.mockImplementation(() => {
      order.push("effect");
    });
    const running = runThreadSubscription({
      ...callbacks,
      beforeEvent: () => {
        order.push("receipt");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["receipt", "apply", "effect"]);
    abort.abort();
    channel.end();
    await running;
  });

  it("does not refresh or replay a buffered event after cancellation during snapshot delay", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup(null);
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    channel.end();
    await running;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.refresh).not.toHaveBeenCalled();
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
  });

  it("ignores a late initial response after switching away", async () => {
    const { abort, callbacks } = setup();
    let resolve!: (value: typeof head) => void;
    callbacks.loadInitial.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const running = runThreadSubscription(callbacks);
    abort.abort();
    resolve(head);
    await running;
    expect(callbacks.subscribe).not.toHaveBeenCalled();
    expect(callbacks.loadHead).not.toHaveBeenCalled();
  });

  it("aborts the current transport and ignores a late frame after switching away", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    const transportSignal = callbacks.subscribe.mock.calls[0]?.[1];
    abort.abort();
    expect(transportSignal?.aborted).toBe(true);
    channel.send(event(11));
    await running;
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(callbacks.refresh).not.toHaveBeenCalled();
  });

  it("skips displaced-snapshot events while retaining effects and subsequent live updates", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    state.committed = { threadId: "replacement-thread", cursor: 0 };
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).toHaveBeenCalledWith(event(11), head);
    state.committed = head;
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(12));
    expect(callbacks.refresh).not.toHaveBeenCalled();
    abort.abort();
    channel.end();
    await running;
  });

  it("swallows heartbeats without applying them or advancing the cursor", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    abort.abort();
    channel.end();
    await running;
  });

  it("abandons a silent stream and resubscribes from the same cursor", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 11]);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12]);
    abort.abort();
    channel.end();
    await running;
  });

  it("keeps a heartbeat alive as liveness so the idle timer never fires", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    for (let beat = 0; beat < 3; beat += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1_000);
      channel.send(heartbeat());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    abort.abort();
    channel.end();
    await running;
  });

  it("aborts the silent transport before refreshing and opening its replacement", async () => {
    vi.useFakeTimers();
    const { abort, callbacks } = setup();
    const signals: AbortSignal[] = [];
    const abortedAtRefresh: boolean[] = [];
    let openTransports = 0;
    callbacks.subscribe.mockImplementation(async (_cursor, transportSignal) => {
      // An async generator's return queues behind its pending read. Only aborting
      // the request releases the socket, even when return has already been called.
      const signal = transportSignal ?? abort.signal;
      signals.push(signal);
      openTransports += 1;
      return (async function* () {
        try {
          yield heartbeat();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          signal.throwIfAborted();
          yield event(11);
        } finally {
          openTransports -= 1;
        }
      })();
    });
    callbacks.refresh.mockImplementation(async () => {
      abortedAtRefresh.push(signals.at(-1)?.aborted === true);
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 250);
      expect(signals[attempt]?.aborted).toBe(true);
      expect(openTransports).toBe(1);
      expect(abort.signal.aborted).toBe(false);
    }
    expect(new Set(signals).size).toBe(9);
    expect(abortedAtRefresh).toEqual(Array(8).fill(true));
    abort.abort();
    await running;
    expect(openTransports).toBe(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
  });

  it("forwards cancellation without AbortSignal.any and removes retired parent listeners", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    vi.stubGlobal("AbortSignal", { any: undefined });
    const add = vi.spyOn(abort.signal, "addEventListener");
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const running = runThreadSubscription(callbacks);
    void running.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    const firstListener = add.mock.calls[0]?.[1];
    channel.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("abort", firstListener);
    const currentSignal = callbacks.subscribe.mock.calls[1]?.[1];
    const reason = new Error("switched thread");
    abort.abort(reason);
    expect(currentSignal?.aborted).toBe(true);
    expect(currentSignal?.reason).toBe(reason);
    channel.end();
    await expect(running).resolves.toBeUndefined();
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
  });
});
