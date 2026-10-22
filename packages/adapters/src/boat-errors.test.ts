import { ResponseError } from "@boatdev/sdk";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoatApiError, boatResponseError, wrapBoatCall } from "./boat-errors.js";
import { BoatSandboxProvider } from "./boat-sandbox.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

afterEach(() => vi.unstubAllGlobals());

describe("Boat API errors", () => {
  it("reports the upstream failure through the real SDK-backed file operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "sandbox_direct_failed",
            message: "File is too large for read_file. Use artifact download instead.",
            requestId: "req_example",
          },
          { status: 400 },
        ),
      ),
    );
    const provider = new BoatSandboxProvider({ apiKey: "fake-boat-key" });
    await expect(
      provider.readFile(
        { id: "boat-test", providerRef: "boat-test", botId: "bot-test", kind: "boat" },
        "data.bin",
        {
          operationId: "test",
          traceId: "test",
          spaceId: "test",
          userId: "test",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(
      "Boat API request failed (HTTP 400, sandbox_direct_failed): File is too large for read_file. Use artifact download instead. (request req_example)",
    );
  });

  it("reports a sandbox that no longer exists as gone, but not a missing file", async () => {
    const notFound = () =>
      Response.json({ code: "not_found", message: "not_found" }, { status: 404 });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "test",
      userId: "test",
      signal: new AbortController().signal,
    };
    const computer = { id: "gone", providerRef: "gone", botId: "bot-test", kind: "boat" as const };
    const provider = new BoatSandboxProvider({ apiKey: "fake-boat-key" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => notFound()),
    );
    const gone = await provider.keepAlive(computer).catch((error: unknown) => error);
    expect(isSandboxGoneError(gone)).toBe(true);
    expect((gone as Error).name).toBe("SandboxNotFoundError");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        new URL(String(input)).pathname.endsWith("/sandboxes/gone")
          ? Response.json({ ok: true, type: "sandbox.info", sandbox: { id: "gone" } })
          : notFound(),
      ),
    );
    const missingFile = await provider
      .readFile(computer, "missing.txt", context)
      .catch((error: unknown) => error);
    expect(isSandboxGoneError(missingFile)).toBe(false);

    const cancel = new AbortController();
    const lookups: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (!new URL(String(input)).pathname.endsWith("/sandboxes/gone")) return notFound();
        lookups.push(init?.signal);
        cancel.abort(new Error("cancelled"));
        throw init?.signal?.reason;
      }),
    );
    await expect(
      provider.readFile(computer, "missing.txt", { ...context, signal: cancel.signal }),
    ).rejects.toThrow();
    expect(lookups[0]?.aborted).toBe(true);
  });

  it("keeps the HTTP status and Boat's error code and does not retry failed commands", async () => {
    const call = vi.fn(async () => {
      throw new ResponseError(
        Response.json({ code: "not_found", message: "Boat not found" }, { status: 404 }),
      );
    });
    const error = await wrapBoatCall(call, "fake-key")().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(BoatApiError);
    expect(error).toMatchObject({ code: "not_found", response: { status: 404 } });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports a rate limit as a provider-neutral error that keeps the upstream detail", async () => {
    const call = wrapBoatCall(async () => {
      throw new ResponseError(
        Response.json(
          { code: "rate_limited", message: "Rate limit hit: 200 sandbox starts per day" },
          { status: 429 },
        ),
      );
    }, "fake-key");
    const error = await call().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxRateLimitError);
    expect((error as Error).cause).toBeInstanceOf(ResponseError);
    expect(((error as Error).cause as Error).message).toContain("HTTP 429, rate_limited");
  });

  it("stops waiting to retry an unsent request once the caller cancels", async () => {
    const controller = new AbortController();
    const call = vi.fn(async (_request: unknown, _init: RequestInit) => {
      controller.abort();
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
      });
    });
    const wrapped = wrapBoatCall(call, "fake-key", true);
    await expect(wrapped({}, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it("does not replace cancellation and network errors", async () => {
    const cancelled = new DOMException("Cancelled", "AbortError");
    const call = wrapBoatCall(async () => {
      throw cancelled;
    }, "fake-key");
    await expect(call()).rejects.toBe(cancelled);
  });

  it("redacts credentials and signed URLs while retaining the useful diagnosis", async () => {
    const error = await boatResponseError(
      Response.json(
        {
          code: "unauthorized",
          message:
            "Rejected fake-boat-key; Bearer other-credential; see https://boat.example/desktop?token=private-value",
        },
        { status: 401 },
      ),
      "fake-boat-key",
    );
    expect(error.message).toContain("HTTP 401, unauthorized");
    for (const secret of ["fake-boat-key", "other-credential", "private-value"]) {
      expect(error.message).not.toContain(secret);
    }
  });

  it.each(["upstream HTML", "null", "[]", '{"message":42}'])(
    "uses an HTTP fallback for malformed or unstructured errors: %s",
    async (body) => {
      const error = await boatResponseError(new Response(body, { status: 502 }), "fake-key");
      expect(error.message).toBe("Boat API request failed (HTTP 502)");
    },
  );

  it("caps upstream detail and stops reading oversized error bodies", async () => {
    const error = await boatResponseError(
      Response.json({ message: "x".repeat(1_000) }, { status: 400 }),
      "fake-key",
    );
    expect(error.message.length).toBeLessThan(600);

    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20_000));
        },
        cancel,
      }),
      { status: 503 },
    );
    expect((await boatResponseError(response, "fake-key")).message).toBe(
      "Boat API request failed (HTTP 503)",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("falls back to the HTTP status when an error body stalls", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }),
      { status: 504 },
    );

    const pending = boatResponseError(response, "fake-key", controller.signal);
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(pending).resolves.toMatchObject({
      message: "Boat API request failed (HTTP 504)",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
