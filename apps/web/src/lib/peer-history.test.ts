import type { ThreadMessage } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPeerHistory } from "./peer-history";

function message(id: string, seq: number): ThreadMessage {
  return { id, seq } as ThreadMessage;
}

afterEach(() => vi.useRealTimers());

describe("peer history loading", () => {
  it("collects paginated messages in chronological page order", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ messages: [message("new", 2)], olderCursor: 2 })
      .mockResolvedValueOnce({ messages: [message("old", 1)], olderCursor: null });

    const messages = await loadPeerHistory({
      signal: new AbortController().signal,
      loadPage,
    });

    expect(messages.map(({ id }) => id)).toEqual(["old", "new"]);
    expect(loadPage.mock.calls.map(([before]) => before)).toEqual([undefined, 2]);
  });

  it("aborts a page that never settles before the full-history deadline", async () => {
    vi.useFakeTimers();
    const loadPage = vi.fn(
      (_before: number | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory({
      signal: new AbortController().signal,
      loadPage,
      pageTimeoutMs: 100,
      totalTimeoutMs: 1_000,
    });
    const rejected = expect(loading).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("bounds the full-history scan independently of the per-page timeout", async () => {
    vi.useFakeTimers();
    const loadPage = vi.fn(
      (_before: number | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory({
      signal: new AbortController().signal,
      loadPage,
      pageTimeoutMs: 1_000,
      totalTimeoutMs: 100,
    });
    const rejected = expect(loading).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("aborts an in-flight page when the viewer closes", async () => {
    const lifecycle = new AbortController();
    const loadPage = vi.fn(
      (_before: number | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory({ signal: lifecycle.signal, loadPage });
    const rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    lifecycle.abort();

    await rejected;
  });
});
