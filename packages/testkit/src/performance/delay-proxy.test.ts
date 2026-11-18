import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { deferred, flush } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDelayProxy } from "./delay-proxy.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startUpstream(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(`${request.method} ${request.url}`);
    handle(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

async function startProxy(
  target: string,
  hold: (delayMs: number, signal: AbortSignal) => Promise<void>,
) {
  const proxy = await startDelayProxy({ target, port: 0, delayMs: 1000, hold });
  cleanups.push(() => proxy.close());
  return proxy;
}

describe("startDelayProxy", () => {
  it("holds each request for the delay before forwarding it", async () => {
    const upstream = await startUpstream((request, response) => {
      request.resume();
      request.once("end", () => response.end("ok"));
    });
    const gate = deferred();
    const hold = vi.fn(() => gate.promise);
    const proxy = await startProxy(upstream.url, hold);

    const answer = fetch(`${proxy.url}/rpc/me`, { method: "POST", body: "{}" });
    await vi.waitFor(() => expect(hold).toHaveBeenCalledWith(1000, expect.any(AbortSignal)));
    await flush();
    expect(upstream.received).toEqual([]);

    gate.resolve();
    const response = await answer;
    expect(await response.text()).toBe("ok");
    expect(upstream.received).toEqual(["POST /rpc/me"]);
  });

  it("streams a long-lived response through as it is written", async () => {
    const finish = deferred();
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("first\n");
      void finish.promise.then(() => response.end("last\n"));
    });
    const proxy = await startProxy(upstream.url, async () => {});

    const response = await fetch(`${proxy.url}/rpc/notifications/subscribe`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe("first\n");

    finish.resolve();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toBe("last\n");
  });

  it("ends only the affected response when the API connection resets mid-stream", async () => {
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/health") return void response.end("ok");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("first\n", () => response.socket?.destroy());
    });
    const proxy = await startProxy(upstream.url, async () => {});

    const stream = await fetch(`${proxy.url}/rpc/notifications/subscribe`);
    await expect(stream.text()).rejects.toThrow();
    expect(await (await fetch(`${proxy.url}/health`)).text()).toBe("ok");
  });

  it("keeps serving after a caller drops mid-upload", async () => {
    const upstream = await startUpstream((request, response) => {
      request.resume();
      request.once("end", () => response.end("ok"));
      request.once("error", () => response.destroy());
    });
    const proxy = await startProxy(upstream.url, async () => {});

    const { port } = new URL(proxy.url);
    const socket = connect(Number(port), "127.0.0.1");
    await once(socket, "connect");
    socket.write("POST /rpc/upload HTTP/1.1\r\nhost: proxy\r\ncontent-length: 100\r\n\r\npartial");
    await vi.waitFor(() => expect(upstream.received).toEqual(["POST /rpc/upload"]));
    socket.resetAndDestroy();

    expect(await (await fetch(`${proxy.url}/health`)).text()).toBe("ok");
  });

  it("ends only the affected request when its delay fails", async () => {
    const upstream = await startUpstream((_request, response) => response.end("ok"));
    let calls = 0;
    const proxy = await startProxy(upstream.url, async () => {
      calls += 1;
      if (calls === 1) throw new Error("hold failed");
    });

    await expect(fetch(`${proxy.url}/health`)).rejects.toThrow();
    expect(await (await fetch(`${proxy.url}/health`)).text()).toBe("ok");
  });

  it("drops a request whose caller left while it was held", async () => {
    const upstream = await startUpstream((_request, response) => response.end("ok"));
    const gate = deferred();
    const signals: AbortSignal[] = [];
    const proxy = await startProxy(upstream.url, (_delayMs, signal) => {
      signals.push(signal);
      return gate.promise;
    });

    const caller = new AbortController();
    const answer = fetch(`${proxy.url}/health`, { signal: caller.signal });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    caller.abort();
    await expect(answer).rejects.toThrow();
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));

    gate.resolve();
    await flush();
    expect(upstream.received).toEqual([]);
  });
});
