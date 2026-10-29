import { describe, expect, it, vi } from "vitest";
import { createQueuedSave } from "./queued-save";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Let both the save and its optional device reconciliation finish.
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("queued save", () => {
  it("applies taps immediately and skips a queued value already saved (on/off/on)", async () => {
    const request = deferred();
    const save = vi.fn(() => request.promise);
    const onChange = vi.fn();
    const onSaved = vi.fn(async () => undefined);
    const queue = createQueuedSave<boolean>(false, { save, onChange, onSaved, onError: vi.fn() });

    queue.update(true);
    expect(onChange).toHaveBeenLastCalledWith(true);
    queue.update(false);
    queue.update(true);
    expect(save.mock.calls).toEqual([[true]]);
    expect(onChange).toHaveBeenLastCalledWith(true);

    request.resolve();
    await settle();
    expect(save.mock.calls).toEqual([[true]]);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("serializes requests and sends only the newest queued value", async () => {
    const first = deferred();
    const second = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const queue = createQueuedSave<number>(0, { save, onChange: vi.fn(), onError: vi.fn() });
    queue.update(1);
    queue.update(2);
    queue.update(3);
    expect(save.mock.calls).toEqual([[1]]);

    first.resolve();
    await settle();
    expect(save.mock.calls).toEqual([[1], [3]]);
    second.resolve();
    await settle();
    queue.update(3);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("restores the last successful save when the latest edit fails", async () => {
    const first = deferred();
    const second = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onChange = vi.fn();
    const onError = vi.fn();
    const queue = createQueuedSave<number>(0, { save, onChange, onError });
    queue.update(1);
    queue.update(2);
    first.resolve();
    await settle();
    const error = new Error("offline");
    second.reject(error);
    await settle();
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(save.mock.calls).toEqual([[1], [2]]);
    queue.update(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("saves a waiting edit when onSaved rejects and retains the successful baseline", async () => {
    const reconciliation = deferred();
    const save = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi
      .fn()
      .mockReturnValueOnce(reconciliation.promise)
      .mockResolvedValue(undefined);
    const onChange = vi.fn();
    const onError = vi.fn();
    const onSavingChange = vi.fn();
    const queue = createQueuedSave<number>(0, {
      save,
      onSaved,
      onChange,
      onError,
      onSavingChange,
    });

    queue.update(1);
    await settle();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(1);
    queue.update(2);
    const error = new Error("settings unavailable");
    reconciliation.reject(error);
    await settle();

    expect(save.mock.calls).toEqual([[1], [2]]);
    expect(onSaved.mock.calls).toEqual([[1], [2]]);
    expect(onChange.mock.calls).toEqual([[1], [2]]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onSavingChange.mock.calls).toEqual([[true], [false]]);
    queue.update(2);
    expect(save).toHaveBeenCalledTimes(2);

    save.mockRejectedValueOnce(new Error("offline"));
    queue.update(3);
    await settle();
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it("restores an initial settings object on failure and compares settings by value", async () => {
    const initial = { messages: false, scheduledTasks: true };
    const request = deferred();
    const save = vi.fn(() => request.promise);
    const onChange = vi.fn();
    const queue = createQueuedSave(initial, {
      save,
      onChange,
      onError: vi.fn(),
      equals: (a, b) => a.messages === b.messages && a.scheduledTasks === b.scheduledTasks,
    });
    queue.update({ ...initial });
    expect(save).not.toHaveBeenCalled();
    queue.update({ ...initial, messages: true });
    request.reject(new Error("offline"));
    await settle();
    expect(onChange).toHaveBeenLastCalledWith(initial);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("reports a failed flush until a subsequent edit succeeds", async () => {
    const error = new Error("offline");
    const save = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const queue = createQueuedSave<boolean>(false, { save, onChange: vi.fn(), onError: vi.fn() });
    queue.update(true);
    await expect(queue.flush()).rejects.toBe(error);
    await expect(queue.flush()).rejects.toBe(error);
    queue.update(true);
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(save.mock.calls).toEqual([[true], [true]]);
  });

  it("accepts a new confirmed baseline after a reload", async () => {
    const onChange = vi.fn();
    const queue = createQueuedSave<boolean>(false, {
      save: vi.fn().mockRejectedValue(new Error("offline")),
      onChange,
      onError: vi.fn(),
    });
    queue.reset(true);
    queue.update(false);
    await settle();
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});

it("retains a newer edit after an older failure, then rolls back only the latest failure", async () => {
  const first = deferred();
  const latest = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  const onChange = vi.fn();
  const onError = vi.fn();
  const queue = createQueuedSave<number>(0, { save, onChange, onError });
  queue.update(1);
  queue.update(2);
  first.reject(new Error("older failure"));
  await settle();
  expect(save.mock.calls).toEqual([[1], [2]]);
  expect(onChange).toHaveBeenLastCalledWith(2);
  expect(onError).not.toHaveBeenCalled();
  const error = new Error("latest failure");
  latest.reject(error);
  await expect(queue.flush()).rejects.toBe(error);
  expect(onChange).toHaveBeenLastCalledWith(0);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
});
