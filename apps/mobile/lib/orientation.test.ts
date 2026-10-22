import { Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

const screen = vi.hoisted(() => ({
  window: { width: 411, height: 914 },
  size: { width: 411, height: 914 },
  locks: [] as number[],
  lockAsync: vi.fn<(lock: number) => Promise<void>>(),
}));

vi.mock("expo-screen-orientation", () => ({
  OrientationLock: { DEFAULT: 0, PORTRAIT_UP: 1 },
  lockAsync: (lock: number) => {
    screen.locks.push(lock);
    return screen.lockAsync(lock);
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Dimensions: { get: (kind: string) => (kind === "screen" ? screen.size : screen.window) },
}));

const { appOrientationLock, holdFreeRotation, syncOrientation } = await import("./orientation");

const FOLDED = { width: 411, height: 914 };
const UNFOLDED = { width: 744, height: 840 };

function deferredLock() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolveLock, rejectLock) => {
    resolve = resolveLock;
    reject = rejectLock;
  });
  return { promise, resolve, reject };
}

describe("app orientation", () => {
  beforeEach(() => {
    Platform.OS = "ios";
    screen.window = FOLDED;
    screen.size = FOLDED;
    screen.locks = [];
    screen.lockAsync.mockReset().mockResolvedValue(undefined);
  });

  it("keeps a phone-sized screen portrait and frees an unfolded one", () => {
    expect(appOrientationLock(FOLDED, false)).toBe(1);
    expect(appOrientationLock(UNFOLDED, false)).toBe(0);
    expect(appOrientationLock(FOLDED, true)).toBe(0);
  });

  it.each([
    { width: 393, height: 852 },
    { width: 430, height: 932 },
    { width: 375, height: 667 },
    { width: 852, height: 393 },
    { width: 932, height: 430 },
    { width: 667, height: 375 },
  ])("keeps a narrow phone window $width x $height portrait", (window) => {
    expect(appOrientationLock(window, false)).toBe(1);
    expect(appOrientationLock(window, true)).toBe(0);
  });

  it.each([
    { width: 466, height: 678 },
    { width: 678, height: 466 },
    { width: 669, height: 951 },
    { width: 951, height: 669 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 300, height: 500 },
    { width: 500, height: 300 },
  ])("leaves a wider window $width x $height free to rotate", (window) => {
    expect(appOrientationLock(window, false)).toBe(0);
    expect(appOrientationLock(window, true)).toBe(0);
  });

  it("follows a fold or unfold", async () => {
    await syncOrientation();
    screen.window = UNFOLDED;
    screen.size = UNFOLDED;
    await syncOrientation();
    expect(screen.locks).toEqual([1, 0]);
  });

  it.each([599, 600, 601])(
    "uses the %i dp screen despite system bars and split-screen",
    async (shortSide) => {
      Platform.OS = "android";
      screen.size = { width: shortSide, height: 1040 };
      screen.window = { width: shortSide, height: 992 };
      await syncOrientation();
      screen.size = { width: 1040, height: shortSide };
      screen.window = { width: 1040, height: shortSide - 48 };
      await syncOrientation();
      screen.window = { width: 400, height: shortSide - 48 };
      await syncOrientation();
      const expected = shortSide < 600 ? 1 : 0;
      expect(screen.locks).toEqual([expected, expected, expected]);
    },
  );

  it("waits for an in-flight unlock before relocking after a viewer releases", async () => {
    const unlock = deferredLock();
    screen.lockAsync.mockReturnValueOnce(unlock.promise);
    const release = holdFreeRotation();
    // Let the queued unlock start, but keep its native promise pending.
    await Promise.resolve();
    expect(screen.locks).toEqual([0]);
    release();
    const settled = syncOrientation();
    await Promise.resolve();
    expect(screen.locks).toEqual([0]);
    unlock.resolve();
    await settled;
    expect(screen.locks).toEqual([0, 1, 1]);
  });

  it("runs the next queued lock after a native lock rejects", async () => {
    const unlock = deferredLock();
    screen.lockAsync.mockReturnValueOnce(unlock.promise);
    const release = holdFreeRotation();
    await Promise.resolve();
    release();
    const settled = syncOrientation();
    expect(screen.locks).toEqual([0]);
    unlock.reject(new Error("Lock unavailable"));
    await settled;
    expect(screen.locks).toEqual([0, 1, 1]);
  });

  it("relocks portrait only after every overlapping viewer has closed", async () => {
    const releaseFirst = holdFreeRotation();
    const releaseSecond = holdFreeRotation();
    releaseFirst();
    releaseFirst();
    await syncOrientation();
    expect(screen.locks.at(-1)).toBe(0);
    releaseSecond();
    await syncOrientation();
    expect(screen.locks.at(-1)).toBe(1);
  });

  it.each([
    { width: 466, height: 678, expected: 0 },
    { width: 678, height: 466, expected: 0 },
    { width: 669, height: 951, expected: 0 },
    { width: 951, height: 669, expected: 0 },
    { width: 402, height: 874, expected: 1 },
  ])(
    "uses the live iOS window $width x $height instead of the physical screen",
    async ({ width, height, expected }) => {
      screen.size = FOLDED;
      screen.window = { width, height };
      await syncOrientation();
      expect(screen.locks.at(-1)).toBe(expected);
    },
  );
});
