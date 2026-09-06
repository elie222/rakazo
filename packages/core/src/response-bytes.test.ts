import { describe, expect, it, vi } from "vitest";
import { readBoundedResponseBytes } from "./response-bytes.js";

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
