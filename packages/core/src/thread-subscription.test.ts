import type { ProductEvent } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runThreadSubscription } from "./thread-subscription.js";

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
    subscribe: vi.fn(async (_cursor: number) => channel.events),
    applyEvent: vi.fn(),
    onEvent: vi.fn(),
  };
  return { abort, channel, state, callbacks };
}
afterEach(() => vi.useRealTimers());

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
    expect(callbacks.subscribe).toHaveBeenCalledWith(10);
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
});
