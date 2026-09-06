import type { ComputerStatus } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComputerRefresh } from "./computer-refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const running = { state: "running" } as ComputerStatus;
const stopped = { state: "stopped" } as ComputerStatus;
function setup() {
  const options = {
    readStatus: vi.fn<() => Promise<ComputerStatus>>().mockResolvedValue(running),
    readScreen: vi
      .fn<(attempts: number) => Promise<string | null>>()
      .mockResolvedValue("https://screen.example.test"),
    onStatus: vi.fn(),
    onScreen: vi.fn(),
    onReady: vi.fn(),
    onInitialError: vi.fn(),
  };
  return { ...options, controller: createComputerRefresh(options) };
}

afterEach(() => vi.useRealTimers());
describe("computer refresh lifecycle", () => {
  it("waits for a slow refresh to finish before scheduling the next poll", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const pending = deferred<ComputerStatus>();
    fixture.readStatus.mockReturnValueOnce(pending.promise);
    fixture.controller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.readStatus).toHaveBeenCalledTimes(1);
    pending.resolve(running);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fixture.readStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.readStatus).toHaveBeenCalledTimes(2);
    fixture.controller.dispose();
  });

  it("lets an explicit refresh supersede an older screen read and retain its retry count", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const oldScreen = deferred<string | null>();
    fixture.readScreen.mockReturnValueOnce(oldScreen.promise);
    fixture.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    fixture.readStatus.mockResolvedValue(stopped);
    fixture.readScreen.mockResolvedValue(null);
    await fixture.controller.refresh({ screenAttempts: 5 });
    oldScreen.resolve("https://old-screen.example.test");
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.onStatus).toHaveBeenLastCalledWith(stopped);
    expect(fixture.onScreen).toHaveBeenCalledExactlyOnceWith(null);
    expect(fixture.readScreen).toHaveBeenLastCalledWith(5);
    fixture.controller.dispose();
  });

  it("ignores an old target's response after disposal and starts the new target independently", async () => {
    vi.useFakeTimers();
    const old = setup();
    const pending = deferred<ComputerStatus>();
    old.readStatus.mockReturnValue(pending.promise);
    old.controller.start();
    old.controller.dispose();
    const current = setup();
    current.controller.start();
    pending.resolve(stopped);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.onStatus).not.toHaveBeenCalled();
    expect(old.onReady).not.toHaveBeenCalled();
    expect(current.onStatus).toHaveBeenCalledWith(running);
    current.controller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(old.readStatus).toHaveBeenCalledTimes(1);
    expect(current.readStatus).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending screen response after unmount, including strict-mode restart", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const pending = deferred<string | null>();
    fixture.readScreen.mockReturnValueOnce(pending.promise);
    fixture.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    fixture.controller.dispose();
    fixture.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve("https://old-screen.example.test");
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.onScreen).toHaveBeenCalledExactlyOnceWith("https://screen.example.test");
    fixture.controller.dispose();
  });

  it("keeps the URL on screen failures, clears it on null, and recovers from status failures", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const error = new Error("status failed");
    fixture.readStatus.mockRejectedValueOnce(error);
    fixture.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.onInitialError).toHaveBeenCalledWith(error);
    expect(fixture.onReady).toHaveBeenCalledTimes(1);
    fixture.readScreen.mockRejectedValueOnce(new Error("screen failed"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.onScreen).not.toHaveBeenCalled();
    expect(fixture.onReady).toHaveBeenCalledTimes(2);
    fixture.readScreen.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.onScreen).toHaveBeenCalledWith(null);
    fixture.controller.dispose();
  });
});
