import type { AdapterContext, MessagingPlatformDescriptor } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessagingReceipts } from "./messaging-receipts.js";

const SLACK_THREAD = "slack:C1:1700000000.000100";
const SLACK_HANDLE = "1700000000.000100";

function fakeMessaging() {
  const platforms: MessagingPlatformDescriptor[] = [
    { provider: "slack", capabilities: { direct: true, groups: true, receipt: "reaction" } },
    { provider: "sendblue", capabilities: { direct: true, groups: true, receipt: "typing" } },
    { provider: "telegram", capabilities: { direct: true, groups: true, receipt: null } },
  ];
  return {
    platforms: () => platforms,
    acknowledge: vi.fn(
      async (_threadId: string, _handle: string, _context: AdapterContext) => undefined,
    ),
  };
}

const unhandled = async () => false;

describe("createMessagingReceipts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sends typing bubbles immediately", () => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge("sendblue:dm-1", "h-1", unhandled);

    expect(
      messaging.acknowledge.mock.calls.map(([threadId, handle]) => [threadId, handle]),
    ).toEqual([["sendblue:dm-1", "h-1"]]);
  });

  it("reacts only once the reply is a minute late", async () => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge(SLACK_THREAD, SLACK_HANDLE, unhandled);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(messaging.acknowledge.mock.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      messaging.acknowledge.mock.calls.map(([threadId, handle]) => [threadId, handle]),
    ).toEqual([[SLACK_THREAD, SLACK_HANDLE]]);
  });

  it("does not react when the reply already went out", async () => {
    const messaging = fakeMessaging();
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge(SLACK_THREAD, SLACK_HANDLE, async () => true);
    receipts.acknowledge("slack:C1:1700000000.000200", "1700000000.000200", unhandled);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      messaging.acknowledge.mock.calls.map(([threadId, handle]) => [threadId, handle]),
    ).toEqual([["slack:C1:1700000000.000200", "1700000000.000200"]]);
  });

  it("keeps delayed reactions on workspace-scoped Slack messages", async () => {
    const messaging = fakeMessaging();
    const threadId = "slack~installation-a:C1:1700000000.000100";
    const handle = "Ta:1700000000.000100";
    createMessagingReceipts(messaging).acknowledge(threadId, handle, unhandled);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messaging.acknowledge).toHaveBeenCalledWith(threadId, handle, expect.anything());
  });

  it("sends nothing once stopped", async () => {
    const messaging = fakeMessaging();
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge(SLACK_THREAD, SLACK_HANDLE, unhandled);
    let releaseCheck = () => {};
    receipts.acknowledge(
      "slack:C1:1700000000.000200",
      "1700000000.000200",
      () => new Promise((resolve) => (releaseCheck = () => resolve(false))),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    messaging.acknowledge.mockClear();
    receipts.acknowledge("slack:C1:1700000000.000300", "1700000000.000300", unhandled);
    receipts.stop();
    releaseCheck();
    receipts.acknowledge("sendblue:dm-1", "h-1", unhandled);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(messaging.acknowledge).not.toHaveBeenCalled();
  });

  it("logs a failed receipt instead of throwing", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const messaging = fakeMessaging();
    messaging.acknowledge.mockRejectedValue(new Error("missing_scope"));
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge("sendblue:dm-1", "h-1", unhandled);
    receipts.acknowledge(SLACK_THREAD, SLACK_HANDLE, unhandled);
    receipts.acknowledge("slack:C1:1700000000.000200", "1700000000.000200", async () => {
      throw new Error("database unavailable");
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(error.mock.calls.map(([, cause]) => (cause as Error).message)).toEqual([
      "missing_scope",
      "missing_scope",
      "database unavailable",
    ]);
  });

  it("sends nothing for platforms without a receipt", async () => {
    const messaging = fakeMessaging();
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge("telegram:42", "7", unhandled);
    receipts.acknowledge("mystery:1", "1", unhandled);
    receipts.acknowledge("sendblue:dm-1", "h-1", unhandled);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(messaging.acknowledge.mock.calls.map(([threadId]) => threadId)).toEqual([
      "sendblue:dm-1",
    ]);
  });

  it("starts the send timeout when the delayed reaction goes out", async () => {
    // Fake timers leave AbortSignal.timeout on the real clock, so route it
    // through the fake one to make an already-expired signal observable.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge(SLACK_THREAD, SLACK_HANDLE, unhandled);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(messaging.acknowledge.mock.calls[0]![2].signal.aborted).toBe(false);
  });
});

