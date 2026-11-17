import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererRecovery } from "./renderer-recovery.js";

const mocks = vi.hoisted(() => ({ showMessageBox: vi.fn(), reportDesktopError: vi.fn() }));
vi.mock("electron", () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));
vi.mock("./i18n.js", () => ({ t: (message: string) => message }));
vi.mock("./monitoring.js", () => ({ reportDesktopError: mocks.reportDesktopError }));

function windowFixture() {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    reload: vi.fn(),
  });
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    webContents: contents,
  });
  const quitting = vi.fn(() => false);
  installRendererRecovery(win as unknown as BrowserWindow, quitting);
  const gone = (reason = "oom") => contents.emit("render-process-gone", {}, { reason });
  return { win, contents, quitting, gone };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.showMessageBox.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => vi.useRealTimers());

describe("renderer recovery", () => {
  it.each(["oom", "crashed", "killed", "abnormal-exit", "launch-failed", "clean-exit"])(
    "recovers a renderer that is gone (%s)",
    async (reason) => {
      const { contents, gone } = windowFixture();
      gone(reason);
      await vi.advanceTimersByTimeAsync(999);
      expect(contents.reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(contents.reload).toHaveBeenCalledOnce();
    },
  );

  it("backs off, then stops automatic reloads even after successful loads and long intervals", async () => {
    const { win, contents, gone } = windowFixture();
    gone();
    gone(); // Duplicate events must not schedule another reload.
    await vi.advanceTimersByTimeAsync(1_000);
    contents.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    gone();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(contents.reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(contents.reload).toHaveBeenCalledTimes(2);
    gone();
    gone();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(contents.reload).toHaveBeenCalledTimes(2);
    expect(mocks.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      win,
      expect.objectContaining({ message: "Rakazo stopped unexpectedly.", buttons: ["Reload"] }),
    );
  });

  it("allows a manual reload without granting another automatic retry budget", async () => {
    const { contents, gone } = windowFixture();
    gone();
    await vi.advanceTimersByTimeAsync(1_000);
    gone();
    await vi.advanceTimersByTimeAsync(5_000);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    gone();
    await vi.advanceTimersByTimeAsync(0);
    expect(contents.reload).toHaveBeenCalledTimes(3);
    gone();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it.each(["quit", "window", "contents"])("does not reload after %s", async (stop) => {
    const { win, contents, quitting, gone } = windowFixture();
    gone();
    if (stop === "quit") quitting.mockReturnValue(true);
    if (stop === "window") win.isDestroyed.mockReturnValue(true);
    if (stop === "contents") contents.isDestroyed.mockReturnValue(true);
    await vi.runAllTimersAsync();
    gone();
    expect(contents.reload).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("cancels pending recovery and removes the crash listener when the window closes", async () => {
    const { win, contents, gone } = windowFixture();
    gone();
    win.emit("closed");
    expect(contents.listenerCount("render-process-gone")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it("ignores a dialog answer after quitting", async () => {
    const { contents, quitting, gone } = windowFixture();
    gone();
    await vi.advanceTimersByTimeAsync(1_000);
    gone();
    await vi.advanceTimersByTimeAsync(5_000);
    let answer: (result: { response: number }) => void = () => {};
    mocks.showMessageBox.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    gone();
    quitting.mockReturnValue(true);
    answer({ response: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(contents.reload).toHaveBeenCalledTimes(2);
  });
});
