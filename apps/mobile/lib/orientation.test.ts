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
      screen.size = { width: shortSide, height: 960 };
      screen.window = { width: shortSide, height: 912 };
      await syncOrientation();
      screen.size = { width: 960, height: shortSide };
      screen.window = { width: 960, height: shortSide - 48 };
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
});
