import type { ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerSandboxProvider,
  MAX_SANDBOX_ERROR_RESPONSE_BYTES,
  SCREEN_RELEASE_TIMEOUT_MS,
} from "./docker-sandbox.js";

const context = {
  operationId: "docker-test",
  traceId: "docker-test",
  spaceId: "workspace",
  userId: "user",
  botId: "bot",
  screenLeaseId: "run-1:1",
  signal: new AbortController().signal,
};

describe("Docker sandbox", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends the bounded timeout to the supervisor and preserves its honest result", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        stdout: "partial output\n",
        stderr: "command timed out after 75 ms\n",
        code: 124,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const events: ProcessEvent[] = [];

    for await (const event of provider.execute(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["sleep", "10"], timeoutMs: 75 },
      context,
    )) {
      events.push(event);
    }

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      argv: ["sleep", "10"],
      cwd: "/home/rakazo",
      timeoutMs: 75,
    });
    expect(events).toEqual([
      { type: "stdout", data: "partial output\n" },
      { type: "stderr", data: "command timed out after 75 ms\n" },
      { type: "exit", code: 124 },
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("x-rakazo-screen-id");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-request-id": expect.any(String),
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
    });
  });

  it("releases this bot's screen assignment through the supervisor", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await provider.releaseScreen(
      { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
      context,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer/screen",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
          "x-rakazo-bot-id": "home-bot",
          "x-rakazo-screen-lease-id": "run-1:1",
          "x-rakazo-space-id": "workspace",
        }),
      }),
    );
  });

  it("still releases the screen after the run abort signal has fired", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const abort = new AbortController();
    abort.abort();

    await expect(
      provider.releaseScreen(
        { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
        { ...context, signal: abort.signal },
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(abort.signal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("bounds screen release even when fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>(() => undefined),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const pending = provider.releaseScreen(
      { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
      context,
    );
    const rejected = expect(pending).rejects.toThrow("sandbox screen release timed out");
    await vi.advanceTimersByTimeAsync(SCREEN_RELEASE_TIMEOUT_MS);

    await rejected;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("surfaces a supervisor failure from stop and destroy instead of swallowing it", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "stale-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).rejects.toThrow(
      'sandbox stop failed: 401 {"error":"unauthorized"}',
    );
    await expect(provider.destroy(computer, context)).rejects.toThrow(
      'sandbox destroy failed: 401 {"error":"unauthorized"}',
    );

    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    await expect(provider.stop(computer, context)).rejects.toThrow("sandbox stop failed: 500 boom");
    await expect(provider.destroy(computer, context)).rejects.toThrow(
      "sandbox destroy failed: 500 boom",
    );
  });

  it("does not buffer an oversized supervisor error body", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 500,
          headers: { "content-length": String(MAX_SANDBOX_ERROR_RESPONSE_BYTES + 1) },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).rejects.toThrow("sandbox stop failed: 500");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("stops reading a streamed supervisor error at the byte limit", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_SANDBOX_ERROR_RESPONSE_BYTES + 1));
            },
          }),
          { status: 500 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.stop(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        context,
      ),
    ).rejects.toThrow("sandbox stop failed: 500");
  });

  it("treats a computer the supervisor no longer knows as already stopped and destroyed", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "computer not found" }, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("asks the supervisor to cancel orphaned run work when releasing a screen", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await provider.releaseScreen(
      { id: "computer-1", botId: "bot", kind: "docker", providerRef: "computer-1" },
      { ...context, cancelRunWork: true },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer-1/screen",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "x-rakazo-cancel-run-work": "1" }),
      }),
    );
  });
});
