import type { ProcessEvent, SandboxProcessHandle } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_FRAME_BYTES,
  NATIVE_INPUT_FRAME_BYTES,
  NativeEventQueue,
  NativeJsonlChannel,
} from "./primary-harness-protocol.js";

function fixture() {
  const events = new NativeEventQueue<ProcessEvent>();
  const controller = new AbortController();
  const handle: SandboxProcessHandle = {
    events,
    writeStdin: vi.fn(async () => undefined),
    closeStdin: vi.fn(async () => undefined),
    terminate: vi.fn(async () => events.end()),
  };
  const channel = new NativeJsonlChannel(handle, controller.signal);
  return { events, controller, handle, channel };
}
async function collect(channel: NativeJsonlChannel) {
  const result = [];
  for await (const message of channel.messages) result.push(message);
  return result;
}

describe("bounded native JSONL transport", () => {
  it("handles fragmented and coalesced frames, preserves wire order and ignores stderr", async () => {
    const f = fixture();
    const iterator = f.channel.messages[Symbol.asyncIterator]();
    const response = f.channel.request("initialize", {});
    f.events.push({ type: "stderr", data: "private-upstream-error" });
    f.events.push({ type: "stdout", data: '{"id":"rakazo-client-0","res' });
    f.events.push({
      type: "stdout",
      data: 'ult":{"ready":true}}\r\n{"method":"notice","params":{"text":"你好"}}\n',
    });
    expect(await response).toEqual({ ready: true });
    expect((await iterator.next()).value).toEqual({
      id: "rakazo-client-0",
      result: { ready: true },
    });
    expect((await iterator.next()).value).toEqual({ method: "notice", params: { text: "你好" } });
    await f.channel.close();
  });
  it.each([
    "{not json}\n",
    "[]\n",
    `{"text":"${"x".repeat(NATIVE_FRAME_BYTES)}"}\n`,
    "x".repeat(NATIVE_FRAME_BYTES + 1),
  ])("fails closed on invalid or oversized frame %#", async (data) => {
    const f = fixture();
    const output = collect(f.channel);
    f.events.push({ type: "stdout", data });
    await expect(output).rejects.toThrow(/Invalid native harness|frame limit/);
    await f.channel.close();
  });
  it("rejects the pending request on malformed result rather than leaving it hung", async () => {
    const f = fixture();
    const response = f.channel.request("initialize", {});
    f.events.push({ type: "stdout", data: '{"id":"rakazo-client-0","result":null}\n' });
    await expect(response).rejects.toThrow("protocol object");
    await f.channel.close();
  });
  it.each([0, 9])("never treats exit code %s alone as completion", async (code) => {
    const f = fixture();
    const output = collect(f.channel);
    f.events.push({ type: "exit", code });
    await expect(output).rejects.toThrow(/protocol completed|process failed/);
    await f.channel.close();
  });
  it("rejects requests on EOF or cancellation and permits only cancellation notification after abort", async () => {
    const f = fixture();
    const request = f.channel.request("initialize", {});
    f.controller.abort();
    await expect(request).rejects.toThrow("cancelled");
    await expect(f.channel.send({ method: "tool/allow" })).rejects.toThrow();
    await f.channel.send({ method: "turn/interrupt" });
    await f.channel.close();
    const ended = fixture();
    const pending = ended.channel.request("initialize", {});
    ended.events.end();
    await expect(pending).rejects.toThrow("terminal result");
    await ended.channel.close();
  });
  it("bounds pending handshake time and request count", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const requests = Array.from({ length: 32 }, () => f.channel.request("initialize", {}));
      for (const request of requests) void request.catch(() => undefined);
      await expect(f.channel.request("extra", {})).rejects.toThrow("Too many");
      await vi.advanceTimersByTimeAsync(30_000);
      for (const request of requests) await expect(request).rejects.toThrow("timed out");
    } finally {
      await f.channel.close();
      vi.useRealTimers();
    }
  });
  it("bounds queues and outbound frames", async () => {
    const queue = new NativeEventQueue<number>(2);
    queue.push(1);
    queue.push(2);
    expect(() => queue.push(3)).toThrow("overflow");
    const f = fixture();
    await expect(f.channel.send({ text: "x".repeat(NATIVE_INPUT_FRAME_BYTES) })).rejects.toThrow(
      "frame limit",
    );
    await f.channel.close();
  });
  it("permits large inline media input without increasing diagnostic frame limits", async () => {
    const f = fixture();
    const media = "x".repeat(2 * 1024 * 1024);
    await f.channel.send({ method: "turn/start", params: { media } });
    expect(f.handle.writeStdin).toHaveBeenCalledWith(expect.stringContaining(media));
    await f.channel.close();
  });
  it("bounds queued bytes independently of message count and releases consumed capacity", async () => {
    const queue = new NativeEventQueue<string>(256, 10, (value) =>
      Buffer.byteLength(value, "utf8"),
    );
    queue.push("hello");
    queue.push("world");
    expect(() => queue.push("!")).toThrow("overflow");
    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("hello");
    queue.push("again");
    queue.end();
    expect((await iterator.next()).value).toBe("world");
    expect((await iterator.next()).value).toBe("again");
  });
  it("bounds pending outbound media bytes while writes are stalled", async () => {
    const f = fixture();
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.handle.writeStdin).mockImplementation(() => stalled);
    const frame = { text: "x".repeat(12 * 1024 * 1024) };
    const one = f.channel.send(frame);
    const two = f.channel.send(frame);
    await expect(f.channel.send(frame)).rejects.toThrow("queue overflow");
    release();
    await Promise.all([one, two]);
    await f.channel.send({ text: "capacity released" });
    await f.channel.close();
  });
});
