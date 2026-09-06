import { describe, expect, it, vi } from "vitest";
import { ResponseBodyTooLargeError, readBoundedJsonResponse } from "./http-response.js";

describe("readBoundedJsonResponse", () => {
  it("parses a fragmented JSON response", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"ok":'));
          controller.enqueue(encoder.encode("true}"));
          controller.close();
        },
      }),
    );

    await expect(readBoundedJsonResponse(response, 64)).resolves.toEqual({ ok: true });
  });

  it("rejects and cancels a response with an oversized declared length", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "65" },
    });

    await expect(readBoundedJsonResponse(response, 64)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("rejects and cancels a streamed response that crosses the limit", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65));
        },
        cancel,
      }),
    );

    await expect(readBoundedJsonResponse(response, 64)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("aborts a stalled body read", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const controller = new AbortController();
    const pending = readBoundedJsonResponse(response, 64, controller.signal);

    controller.abort(new Error("request timed out"));

    await expect(pending).rejects.toThrow("request timed out");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("rejects malformed JSON after a complete bounded read", async () => {
    await expect(readBoundedJsonResponse(new Response("not-json"), 64)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});
