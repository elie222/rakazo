import type * as TimersPromises from "node:timers/promises";
import type { SandboxStateEnum } from "@boatdev/sdk";
import { ResponseError } from "@boatdev/sdk";
import type { ComputerRef } from "@rakazo/adapter-kit";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { parse } from "shell-quote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoatSandboxProvider } from "./boat-sandbox.js";
import type { BoatRecovery } from "./boat-sandbox.test-support.js";
import { FakeBoatApi } from "./boat-sandbox.test-support.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

// Polling waits advance a virtual clock, so state and deadline tests run instantly.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: async (ms = 0) => {
    vi.setSystemTime(Date.now() + ms);
  },
}));

const context = {
  operationId: "test",
  traceId: "trace",
  spaceId: "workspace",
  userId: "user",
  botId: "bot-a",
  signal: new AbortController().signal,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function boat() {
  const api = new FakeBoatApi();
  const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  return { api, provider, computer };
}

function reconnect(provider: BoatSandboxProvider, computer: ComputerRef) {
  return provider.provision(
    {
      botId: computer.botId,
      homePath: "/unused",
      providerRef: computer.providerRef,
      providerKind: "boat",
    },
    context,
  );
}

describe("BoatSandboxProvider", () => {
  it("creates no-env sandboxes and implements execution and file operations", async () => {
    const api = new FakeBoatApi();
    const create = vi.spyOn(api, "create");
    const command = vi.spyOn(api, "command");
    const provider = new BoatSandboxProvider({ apiKey: "test-key" }, api);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer).toMatchObject({
      id: "bx_fake1",
      providerRef: "bx_fake1",
      kind: "boat",
      fresh: true,
    });
    expect(create).toHaveBeenCalledWith(
      {
        createSandboxRequest: {
          ttlSeconds: 7200,
          noEnv: true,
          env: { RAKAZO_BOT_ID: "bot-a", RAKAZO_SANDBOX: "computer" },
        },
      },
      { signal: context.signal },
    );

    await provider.prepare(computer, context);
    expect(
      command.mock.calls.some(([request]) =>
        "commandRequest" in request
          ? request.commandRequest.command.includes("rakazo-home/.browser-profiles")
          : false,
      ),
    ).toBe(true);

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "hello"], cwd: "notes", env: { TEST_VALUE: "works" }, unsetEnv: ["FAILED"] },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    const executeRequest = command.mock.calls
      .map(([request]) => ("commandRequest" in request ? request.commandRequest : undefined))
      .find((request) => request?.command.includes("TEST_VALUE=works"));
    expect(parse(executeRequest?.command ?? "").at(-1)).toBe(
      "'env' 'TEST_VALUE=works' 'env' '-u' 'FAILED' '--' 'echo' 'hello'",
    );
    expect(executeRequest?.cwd).toBe("rakazo-home/notes");

    await provider.writeFile(
      computer,
      { path: "bin/tool", content: Uint8Array.from([0, 255, 1]), executable: true },
      context,
    );
    expect(await provider.readFile(computer, "bin/tool", context)).toEqual(
      Uint8Array.from([0, 255, 1]),
    );
    expect(await provider.listFiles(computer, "bin", context)).toEqual([
      { path: "bin/tool", kind: "file", size: 3, executable: true },
    ]);
    const exported = [];
    for await (const file of provider.exportWorkspace(computer, context)) exported.push(file);
    expect(exported).toEqual([
      { path: "bin/tool", content: Uint8Array.from([0, 255, 1]), executable: true },
    ]);
  });

  it("resumes an archived sandbox with no inherited environment", async () => {
    const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
    const { api, provider, computer } = await boat();
    api.setState(computer.id, "archived");

    await expect(reconnect(provider, computer)).resolves.toMatchObject({
      providerRef: computer.providerRef,
      fresh: false,
      started: true,
    });
    expect(resume).toHaveBeenCalledWith(
      { sandboxId: computer.id, resumeRequest: { noEnv: true, ttlSeconds: 7200 } },
      { signal: context.signal },
    );
  });

  // Every Boat state, error and recover answer either leaves a usable sandbox or reports it gone
  // so the caller replaces it from its checkpoint. Nothing may keep failing on the same ref.
  type Outcome = "kept" | "started" | "replaced";
  const stateOutcomes: Record<SandboxStateEnum, Outcome> = {
    init: "kept",
    provisioning: "kept",
    provisioned: "kept",
    cloning: "kept",
    ready: "kept",
    idle: "kept",
    running: "kept",
    archiving: "started",
    archived: "started",
    error: "started",
    cancelled: "replaced",
  };
  const recoveryOutcomes: Record<BoatRecovery, Outcome> = {
    recovers: "started",
    no_machine: "started",
    too_soon: "started",
    sandbox_is_reachable: "started",
    stuck: "replaced",
    recover_unsupported: "replaced",
    reset_failed: "replaced",
  };
  const lifecycle: [string, (api: FakeBoatApi, id: string) => void, Outcome][] = [
    ...Object.entries(stateOutcomes).map(
      ([state, outcome]): [string, (api: FakeBoatApi, id: string) => void, Outcome] => [
        `state ${state}`,
        (api, id) =>
          state === "error" ? api.fail(id) : api.setState(id, state as SandboxStateEnum),
        outcome,
      ],
    ),
    ...Object.entries(recoveryOutcomes).map(
      ([recovery, outcome]): [string, (api: FakeBoatApi, id: string) => void, Outcome] => [
        `error state, recover answers ${recovery}`,
        (api, id) => api.fail(id, recovery as BoatRecovery),
        outcome,
      ],
    ),
    ["snapshot data expired", (api, id) => api.expire(id), "replaced"],
    ["deleted", (api, id) => api.delete(id), "replaced"],
  ];

  it.each(lifecycle)(
    "prepare on %s either works or reports the sandbox gone",
    async (_name, setup, outcome) => {
      const { api, provider, computer } = await boat();
      setup(api, computer.id);

      const result = await provider.prepare(computer, context).then(
        () => "ready",
        (error: unknown) => error,
      );
      if (outcome === "replaced") expect(isSandboxGoneError(result)).toBe(true);
      else expect(result).toBe("ready");
    },
  );

  it.each(lifecycle)(
    "reconnecting on %s keeps a usable sandbox or replaces it",
    async (_name, setup, outcome) => {
      const { api, provider, computer } = await boat();
      setup(api, computer.id);

      const ref = await reconnect(provider, computer);
      await provider.prepare(ref, context);
      expect(ref.providerRef === computer.providerRef).toBe(outcome !== "replaced");
      expect(ref.fresh).toBe(outcome === "replaced");
      if (outcome !== "replaced") expect(ref.started).toBe(outcome === "started");
      expect(["ready", "idle", "running"]).toContain(api.state(ref.providerRef));
    },
  );

  it("resumes a sandbox Boat archived on its own and retries the refused work once", async () => {
    const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
    const { api, provider, computer } = await boat();
    await provider.prepare(computer, context);
    await provider.writeFile(computer, { path: "kept.txt", content: Uint8Array.of(1) }, context);
    // The TTL ran out with no sleep job to stop it first.
    api.setState(computer.id, "archived");

    expect(await provider.readFile(computer, "kept.txt", context)).toEqual(Uint8Array.of(1));
    expect(resume).toHaveBeenCalledOnce();
    api.setState(computer.id, "archived");
    const events = [];
    for await (const event of provider.execute(computer, { argv: ["echo", "awake"] }, context)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "awake\n" },
      { type: "exit", code: 0 },
    ]);

    api.setState(computer.id, "archived");
    api.expire(computer.id);
    const error = await provider.readFile(computer, "kept.txt", context).catch((e: unknown) => e);
    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("keeps an errored sandbox when Boat refuses recover without a known code", async () => {
    const recover = vi.spyOn(FakeBoatApi.prototype, "recover");
    const { api, provider, computer } = await boat();
    api.fail(computer.id);
    recover.mockRejectedValueOnce(
      new ResponseError(new Response("upstream HTML", { status: 409 }), "conflict"),
    );

    const error = await provider.prepare(computer, context).catch((failure: unknown) => failure);
    expect((error as Error).message).toContain("HTTP 409");
    expect(isSandboxGoneError(error)).toBe(false);
  });

  it("replaces a sandbox whose data expires between the lookup and the resume", async () => {
    const lookup = FakeBoatApi.prototype.get;
    const get = vi.spyOn(FakeBoatApi.prototype, "get");
    const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
    const { api, provider, computer } = await boat();
    api.setState(computer.id, "archived");
    get.mockImplementationOnce(async (request) => {
      const response = await lookup.call(api, request);
      api.expire(computer.id);
      return response;
    });

    const replacement = await reconnect(provider, computer);
    expect(resume).toHaveBeenCalledOnce();
    expect(replacement).toMatchObject({ fresh: true });
    expect(replacement.providerRef).not.toBe(computer.providerRef);
  });

  it("reports Boat's machine-start limit as a rate limit, not a gone sandbox", async () => {
    const { api, provider, computer } = await boat();
    api.rateLimit();

    // Reconnecting to a running sandbox is not a start.
    await expect(reconnect(provider, computer)).resolves.toMatchObject({ fresh: false });

    api.setState(computer.id, "archived");
    const resumed = await reconnect(provider, computer).catch((error: unknown) => error);
    expect(resumed).toBeInstanceOf(SandboxRateLimitError);
    expect(isSandboxGoneError(resumed)).toBe(false);
    expect(((resumed as Error).cause as Error).message).toContain("HTTP 429, rate_limited");

    await expect(
      provider.provision({ botId: "bot-b", homePath: "/unused" }, context),
    ).rejects.toBeInstanceOf(SandboxRateLimitError);
  });

  it("keeps the sandbox when Boat rejects the credentials", async () => {
    const { api, provider, computer } = await boat();
    api.unauthorized();

    const error = await reconnect(provider, computer).catch((failure: unknown) => failure);
    expect((error as Error).message).toContain("HTTP 401, unauthorized");
    expect(isSandboxGoneError(error)).toBe(false);
    expect(error).not.toBeInstanceOf(SandboxRateLimitError);
  });

  it("downloads binary files over the JSON endpoint limit through the SDK artifact route", async () => {
    const content = Buffer.alloc(6 * 1024 * 1024, 0xff);
    content[0] = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(content, { headers: { "content-length": String(content.byteLength) } }),
      );
    const provider = new BoatSandboxProvider({
      apiKey: "test-key",
      apiUrl: "https://boat.test/api/v1",
    });
    const computer = {
      id: "bx_testbox2",
      providerRef: "bx_testbox2",
      kind: "boat" as const,
      botId: "bot-a",
    };
    const filePath = "notes/a file & more.bin";
    const downloaded = await provider.readFile(computer, filePath, context);

    expect(Buffer.from(downloaded).equals(content)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [request, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.pathname).toBe("/api/v1/sandboxes/bx_testbox2/artifacts");
    expect(url.searchParams.get("path")).toBe(`/home/user/rakazo-home/${filePath}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
    expect(init?.signal).toBe(context.signal);
  });

  it("exports browser profile files over 5 MiB without losing their bytes", async () => {
    const artifactRaw = vi.spyOn(FakeBoatApi.prototype, "artifactRaw");
    const { api, provider, computer } = await boat();
    const content = Buffer.alloc(6 * 1024 * 1024, 0xab);
    api.files(computer.id).set("/home/user/rakazo-home/.browser-profiles/chrome/Default/History", {
      content,
      executable: false,
    });
    const exported = [];
    for await (const file of provider.exportWorkspace(computer, context)) exported.push(file);

    expect(exported).toHaveLength(1);
    expect(exported[0]?.path).toBe(".browser-profiles/chrome/Default/History");
    expect(Buffer.from(exported[0]!.content).equals(content)).toBe(true);
    expect(artifactRaw).toHaveBeenCalledWith(
      {
        sandboxId: computer.id,
        path: "/home/user/rakazo-home/.browser-profiles/chrome/Default/History",
      },
      { signal: context.signal },
    );
  });

  it.each([undefined, "1", "20"])(
    "cancels oversized downloads with content-length %s",
    async (contentLength) => {
      const artifactRaw = vi.spyOn(FakeBoatApi.prototype, "artifactRaw");
      const { provider, computer } = await boat();
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
      });
      const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
      artifactRaw.mockResolvedValueOnce({
        raw: new Response(body, {
          headers: contentLength ? { "content-length": contentLength } : undefined,
        }),
        value: async () => new Blob(),
      });

      await expect(
        provider.readFile(computer, "large.bin", context, { maxBytes: 4 }),
      ).rejects.toThrow("computer file exceeds 4 bytes");
      expect(pull).toHaveBeenCalledTimes(contentLength === "20" ? 0 : 2);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it("accepts empty files and files exactly at the download limit", async () => {
    const { api, provider, computer } = await boat();
    const files = api.files(computer.id);
    files.set("/home/user/rakazo-home/empty.bin", { content: new Uint8Array(), executable: false });
    files.set("/home/user/rakazo-home/exact.bin", {
      content: Uint8Array.from([0, 255]),
      executable: false,
    });

    expect(await provider.readFile(computer, "empty.bin", context, { maxBytes: 0 })).toHaveLength(
      0,
    );
    expect(await provider.readFile(computer, "exact.bin", context, { maxBytes: 2 })).toEqual(
      Uint8Array.from([0, 255]),
    );
  });

  it("reports a missing file without calling the sandbox gone", async () => {
    const { provider, computer } = await boat();
    const error = await provider
      .readFile(computer, "missing.txt", context)
      .catch((failure: unknown) => failure);
    expect((error as Error).message).toContain("HTTP 404, not_found");
    expect(isSandboxGoneError(error)).toBe(false);
  });

  it("propagates interrupted downloads instead of returning partial files", async () => {
    const artifactRaw = vi.spyOn(FakeBoatApi.prototype, "artifactRaw");
    const { provider, computer } = await boat();
    const aborted = new DOMException("download aborted", "AbortError");
    let first = true;
    const body = new ReadableStream({
      pull(controller) {
        if (first) controller.enqueue(Uint8Array.from([1, 2, 3]));
        else controller.error(aborted);
        first = false;
      },
    });
    artifactRaw.mockResolvedValueOnce({
      raw: new Response(body),
      value: async () => new Blob(),
    });

    await expect(provider.readFile(computer, "partial.bin", context)).rejects.toBe(aborted);
    expect(body.locked).toBe(false);
  });

  it("captures independent desktops and exposes protected ports", async () => {
    const command = vi.spyOn(FakeBoatApi.prototype, "command");
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);

    const observation = await provider.observe(computer, context);
    expect(observation).toMatchObject({
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 10, y: 20 },
    });
    expect(observation.image).toEqual(Uint8Array.from([1, 2, 3]));

    const screen = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      context,
    );
    expect(new URL(screen.url!).searchParams.get("path")).toMatch(
      /^websockify\?_token=secret&token=view-/,
    );
    expect(screen.url).toContain("_token=secret");

    await provider.act(
      computer,
      { actions: [{ kind: "pointer", type: "click", x: 100, y: 200 }], observe: false },
      context,
    );
    expect(
      command.mock.calls.some(([request]) =>
        "commandRequest" in request
          ? request.commandRequest.command.includes("xdotool mousemove 100 200 click 1")
          : false,
      ),
    ).toBe(true);

    await expect(provider.observe(computer, { ...context, botId: "bot-b" })).resolves.toMatchObject(
      { width: 1280 },
    );
    expect(provider.describe().capabilities.multiScreen).toBe(true);
  });

  it("refuses a desktop URL that is not served over HTTPS", async () => {
    vi.spyOn(FakeBoatApi.prototype, "hostPort").mockResolvedValue({
      ok: true,
      type: "sandbox.host",
      url: "http://boat-test-6100.on.boat.dev?_token=secret",
    });
    const { provider, computer } = await boat();
    await provider.prepare(computer, context);
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
    ).rejects.toThrow("Boat desktop URL is not protected");
  });

  it("archives on stop and permanently deletes on destroy", async () => {
    const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
    const { api, provider, computer } = await boat();

    await provider.stop(computer, context);
    expect(stop).toHaveBeenCalledWith({ sandboxId: computer.id }, { signal: context.signal });
    expect(api.state(computer.id)).toBe("archived");
    await provider.destroy(computer, context);
    expect(api.state(computer.id)).toBeUndefined();
    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
  });

  it("bounds a stalled permanent-delete request", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BoatSandboxProvider({ apiKey: "test-key" });

    const pending = provider.destroy(
      { id: "boat-test", providerRef: "boat-test", botId: "bot-test", kind: "boat" },
      context,
    );
    deadline.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(pending).rejects.toThrow("Boat boat-test was not deleted within 60 seconds");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(deadline.signal);
  });

  it("keeps the same deadline on permanent-delete status polling", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockImplementationOnce(
        async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BoatSandboxProvider({ apiKey: "test-key" });

    const pending = provider.destroy(
      { id: "boat-test", providerRef: "boat-test", botId: "bot-test", kind: "boat" },
      context,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    deadline.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(pending).rejects.toThrow("Boat boat-test was not deleted within 60 seconds");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(deadline.signal);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(deadline.signal);
  });
});
