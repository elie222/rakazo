import { ResponseError } from "@asciidev/box-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boxResponseError, wrapBoxCall } from "./box-errors.js";
import { BoxSandboxProvider, isUnrecoverableBoxError } from "./box-sandbox.js";

afterEach(() => vi.unstubAllGlobals());

describe("Box API errors", () => {
  it("reports the upstream failure through the real SDK-backed file operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "box_direct_failed",
            message: "File is too large for read_file. Use artifact download instead.",
            requestId: "req_example",
          },
          { status: 400 },
        ),
      ),
    );
    const provider = new BoxSandboxProvider({ apiKey: "fake-box-key" });
    await expect(
      provider.readFile(
        { id: "box-test", providerRef: "box-test", botId: "bot-test", kind: "box" },
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
      "Box API request failed (HTTP 400, box_direct_failed): File is too large for read_file. Use artifact download instead. (request req_example)",
    );
  });

  it("preserves 404 recovery and does not retry failed commands", async () => {
    const call = vi.fn(async () => {
      throw new ResponseError(Response.json({ message: "Box not found" }, { status: 404 }));
    });
    const error = await wrapBoxCall(call, "fake-key")().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ResponseError);
    expect(isUnrecoverableBoxError(error)).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not replace cancellation and network errors", async () => {
    const cancelled = new DOMException("Cancelled", "AbortError");
    const call = wrapBoxCall(async () => {
      throw cancelled;
    }, "fake-key");
    await expect(call()).rejects.toBe(cancelled);
  });

  it("redacts credentials and signed URLs while retaining the useful diagnosis", async () => {
    const error = await boxResponseError(
      Response.json(
        {
          code: "unauthorized",
          message:
            "Rejected fake-box-key; Bearer other-credential; see https://box.example/desktop?token=private-value",
        },
        { status: 401 },
      ),
      "fake-box-key",
    );
    expect(error.message).toContain("HTTP 401, unauthorized");
    for (const secret of ["fake-box-key", "other-credential", "private-value"]) {
      expect(error.message).not.toContain(secret);
    }
  });

  it.each(["upstream HTML", "null", "[]", '{"message":42}'])(
    "uses an HTTP fallback for malformed or unstructured errors: %s",
    async (body) => {
      const error = await boxResponseError(new Response(body, { status: 502 }), "fake-key");
      expect(error.message).toBe("Box API request failed (HTTP 502)");
    },
  );

  it("caps upstream detail and stops reading oversized error bodies", async () => {
    const error = await boxResponseError(
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
    expect((await boxResponseError(response, "fake-key")).message).toBe(
      "Box API request failed (HTTP 503)",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
