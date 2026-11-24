import { describe, expect, it, vi } from "vitest";
import {
  ResponseTooLargeError,
  readBoundedResponseBytes,
  readErrorTextWithin,
  readJsonObjectWithin,
  readResponseWithin,
} from "./response-bytes.js";

const options = {
  maxBytes: 4,
  tooLargeMessage: "Response exceeds the limit.",
  read: <T>(operation: () => Promise<T>) => operation(),
};

describe("readBoundedResponseBytes", () => {
  it("keeps chunk order and accepts exactly the byte limit", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array());
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
    );
    await expect(readBoundedResponseBytes(response, options)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(response.body?.locked).toBe(false);
  });

  it("rejects oversized streams without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
        cancel,
      }),
    );
    await expect(readBoundedResponseBytes(response, options)).rejects.toThrow(
      options.tooLargeMessage,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("preserves deadline failures and does not begin a rejected read", async () => {
    const reason = new Error("Request deadline elapsed.");
    const read = vi.fn();
    const cancel = vi.fn().mockRejectedValue(new Error("Cleanup failed."));
    const releaseLock = vi.fn();
    const response = {
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    await expect(
      readBoundedResponseBytes(response, {
        ...options,
        read: () => Promise.reject(reason),
      }),
    ).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("does not mask a read failure when stream cleanup throws", async () => {
    const reason = new Error("Stream failed.");
    const cancel = vi.fn(() => {
      throw new Error("Cancellation failed.");
    });
    const releaseLock = vi.fn(() => {
      throw new Error("Lock already released.");
    });
    const response = {
      body: { getReader: () => ({ read: () => Promise.reject(reason), cancel, releaseLock }) },
    } as unknown as Response;
    await expect(readBoundedResponseBytes(response, options)).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("checks the no-stream fallback size and passes its read lazily", async () => {
    const arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(5));
    const response = { body: null, arrayBuffer } as unknown as Response;
    const reason = new Error("Cancelled before reading.");
    await expect(
      readBoundedResponseBytes(response, { ...options, read: () => Promise.reject(reason) }),
    ).rejects.toBe(reason);
    expect(arrayBuffer).not.toHaveBeenCalled();
    await expect(readBoundedResponseBytes(response, options)).rejects.toThrow(
      options.tooLargeMessage,
    );
    arrayBuffer.mockResolvedValue(new ArrayBuffer(4));
    await expect(readBoundedResponseBytes(response, options)).resolves.toEqual(new Uint8Array(4));
  });
});

describe("readResponseWithin", () => {
  const within = {
    maxBytes: 4,
    tooLargeMessage: "Too large.",
    signal: new AbortController().signal,
  };

  it("refuses an oversized declared length before reading and releases the body", async () => {
    const response = new Response("12345", { headers: { "content-length": "5" } });
    const cancel = vi.spyOn(response.body as ReadableStream, "cancel");
    await expect(readResponseWithin(response, within)).rejects.toThrow("Too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reads a body within the budget and stops when the signal aborts", async () => {
    await expect(readResponseWithin(new Response("1234"), within)).resolves.toEqual(
      new TextEncoder().encode("1234"),
    );
    await expect(
      readResponseWithin(new Response("1234"), { ...within, signal: undefined }),
    ).resolves.toEqual(new TextEncoder().encode("1234"));
    const controller = new AbortController();
    const stalled = new Response(new ReadableStream({ start() {} }));
    const pending = readResponseWithin(stalled, { ...within, signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});

describe("readErrorTextWithin", () => {
  const within = { maxBytes: 8, timeoutMs: 1_000 };

  it("returns the body text within the budget", async () => {
    await expect(readErrorTextWithin(new Response("bad key"), within)).resolves.toBe("bad key");
  });

  it("reads an oversized body as empty and releases it unread", async () => {
    const declared = new Response("123456789", { headers: { "content-length": "9" } });
    const cancel = vi.spyOn(declared.body as ReadableStream, "cancel");
    await expect(readErrorTextWithin(declared, within)).resolves.toBe("");
    expect(cancel).toHaveBeenCalledOnce();
    await expect(readErrorTextWithin(new Response("123456789"), within)).resolves.toBe("");
  });

  it("reads a failing or stalled body as empty", async () => {
    const failing = new Response(
      new ReadableStream({ pull: (controller) => controller.error(new Error("reset")) }),
    );
    await expect(readErrorTextWithin(failing, within)).resolves.toBe("");
    const controller = new AbortController();
    const stalled = new Response(new ReadableStream({ start() {} }));
    const pending = readErrorTextWithin(stalled, { ...within, signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(pending).resolves.toBe("");
  });
});

describe("readJsonObjectWithin", () => {
  const within = {
    maxBytes: 64,
    tooLargeMessage: "Too large.",
    signal: new AbortController().signal,
  };

  it("returns a JSON object and reads anything else as empty", async () => {
    await expect(readJsonObjectWithin(new Response('{"error":"no"}'), within)).resolves.toEqual({
      error: "no",
    });
    await expect(readJsonObjectWithin(new Response("<html>"), within)).resolves.toEqual({});
    await expect(readJsonObjectWithin(new Response("3"), within)).resolves.toEqual({});
  });

  it("still fails an oversized body", async () => {
    await expect(readJsonObjectWithin(new Response("x".repeat(65)), within)).rejects.toThrow(
      "Too large.",
    );
  });
});

describe("ResponseTooLargeError", () => {
  it.each([
    ["a declared length", new Response("12345", { headers: { "content-length": "5" } })],
    ["a streamed body", new Response(new Uint8Array(5))],
  ])("names a response over its budget by %s", async (_, response) => {
    const failure = readResponseWithin(response, {
      maxBytes: 4,
      tooLargeMessage: "Response exceeds the limit.",
      signal: new AbortController().signal,
    });
    await expect(failure).rejects.toBeInstanceOf(ResponseTooLargeError);
    await expect(failure).rejects.toThrow("Response exceeds the limit.");
  });
});
