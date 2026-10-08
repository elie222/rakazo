import type { ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerSandboxProvider,
  MAX_SANDBOX_ERROR_RESPONSE_BYTES,
  MAX_SANDBOX_SUCCESS_RESPONSE_BYTES,
  SCREEN_RELEASE_TIMEOUT_MS,
} from "./docker-sandbox.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";

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
      { argv: ["sleep", "10"], unsetEnv: ["FAILED"], timeoutMs: 75 },
      context,
    )) {
      events.push(event);
    }

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      argv: ["env", "-u", "FAILED", "--", "sleep", "10"],
      cwd: "/home/rakazo",
      timeoutMs: 75,
    });
    expect(events).toEqual([
      { type: "stdout", data: "partial output\n" },
      { type: "stderr", data: "command timed out after 75 ms\n" },
      { type: "exit", code: 124 },
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-rakazo-bot-id": "bot",
      "x-rakazo-screen-id": "bot",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-request-id": expect.any(String),
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
    });
  });

  it("yields stdout from a streaming exec before the command exits", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({ type: "stdout", data: "code: ABCD-1234\nhttps://github.com/login/device\n" })}\n`,
                ),
              );
              await exitGate;
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "exit", code: 0 })}\n`));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const iterator = provider
      .execute(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        { argv: ["gh", "auth", "login", "--web"], timeoutMs: 5_000 },
        context,
      )
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({
      type: "stdout",
      data: "code: ABCD-1234\nhttps://github.com/login/device\n",
    });
    let exitSeen = false;
    const rest = (async () => {
      const next = await iterator.next();
      exitSeen = true;
      return next;
    })();
    await Promise.resolve();
    expect(exitSeen).toBe(false);
    releaseExit();
    await expect(rest).resolves.toEqual({ value: { type: "exit", code: 0 }, done: false });
  });

  it("rejects a declared oversized success response without buffering it", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-length": String(MAX_SANDBOX_SUCCESS_RESPONSE_BYTES + 1) },
          }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).rejects.toThrow(`sandbox response exceeds ${MAX_SANDBOX_SUCCESS_RESPONSE_BYTES} bytes`);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it.each([
    [
      { id: "computer", resumed: true, started: true },
      { fresh: false, started: true },
    ],
    [{ id: "computer", resumed: true, started: false }, { fresh: false }],
    [{ id: "computer", resumed: true }, { fresh: false }],
    [{ id: "computer", resumed: false }, { fresh: true }],
  ])("reports whether provisioning started the computer: %j", async (body, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).resolves.toStrictEqual({
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
      ...expected,
    });
  });

  it("translates a 429 computer limit reached error from the supervisor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Computer limit reached for space (max: 5)" }, { status: 429 }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).rejects.toThrow("Computer limit reached for space (max: 5)");
  });

  it("stops a streamed file response at the caller-derived encoded limit", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1029));
              },
              cancel,
            }),
          ),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.readFile(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        "small.txt",
        context,
        { maxBytes: 1 },
      ),
    ).rejects.toThrow("sandbox response exceeds 1028 bytes");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("accepts a valid encoded envelope above the generic response cap", async () => {
    const maxBytes = 13 * 1024 * 1024;
    const encodedLimit = Math.ceil(maxBytes / 3) * 4 + 1024;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"content":""}', {
            headers: { "content-length": String(encodedLimit) },
          }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.readFile(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        "large.bin",
        context,
        { maxBytes },
      ),
    ).resolves.toEqual(new Uint8Array());
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
          "x-rakazo-screen-id": "bot",
          "x-rakazo-screen-lease-id": "run-1:1",
          "x-rakazo-space-id": "workspace",
        }),
      }),
    );
  });

  it("still releases the screen after the run abort signal has fired", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ error: "computer not found" }, { status: 404 }),
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

  it("reports a supervisor teardown failure instead of a finished release", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "computer screen failed to stop" }, { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "home-bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.releaseScreen(computer, context)).rejects.toThrow(
      "sandbox screen release failed: 500",
    );

    fetchMock.mockImplementation(async () =>
      Response.json({ error: "computer screen failed to stop" }, { status: 404 }),
    );
    await expect(provider.releaseScreen(computer, context)).rejects.toThrow(
      "sandbox screen release failed: 404",
    );
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

describe("Docker page browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the owned computer screen and lease instead of the generic exec endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, title: "Fixture", url: "https://example.test" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await provider.pageBrowser(
      { id: "computer", botId: "team-home", kind: "docker", providerRef: "computer" },
      { command: "snapshot" },
      context,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer/browser",
      expect.objectContaining({
        redirect: "error",
        signal: context.signal,
        body: JSON.stringify({ command: "snapshot" }),
        headers: expect.objectContaining({
          "x-rakazo-bot-id": "team-home",
          "x-rakazo-screen-lease-id": "run-1:1",
        }),
      }),
    );
  });
});

describe("Docker sandbox stopped containers", () => {
  const computer = {
    id: "computer",
    botId: "bot",
    kind: "docker" as const,
    providerRef: "computer",
  };

  function supervisorWith(status: Response | (() => Response)) {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/screen-mode")) {
        return Response.json(
          { error: "(HTTP code 409) container stopped/paused - container computer is not running" },
          { status: 400 },
        );
      }
      if (url.endsWith("/computers/computer") && (init?.method ?? "GET") === "GET") {
        return typeof status === "function" ? status() : status;
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a control revoke on a stopped container as already released", async () => {
    const fetchMock = supervisorWith(() => Response.json({ id: "computer", running: false }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(provider.setScreenControl(computer, false, context, "lease-1")).resolves.toBe(
      undefined,
    );

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "http://supervisor.test/computers/computer/screen-mode",
      "http://supervisor.test/computers/computer",
    ]);
  });

  it("reports a stopped container gone when granting interactive control", async () => {
    supervisorWith(() => Response.json({ id: "computer", running: false }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const error = await provider.setScreenControl(computer, true, context, "lease-1").then(
      () => null,
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("reports a stopped container gone instead of a blank screen", async () => {
    supervisorWith(() => Response.json({ id: "computer", running: false }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const error = await provider
      .connectScreen(computer, { view: "stream", interactive: false }, context)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("does not treat a supervisor lookup failure as a stopped container", async () => {
    // The supervisor answers 404 for any inspection error, not only a missing container.
    supervisorWith(() => Response.json({ error: "computer not found" }, { status: 404 }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(provider.setScreenControl(computer, false, context, "lease-1")).rejects.toThrow(
      /sandbox screen mode failed: 400/,
    );
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
    ).resolves.toMatchObject({ url: null });
  });

  it("propagates cancellation raised while checking the container", async () => {
    const controller = new AbortController();
    supervisorWith(() => {
      controller.abort();
      throw controller.signal.reason;
    });
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const cancelable = { ...context, signal: controller.signal };

    await expect(
      provider.setScreenControl(computer, false, cancelable, "lease-1"),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps a screen-mode failure on a live container an error", async () => {
    supervisorWith(() => Response.json({ id: "computer", running: true }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(provider.setScreenControl(computer, false, context, "lease-1")).rejects.toThrow(
      /sandbox screen mode failed: 400 .*is not running/,
    );
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
    ).resolves.toMatchObject({ url: null });
  });

  it("does not guess when the supervisor cannot describe the container", async () => {
    supervisorWith(() => new Response("upstream unavailable", { status: 502 }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(provider.setScreenControl(computer, false, context, "lease-1")).rejects.toThrow(
      /sandbox screen mode failed: 400/,
    );
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
    ).resolves.toMatchObject({ url: null });
  });
});
