import { describe, expect, it, vi } from "vitest";
import { createCallSendTracker } from "./call-session.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("call send tracker", () => {
  it("closes at once when nothing is in flight", () => {
    const sends = createCallSendTracker();
    const close = vi.fn(async () => undefined);
    sends.closeAfterSends("call-1", close);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes only after every in-flight send settles, even a failed one", async () => {
    const sends = createCallSendTracker();
    const first = deferred();
    const second = deferred();
    sends.track("call-1", first.promise);
    sends.track("call-1", second.promise);
    const close = vi.fn(async () => undefined);
    sends.closeAfterSends("call-1", close);
    first.reject(new Error("offline"));
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    second.resolve();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("keeps calls apart and forgets released sends", () => {
    const sends = createCallSendTracker();
    const release = sends.track("call-1", new Promise(() => undefined));
    const otherCall = vi.fn(async () => undefined);
    sends.closeAfterSends("call-2", otherCall);
    expect(otherCall).toHaveBeenCalledTimes(1);
    release();
    const close = vi.fn(async () => undefined);
    sends.closeAfterSends("call-1", close);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed close", async () => {
    const sends = createCallSendTracker();
    const close = vi.fn(() => Promise.reject(new Error("gone")));
    sends.closeAfterSends("call-1", close);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
