import type { ComputerUpdate } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComputerUpdates } from "./computer-updates.js";

const update: ComputerUpdate = {
  id: "update-1",
  botId: "bot-1",
  name: "Writer",
  mode: "team",
  action: "update",
  status: "running",
  stage: "saving",
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A server whose change stream stays open until the test ends it. */
function liveSignals() {
  const streams: { signal: () => void; end: (error?: unknown) => void }[] = [];
  const follow = vi.fn(
    (onSignal: () => void, abort: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        abort.addEventListener("abort", () => reject(new Error("aborted")));
        streams.push({
          signal: onSignal,
          end: (error) => (error === undefined ? resolve() : reject(error)),
        });
      }),
  );
  const latest = () => {
    const stream = streams[streams.length - 1];
    if (!stream) throw new Error("No stream is open");
    return stream;
  };
  return { follow, latest };
}

/** An older server without the change stream. */
const noSignals = async () => {
  throw Object.assign(new Error("Not found"), { status: 404 });
};

describe("computer update presentation", () => {
  it("keeps a newly started update when an older read returns, and closing does not stop reading", async () => {
    vi.useFakeTimers();
    let resolve!: (rows: ComputerUpdate[]) => void;
    const list = vi.fn(
      () =>
        new Promise<ComputerUpdate[]>((done) => {
          resolve = done;
        }),
    );
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      follow: noSignals,
    });
    const stop = store.watch();
    await store.start("bot-1");
    resolve([]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({ updates: [update], openId: update.id });
    store.open(null);
    await vi.advanceTimersByTimeAsync(1500);
    resolve([{ ...update, stage: "restoring" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toEqual({
      updates: [{ ...update, stage: "restoring" }],
      openId: null,
    });
    stop();
  });
  it("restores background progress on a new mount and ignores responses after disposal", async () => {
    vi.useFakeTimers();
    const { follow } = liveSignals();
    const store = createComputerUpdates({
      list: async () => [update],
      start: async () => update,
      dismiss: async () => {},
      follow,
    });
    let stop = store.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().updates).toEqual([update]);
    stop();
    stop = store.watch();
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().updates).toEqual([]);
  });
  it("reads when the server signals a change, not on a timer", async () => {
    vi.useFakeTimers();
    const signals = liveSignals();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => []);
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      follow: signals.follow,
    });
    const stop = store.watch();
    signals.latest().signal();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(list).toHaveBeenCalledTimes(2);
    list.mockResolvedValue([{ ...update, stage: "restoring" }]);
    signals.latest().signal();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().updates).toEqual([{ ...update, stage: "restoring" }]);
    // Progress arrives as signals; a lost one is caught up slowly, never at the polling pace.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(4);
    stop();
  });
  it("turns signals that arrive during a read into one more read", async () => {
    vi.useFakeTimers();
    const signals = liveSignals();
    let resolve!: (rows: ComputerUpdate[]) => void;
    const list = vi.fn(
      () =>
        new Promise<ComputerUpdate[]>((done) => {
          resolve = done;
        }),
    );
    const stop = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      follow: signals.follow,
    }).watch();
    signals.latest().signal();
    signals.latest().signal();
    signals.latest().signal();
    expect(list).toHaveBeenCalledTimes(1);
    resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    resolve([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(2);
    stop();
  });
  it("polls while the stream is down and reads again when it reopens", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const signals = liveSignals();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => []);
    const stop = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      follow: signals.follow,
    }).watch();
    signals.latest().signal();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    const dropped = signals.latest();
    dropped.end(new Error("network"));
    await vi.advanceTimersByTimeAsync(0);
    expect(signals.follow).toHaveBeenCalledTimes(2);
    expect(signals.latest()).not.toBe(dropped);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(list).toHaveBeenCalledTimes(3);
    signals.latest().signal();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(4);
    stop();
  });
  it("reopens the stream for a newly selected Space", async () => {
    vi.useFakeTimers();
    const signals = liveSignals();
    let spaceChanged!: () => void;
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => []);
    const unsubscribe = vi.fn();
    const stop = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      follow: signals.follow,
      onSpaceChange: (listener) => {
        spaceChanged = listener;
        return unsubscribe;
      },
    }).watch();
    signals.latest().signal();
    await vi.advanceTimersByTimeAsync(0);
    spaceChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals.follow).toHaveBeenCalledTimes(2);
    signals.latest().signal();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("without signals, polls quickly only while an update is in progress", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => [{ ...update, status: "failed" }]);
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      follow: noSignals,
    });
    const stop = store.watch();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValue([update]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
  it("stops reading on a 401 and resumes on the next watch", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    });
    const follow = vi.fn(async () => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    });
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      follow,
    });
    let stop = store.watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(1);
    expect(follow).toHaveBeenCalledTimes(1);
    stop();
    list.mockResolvedValue([]);
    stop = store.watch();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
  it("stops reading when the server refuses this build", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => {
      throw Object.assign(new Error("Update required"), { status: 426 });
    });
    const stop = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      follow: noSignals,
    }).watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(1);
    stop();
  });
  it("keeps polling through other failures", async () => {
    vi.useFakeTimers();
    // Failure retries wait between half and all of the backoff; pin the full wait.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => {
      throw Object.assign(new Error("Unavailable"), { status: 503 });
    });
    const stop = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      follow: noSignals,
    }).watch();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
});
