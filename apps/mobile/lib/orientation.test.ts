import { beforeEach, describe, expect, it, vi } from "vitest";

const screen = vi.hoisted(() => ({
  window: { width: 411, height: 914 },
  locks: [] as number[],
}));

vi.mock("expo-screen-orientation", () => ({
  OrientationLock: { DEFAULT: 0, PORTRAIT_UP: 1 },
  lockAsync: (lock: number) => {
    screen.locks.push(lock);
    return Promise.resolve();
  },
}));

vi.mock("react-native", () => ({
  Dimensions: { get: () => screen.window },
}));

const { appOrientationLock, holdFreeRotation, syncOrientation } = await import("./orientation");

const FOLDED = { width: 411, height: 914 };
const UNFOLDED = { width: 744, height: 840 };

describe("app orientation", () => {
  beforeEach(() => {
    screen.window = FOLDED;
    screen.locks = [];
  });

  it("keeps a phone-sized window portrait and frees an unfolded one", () => {
    expect(appOrientationLock(FOLDED, false)).toBe(1);
    expect(appOrientationLock(UNFOLDED, false)).toBe(0);
    expect(appOrientationLock(FOLDED, true)).toBe(0);
  });

  it("follows a fold or unfold", async () => {
    await syncOrientation();
    screen.window = UNFOLDED;
    await syncOrientation();
    expect(screen.locks).toEqual([1, 0]);
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
