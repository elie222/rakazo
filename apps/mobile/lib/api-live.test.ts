vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MOBILE_RPC_RESPONSE_BYTES } from "./api.js";
import { IDLE_TIMEOUT_MS, subscribeIncomingCallEvents, subscribeThread } from "./api-live.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import { paddedThreadFrame } from "./api-test-helpers";

describe("mobile thread subscription", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("");
  });

  it("shares the bounded SSE transport for one account call stream", async () => {
    const call = {
      id: "bot-1",
      spaceId: "space-1",
      name: "Caller",
      color: "",
      avatarSet: "rakazo",
      incomingCall: {
        callId: "call-1",
        reason: "Review",
        opening: "Hello",
        expiresAt: new Date(Date.now() + 45000).toISOString(),
      },
    };
    const frame = `data: ${JSON.stringify({ json: { type: "incoming.calls", payload: { calls: [call] } } })}\n\n`;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(frame, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const onCalls = vi.fn();
    await subscribeIncomingCallEvents(onCalls, new AbortController().signal);
    expect(onCalls).toHaveBeenCalledWith([call]);
    expect(fetch.mock.calls[0]?.[0]).toContain("notifications/subscribeCalls");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("parses fragmented SSE frames and ignores malformed data and completion markers", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.pro'));
        controller.enqueue(
          encoder.encode(
            'gress","seq":4,"payload":{"delta":"Hi"}}}\n\ndata: not-json\n\ndata: [DONE]\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"json":{"type":"thread.message.created",\n' +
              'data: "seq":5,"payload":{"messageId":"m1"}}}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, 3, onEvent, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/rpc/threads/subscribe",
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "text/event-stream" }),
        body: JSON.stringify({ json: { botId: "bot-1", cursor: 3 } }),
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "thread.progress", seq: 4 }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "thread.message.created", seq: 5 }),
    );
    expect(stream.locked).toBe(false);
  });

  it("rejects an oversized partial SSE frame and cancels the remaining response", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MOBILE_RPC_RESPONSE_BYTES + 1).fill(97));
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.progress","seq":8}}\n\n'));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const onEvent = vi.fn();

    await expect(
      subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal),
    ).rejects.toThrow(RangeError);
    expect(cancelled).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it.each(["single chunk", "fragmented delimiter"])(
    "accepts an exactly-at-cap SSE frame with a %s",
    async (framing) => {
      const frame = paddedThreadFrame(MAX_MOBILE_RPC_RESPONSE_BYTES, 4);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (framing === "single chunk") {
            controller.enqueue(frame);
          } else {
            controller.enqueue(frame.subarray(0, frame.byteLength - 1));
            controller.enqueue(frame.subarray(frame.byteLength - 1));
          }
          controller.close();
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream)),
      );
      const onEvent = vi.fn();

      await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

      expect(onEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "thread.progress", seq: 4 }),
      );
      expect(stream.locked).toBe(false);
    },
  );

  it.each(["single chunk", "fragmented delimiter"])(
    "counts UTF-8 and delimiter bytes when rejecting an oversized frame with a %s",
    async (framing) => {
      const encoder = new TextEncoder();
      const frame = paddedThreadFrame(MAX_MOBILE_RPC_RESPONSE_BYTES + 1, 4);
      frame.set(encoder.encode("é"), 1);
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (framing === "single chunk") {
            controller.enqueue(frame);
          } else {
            controller.enqueue(frame.subarray(0, frame.byteLength - 1));
            controller.enqueue(frame.subarray(frame.byteLength - 1));
          }
          controller.enqueue(
            encoder.encode('data: {"json":{"type":"thread.progress","seq":5}}\n\n'),
          );
          controller.close();
        },
        cancel,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream)),
      );
      const onEvent = vi.fn();

      await expect(
        subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal),
      ).rejects.toThrow(RangeError);

      expect(onEvent).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    },
  );

  it("accepts multiple valid frames in a chunk larger than the per-frame cap", async () => {
    const first = paddedThreadFrame(MAX_MOBILE_RPC_RESPONSE_BYTES / 2 + 1, 4);
    const second = paddedThreadFrame(MAX_MOBILE_RPC_RESPONSE_BYTES / 2 + 1, 5);
    const chunk = new Uint8Array(first.byteLength + second.byteLength);
    chunk.set(first);
    chunk.set(second, first.byteLength);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent.mock.calls.map(([event]) => event.seq)).toEqual([4, 5]);
    expect(stream.locked).toBe(false);
  });

  it("reassembles split UTF-8 characters and a split LF delimiter", async () => {
    const encoder = new TextEncoder();
    const frame = encoder.encode(
      'data: {"json":{"type":"thread.progress","seq":4,"payload":{"delta":"🌿 café"}}}\n\n',
    );
    const splitCharacter = frame.indexOf(0xf0) + 2;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame.subarray(0, splitCharacter));
        controller.enqueue(frame.subarray(splitCharacter, frame.byteLength - 1));
        controller.enqueue(frame.subarray(frame.byteLength - 1));
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.progress","seq":5}}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ seq: 4, payload: { delta: "🌿 café" } }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ seq: 5 }));
    expect(stream.locked).toBe(false);
  });

  it("discards complete JSON without an LF-LF terminator at EOF", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.progress","seq":4}}'));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("keeps consuming frames after a callback throws", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"json":{"type":"thread.progress","seq":4}}\n\n' +
              'data: {"json":{"type":"thread.progress","seq":5}}\n\n',
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn().mockImplementationOnce(() => {
      throw new Error("callback failed");
    });

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent.mock.calls.map(([event]) => event.seq)).toEqual([4, 5]);
    expect(stream.locked).toBe(false);
  });

  it("rejects responses that are unsuccessful or have no stream body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (503)");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (200)");
  });

  it("cancels unsuccessful HTTP bodies without replacing the status error", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 503 })),
    );

    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (503)");

    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("ignores heartbeat frames so the caller's cursor never skips an event", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"json":{"type":"heartbeat","seq":0,"payload":{}}}\n\n' +
              ": keepalive\n\n" +
              'data: {"json":{"type":"thread.progress","seq":1,"payload":{}}}\n\n',
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "thread.progress", seq: 1 }),
    );
  });

  it("gives up on a silent stream after the idle timeout so the caller reconnects", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const onEvent = vi.fn();
    const abort = new AbortController();

    const running = subscribeThread({ botId: "bot-1" }, -1, onEvent, abort.signal);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await running;

    expect(settled).toBe(true);
    expect(cancelled).toBe(true);
    expect(abort.signal.aborted).toBe(false);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("unblocks an aborted read without waiting for idle or stalled cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");
    const running = subscribeThread({ botId: "bot-1" }, -1, onEvent, abort.signal);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.locked).toBe(true);

    abort.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    await running;
    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cancels an already-aborted custom response without delivering queued events", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"json":{"type":"thread.progress","seq":4}}\n\n'),
        );
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();
    const abort = new AbortController();
    abort.abort();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, abort.signal);

    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("releases an errored reader and clears its timer and abort listener", async () => {
    vi.useFakeTimers();
    const failure = new Error("read failed");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");

    await expect(subscribeThread({ botId: "bot-1" }, -1, vi.fn(), abort.signal)).rejects.toBe(
      failure,
    );

    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
