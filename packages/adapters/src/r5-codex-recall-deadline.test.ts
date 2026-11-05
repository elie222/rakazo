import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmySearchInput } from "./memmy-memory-client.js";
import { MemmyMemoryClient, resetMemmyCircuitBreakers } from "./memmy-memory-client.js";

// The egress audit sink is external I/O; keep the client and transports real and offline.
vi.mock("@rakazo/db", () => ({ recordSecurityEvent: vi.fn() }));

const input: MemmySearchInput = {
  query: "remember the invoice rule",
  layers: ["policy"],
  limit: 8,
  contextBudget: 1800,
  namespaces: [{ source: "rakazo", userId: "owner", profileId: "bot:one" }],
};

const reply = {
  debug: {
    sections: [
      { id: "section-1", memoryLayer: "L2", memoryIds: ["memory-1"], content: "Invoice rule" },
    ],
  },
};

function client(fetchImpl: typeof fetch): MemmyMemoryClient {
  return new MemmyMemoryClient({
    baseUrl: "http://127.0.0.1:8080",
    token: "synthetic-r5-test-token",
    endpointTrust: "private",
    fetch: fetchImpl,
  });
}

function success(): Response {
  return Response.json(reply);
}

/** The response headers arrive immediately; its real stream closes at the given time. */
function delayedBody(delay: number): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(reply)));
          controller.close();
        }, delay);
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("R5 fixed recall budget and breaker accounting", () => {
  beforeEach(() => {
    resetMemmyCircuitBreakers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetMemmyCircuitBreakers();
  });

  it("accepts a transport response at literal 2499ms", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      () => new Promise((resolve) => setTimeout(() => resolve(success()), 2499)),
    );
    const pending = client(fetchImpl).search(input);
    await vi.advanceTimersByTimeAsync(2499);
    expect(await pending).toMatchObject({ ok: true, value: { sourceMemoryIds: ["memory-1"] } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a 2501ms transport at literal 2500ms and aborts its signal", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      () => new Promise((resolve) => setTimeout(() => resolve(success()), 2501)),
    );
    const settled = vi.fn();
    const pending = client(fetchImpl).search(input).then(settled);
    await vi.advanceTimersByTimeAsync(2499);
    expect(settled).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "timeout" });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    // Even a transport seam that ignores abort cannot turn its late result into success.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("includes a 2499ms response body in the same search budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => delayedBody(2499));
    const pending = client(fetchImpl).search(input);
    await vi.advanceTimersByTimeAsync(2499);
    expect(await pending).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a 2501ms response body even though its headers arrived immediately", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => delayedBody(2501));
    const pending = client(fetchImpl).search(input);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toEqual({ ok: false, error: "timeout" });
    await vi.advanceTimersByTimeAsync(1);
  });

  it("bounds both namespace bodies by one elapsed 2500ms window", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => delayedBody(2499))
      .mockImplementationOnce(async () => delayedBody(2501));
    const pending = client(fetchImpl).search({
      ...input,
      namespaces: [...input.namespaces, { source: "rakazo", profileId: "space:one" }],
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toEqual({ ok: false, error: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
  });

  it("caller aborts neither increment nor clear two accumulated genuine failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}, { status: 503 }));
    const memmy = client(fetchImpl);
    expect(await memmy.search(input)).toEqual({ ok: false, error: "http_503" });
    expect(await memmy.search(input)).toEqual({ ok: false, error: "http_503" });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      fetchImpl.mockImplementationOnce(() => new Promise<Response>(() => {}));
      const controller = new AbortController();
      const pending = memmy.search(input, controller.signal);
      await vi.advanceTimersByTimeAsync(2499);
      controller.abort(new Error("caller cancelled"));
      expect(await pending).toEqual({ ok: false, error: "aborted" });
    }

    expect(await memmy.search(input)).toEqual({ ok: false, error: "http_503" });
    expect(await memmy.search(input)).toEqual({ ok: false, error: "circuit_open" });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("three real timeouts open the breaker and late successes do not reset it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      () => new Promise((resolve) => setTimeout(() => resolve(success()), 2501)),
    );
    const memmy = client(fetchImpl);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = memmy.search(input);
      await vi.advanceTimersByTimeAsync(2500);
      expect(await pending).toEqual({ ok: false, error: "timeout" });
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await memmy.search(input)).toEqual({ ok: false, error: "circuit_open" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("blocks through 59999ms after failure three and recovers at 60000ms and second 61", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}, { status: 503 }));
    const memmy = client(fetchImpl);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await memmy.search(input)).toEqual({ ok: false, error: "http_503" });
    }
    expect(await memmy.search(input)).toEqual({ ok: false, error: "circuit_open" });
    await vi.advanceTimersByTimeAsync(59999);
    expect(await memmy.search(input)).toEqual({ ok: false, error: "circuit_open" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    fetchImpl.mockImplementation(async () => success());
    await vi.advanceTimersByTimeAsync(1);
    expect((await memmy.search(input)).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await memmy.search(input)).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("a successful search clears prior failures before a new three-failure streak", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}, { status: 503 }));
    const memmy = client(fetchImpl);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await memmy.search(input)).toEqual({ ok: false, error: "http_503" });
    }
    fetchImpl.mockImplementationOnce(async () => success());
    expect((await memmy.search(input)).ok).toBe(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await memmy.search(input)).toEqual({ ok: false, error: "http_503" });
    }
    expect(await memmy.search(input)).toEqual({ ok: false, error: "circuit_open" });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});
