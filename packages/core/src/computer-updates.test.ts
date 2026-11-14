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

function pending() {
  let resolve!: (rows: ComputerUpdate[]) => void;
  const list = vi.fn(
    () =>
      new Promise<ComputerUpdate[]>((done) => {
        resolve = done;
      }),
  );
  return { list, resolve: (rows: ComputerUpdate[]) => resolve(rows) };
}

function store(list: () => Promise<ComputerUpdate[]>) {
  return createComputerUpdates({ list, start: async () => update, dismiss: async () => {} });
}

describe("computer update presentation", () => {
  it("keeps a newly started update when an older poll returns, and closing does not stop polling", async () => {
    vi.useFakeTimers();
    const reads = pending();
    const updates = store(reads.list);
    const stop = updates.watch();
    await updates.start("bot-1");
    reads.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.getSnapshot()).toEqual({ updates: [update], openId: update.id });
    updates.open(null);
    await vi.advanceTimersByTimeAsync(1500);
    reads.resolve([{ ...update, stage: "restoring" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.getSnapshot()).toEqual({
      updates: [{ ...update, stage: "restoring" }],
      openId: null,
    });
    stop();
  });
  it("restores background progress on a new mount and ignores responses after disposal", async () => {
    vi.useFakeTimers();
    const updates = store(async () => [update]);
    let stop = updates.watch();
    await Promise.resolve();
    expect(updates.getSnapshot().updates).toEqual([update]);
    stop();
    stop = updates.watch();
    stop();
    await Promise.resolve();
    expect(updates.getSnapshot().updates).toEqual([]);
  });
  it("with live signals, reads on each signal and only rarely on a timer", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => []);
    const updates = store(list);
    const stop = updates.watch();
    updates.signalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(3);
    list.mockClear();
    list.mockResolvedValue([{ ...update, stage: "restoring" }]);
    updates.signalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.getSnapshot().updates).toEqual([{ ...update, stage: "restoring" }]);
    // Progress arrives as signals; a lost one is caught up slowly, never at the polling pace.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
    stop();
  });
  it("turns signals that arrive during a read into one more read", async () => {
    vi.useFakeTimers();
    const reads = pending();
    const updates = store(reads.list);
    const stop = updates.watch();
    updates.signalled();
    updates.signalled();
    expect(reads.list).toHaveBeenCalledTimes(1);
    reads.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.list).toHaveBeenCalledTimes(2);
    reads.resolve([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.list).toHaveBeenCalledTimes(2);
    stop();
  });
  it("polls again once the live stream closes", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => []);
    const updates = store(list);
    const stop = updates.watch();
    updates.signalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(2);
    updates.signalsLost();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
  it("starts over for a newly selected Space and drops the old Space's late answers", async () => {
    vi.useFakeTimers();
    const answers: ((rows: ComputerUpdate[]) => void)[] = [];
    const list = vi.fn(
      () =>
        new Promise<ComputerUpdate[]>((done) => {
          answers.push(done);
        }),
    );
    let spaceChanged!: () => void;
    const unsubscribe = vi.fn();
    const updates = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      onSpaceChange: (listener) => {
        spaceChanged = listener;
        return unsubscribe;
      },
    });
    const stop = updates.watch();
    updates.signalled();
    answers[0]?.([{ ...update, status: "failed" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.getSnapshot().updates).toHaveLength(1);
    spaceChanged();
    expect(updates.getSnapshot().updates).toEqual([]);
    // The old Space's read lands late and is dropped; the new Space is read after it.
    answers[1]?.([{ ...update, status: "failed" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.getSnapshot().updates).toEqual([]);
    answers[2]?.([update]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.getSnapshot().updates).toEqual([update]);
    // Polled until the live stream signals for the new Space.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(list).toHaveBeenCalledTimes(4);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("without signals, polls quickly only while an update is in progress", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => [{ ...update, status: "failed" }]);
    const stop = store(list).watch();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValue([update]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
  it("stops reading on a 401, even when signalled, and resumes on the next watch", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    });
    const updates = store(list);
    let stop = updates.watch();
    await vi.advanceTimersByTimeAsync(0);
    updates.signalled();
    updates.signalsLost();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(1);
    stop();
    list.mockResolvedValue([]);
    stop = updates.watch();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
  it("asks no more after a refusal, even when signalled during the refused read", async () => {
    vi.useFakeTimers();
    let reject!: (error: unknown) => void;
    const list = vi.fn(
      () =>
        new Promise<ComputerUpdate[]>((_, fail) => {
          reject = fail;
        }),
    );
    const updates = store(list);
    const stop = updates.watch();
    updates.signalled();
    reject(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(1);
    stop();
  });
  it("lets signals wait out a failed read's Retry-After", async () => {
    vi.useFakeTimers();
    let reject!: (error: unknown) => void;
    const list = vi.fn(
      () =>
        new Promise<ComputerUpdate[]>((_, fail) => {
          reject = fail;
        }),
    );
    const updates = store(list);
    const stop = updates.watch();
    updates.signalled();
    reject(Object.assign(new Error("Busy"), { status: 429, retryAfterMs: 20_000 }));
    await vi.advanceTimersByTimeAsync(0);
    updates.signalled();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
    stop();
  });
  it("stops polling when the server refuses this build", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => {
      throw Object.assign(new Error("Update required"), { status: 426 });
    });
    const stop = store(list).watch();
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
    const stop = store(list).watch();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
});
