import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncAvatarAnimations } from "./sync-avatar-animations.js";

function fakeAnimation(playState: AnimationPlayState, iterations: number) {
  return {
    playState,
    startTime: null as number | null,
    currentTime: null as number | null,
    effect: { getTiming: () => ({ iterations }) },
  };
}

function elementWith(animations: ReturnType<typeof fakeAnimation>[]) {
  return { getAnimations: () => animations } as unknown as Element;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance"], now: 1_800_000_000_000 });
  vi.advanceTimersByTime(5_000);
});

afterEach(() => {
  vi.useRealTimers();
});

it("starts running loops at the shared clock", () => {
  const loop = fakeAnimation("running", Number.POSITIVE_INFINITY);
  syncAvatarAnimations(elementWith([loop]));
  // Its current time, the timeline's time less its start, is the shared clock.
  expect(5_000 - loop.startTime!).toBe(1_800_000_005_000);
  expect(loop.currentTime).toBeNull();
});

it("moves paused loops without starting them", () => {
  const loop = fakeAnimation("paused", Number.POSITIVE_INFINITY);
  syncAvatarAnimations(elementWith([loop]));
  expect(loop.currentTime).toBe(1_800_000_005_000);
  expect(loop.startTime).toBeNull();
});

it("leaves one-off fades alone", () => {
  const fade = fakeAnimation("running", 1);
  syncAvatarAnimations(elementWith([fade]));
  expect(fade.startTime).toBeNull();
  expect(fade.currentTime).toBeNull();
});

it("shifts one bot's loops by its offset", () => {
  const loop = fakeAnimation("paused", Number.POSITIVE_INFINITY);
  syncAvatarAnimations(elementWith([loop]), 1_234);
  expect(loop.currentTime).toBe(1_800_000_006_234);
});