describe("temporary receipt lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  function temporary() {
    const clear = vi.fn(async () => {});
    return { clear, messaging: { ...fakeMessaging(), acknowledge: vi.fn(async () => clear) } };
  }
  it("removes a receipt once the worker has delivered its reply", async () => {
    const { clear, messaging } = temporary();
    let delivered = false;
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge("sendblue:dm-1", "h-1", async () => delivered);
    await vi.advanceTimersByTimeAsync(0);
    expect(clear).not.toHaveBeenCalled();
    delivered = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(clear).toHaveBeenCalledOnce();
    receipts.stop();
    expect(clear).toHaveBeenCalledOnce();
  });
  it("cleans up when a run has already failed or been cancelled", async () => {
    const { clear, messaging } = temporary();
    createMessagingReceipts(messaging).acknowledge("sendblue:dm-1", "h-1", async () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(clear).toHaveBeenCalledOnce();
  });
  it("expires a receipt for a run that never settles", async () => {
    const { clear, messaging } = temporary();
    createMessagingReceipts(messaging).acknowledge("sendblue:dm-1", "h-1", unhandled);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(clear).toHaveBeenCalledOnce();
  });
  it("cleans up on shutdown, including a create that finishes after shutdown", async () => {
    const clear = vi.fn(async () => {});
    let release = () => {};
    const messaging = {
      ...fakeMessaging(),
      acknowledge: vi.fn(
        () =>
          new Promise<() => Promise<void>>((resolve) => {
            release = () => resolve(clear);
          }),
      ),
    };
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge("sendblue:dm-1", "h-1", unhandled);
    const stopped = receipts.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    expect(clear).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries a failed completion check and logs a failed cleanup", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const { clear, messaging } = temporary();
    clear.mockRejectedValue(new Error("reaction unavailable"));
    const handled = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(true);
    createMessagingReceipts(messaging).acknowledge("sendblue:dm-1", "h-1", handled);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(clear).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries a transient deletion failure without checking delivery again", async () => {
    vi.spyOn(getLogger(), "error");
    const { clear, messaging } = temporary();
    clear.mockRejectedValueOnce(new Error("temporary outage"));
    const handled = vi.fn(async () => true);
    createMessagingReceipts(messaging).acknowledge("sendblue:dm-1", "h-1", handled);
    await vi.advanceTimersByTimeAsync(250);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(handled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires even when the completion query never returns", async () => {
    const { clear, messaging } = temporary();
    let release = (_done: boolean) => {};
    const handled = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    createMessagingReceipts(messaging).acknowledge("sendblue:dm-1", "h-1", handled);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(clear).toHaveBeenCalledOnce();
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(clear).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for an in-flight deletion during shutdown without deleting twice", async () => {
    const { clear, messaging } = temporary();
    let release = () => {};
    clear.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge("sendblue:dm-1", "h-1", async () => true);
    await vi.advanceTimersByTimeAsync(0);
    let finished = false;
    const stopped = receipts.stop().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(clear).toHaveBeenCalledOnce();
    release();
    await stopped;
    expect(finished).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds retries when deletions never settle", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const { clear, messaging } = temporary();
    clear.mockImplementation(() => new Promise<void>(() => {}));
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge("sendblue:dm-1", "h-1", unhandled);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = receipts.stop();
    await vi.advanceTimersByTimeAsync(6_500);
    await stopped;
    expect(clear).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds shutdown when a receipt create never returns", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const messaging = { ...fakeMessaging(), acknowledge: vi.fn(() => new Promise<void>(() => {})) };
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge("sendblue:dm-1", "h-1", unhandled);
    const stopped = receipts.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped;
    expect(error).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
