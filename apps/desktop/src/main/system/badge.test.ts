import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createBadgeHandler } from "./badge.js";

function setup(result = true) {
  const event = { sender: new EventEmitter() as unknown as WebContents };
  const setBadgeCount = vi.fn(() => result);
  return { event, setBadgeCount, handle: createBadgeHandler(setBadgeCount) };
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

  it("returns false when the platform does not support badges or throws", () => {
    const { event, handle, setBadgeCount } = setup(false);
    expect(handle(event, 2)).toBe(false);
    expect(setBadgeCount).toHaveBeenCalledWith(2);
    expect(
      createBadgeHandler(() => {
        throw new Error("Unsupported");
      })(event, 2),
    ).toBe(false);
  });

  it("clears the count when the window that set it is destroyed, but not after a replacement", () => {
    const { event, handle, setBadgeCount } = setup();
    expect(handle(event, 5)).toBe(true);
    (event.sender as unknown as EventEmitter).emit("destroyed");
    expect(setBadgeCount.mock.calls).toEqual([[5], [0]]);

    expect(handle(event, 2)).toBe(true);
    const next = new EventEmitter() as unknown as WebContents;
    expect(handle({ sender: next }, 4)).toBe(true);
    (event.sender as unknown as EventEmitter).emit("destroyed");
    expect(setBadgeCount.mock.calls).toEqual([[5], [0], [2], [4]]);
  });
});
