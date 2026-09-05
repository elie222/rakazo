import { describe, expect, it, vi } from "vitest";
import { linkAbortSignal } from "./link-abort-signal.js";

describe("linkAbortSignal", () => {
  it("runs onAbort immediately when the source has already aborted", () => {
    const source = new AbortController();
    source.abort();
    const onAbort = vi.fn();

    const unlink = linkAbortSignal(source.signal, onAbort);

    expect(onAbort).toHaveBeenCalledTimes(1);
    unlink();
  });

  it("runs onAbort when the source aborts later", () => {
    const source = new AbortController();
    const onAbort = vi.fn();

    linkAbortSignal(source.signal, onAbort);
    expect(onAbort).not.toHaveBeenCalled();
    source.abort();
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("does not run onAbort after unlink", () => {
    const source = new AbortController();
    const onAbort = vi.fn();

    const unlink = linkAbortSignal(source.signal, onAbort);
    unlink();
    source.abort();
    expect(onAbort).not.toHaveBeenCalled();
  });
});
