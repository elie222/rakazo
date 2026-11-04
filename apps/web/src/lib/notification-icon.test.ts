import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationIcon } from "./notification-icon.js";

let loads: string[];
let failLoad: boolean;
let context: { drawImage: ReturnType<typeof vi.fn> } | null;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    loads.push(value);
    queueMicrotask(() => (failLoad ? this.onerror?.() : this.onload?.()));
  }
}

beforeEach(() => {
  loads = [];
  failLoad = false;
  context = { drawImage: vi.fn() };
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: (type: string) => `data:${type};base64,cG5n`,
    }),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("notificationIcon", () => {
  it("rasterizes a drawn avatar to a 96px PNG once per avatar value", async () => {
    const bot = { id: "drawn", color: "#3366ff" };
    expect(await notificationIcon(bot)).toBe("data:image/png;base64,cG5n");
    expect(await notificationIcon(bot)).toBe("data:image/png;base64,cG5n");
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatch(/^data:image\/svg\+xml,/);
    expect(context?.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, 96, 96);

    await notificationIcon({ ...bot, avatarSet: "rakazo" });
    expect(loads).toHaveLength(2);
  });

  it("passes an uploaded photo through", async () => {
    const color = "data:image/png;base64,cGhvdG8=";
    expect(await notificationIcon({ id: "photo", color })).toBe(color);
    expect(loads).toHaveLength(0);
  });

  it("falls back to the browser default when rasterizing fails", async () => {
    failLoad = true;
    expect(await notificationIcon({ id: "broken-load", color: "#3366ff" })).toBeUndefined();
    failLoad = false;
    context = null;
    expect(await notificationIcon({ id: "no-canvas", color: "#3366ff" })).toBeUndefined();
  });
});
