import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createBadgeHandler } from "./badge.js";

function setup(result = true) {
  const frame = { url: "https://app.example.com/app/bot" };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
  }) as unknown as WebContents;
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
  const target = { webContents: contents, url: "https://app.example.com" };
  const setBadgeCount = vi.fn(() => result);
  return { event, target, setBadgeCount, handle: createBadgeHandler(() => target, setBadgeCount) };
}

describe("desktop badge handler", () => {
  it("sets and clears the badge, clamping large integers", () => {
    const { event, handle, setBadgeCount } = setup();
    for (const count of [3, 0, 9999, 10000, Number.MAX_VALUE])
      expect(handle(event, count)).toBe(true);
    expect(setBadgeCount.mock.calls).toEqual([[3], [0], [9999], [9999], [9999]]);
  });

  it.each([-1, 1.5, NaN, Infinity, -Infinity, "3", null, undefined, {}, true])(
    "clears invalid input %s",
    (count) => {
      const { event, handle, setBadgeCount } = setup();
      expect(handle(event, count)).toBe(true);
      expect(setBadgeCount).toHaveBeenCalledWith(0);
    },
  );

  it("rejects other windows, subframes, unexpected origins and destroyed targets", () => {
    const { event, target, handle, setBadgeCount } = setup();
    expect(handle({ ...event, sender: {} as WebContents }, 4)).toBe(false);
    expect(handle({ ...event, senderFrame: null }, 4)).toBe(false);
    expect(
      handle(
        { ...event, senderFrame: { url: target.url } as IpcMainInvokeEvent["senderFrame"] },
        4,
      ),
    ).toBe(false);
    const frame = event.senderFrame!;
    for (const url of ["https://other.example.com", "invalid", "file:///app.html"]) {
      Object.assign(frame, { url });
      expect(handle(event, 4)).toBe(false);
    }
    Object.assign(frame, { url: target.url });
    target.webContents.isDestroyed = () => true;
    expect(handle(event, 4)).toBe(false);
    expect(createBadgeHandler(() => null, setBadgeCount)(event, 4)).toBe(false);
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it("returns false when the platform does not support badges or throws", () => {
    const { event, handle, target, setBadgeCount } = setup(false);
    expect(handle(event, 2)).toBe(false);
    expect(setBadgeCount).toHaveBeenCalledWith(2);
    expect(
      createBadgeHandler(
        () => target,
        () => {
          throw new Error("Unsupported");
        },
      )(event, 2),
    ).toBe(false);
  });

  it("clears the count when the window that set it is destroyed, but not after a replacement", () => {
    const { event, target, handle, setBadgeCount } = setup();
    expect(handle(event, 5)).toBe(true);
    (event.sender as unknown as EventEmitter).emit("destroyed");
    expect(setBadgeCount.mock.calls).toEqual([[5], [0]]);

    expect(handle(event, 2)).toBe(true);
    const frame = { url: "https://app.example.com/app" };
    const next = Object.assign(new EventEmitter(), {
      mainFrame: frame,
      isDestroyed: () => false,
    }) as unknown as WebContents;
    target.webContents = next;
    expect(handle({ sender: next, senderFrame: frame } as IpcMainInvokeEvent, 4)).toBe(true);
    (event.sender as unknown as EventEmitter).emit("destroyed");
    expect(setBadgeCount.mock.calls).toEqual([[5], [0], [2], [4]]);
  });
});
