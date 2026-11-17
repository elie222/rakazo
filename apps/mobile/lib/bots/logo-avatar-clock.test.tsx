// @vitest-environment jsdom
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLogoAvatarClock } from "./logo-avatar-clock";

vi.mock("react-native-reanimated", () => {
  type Timing = { to: number; duration: number; repeat?: boolean };
  class Shared {
    private current: number | Timing;
    private base = 0;
    private since = 0;
    constructor(value: number) {
      this.current = value;
    }
    get value(): number {
      return typeof this.current === "number"
        ? this.current
        : this.base +
            (this.current.to - this.base) *
              (this.current.repeat
                ? ((performance.now() - this.since) % this.current.duration) / this.current.duration
                : Math.min((performance.now() - this.since) / this.current.duration, 1));
    }
    set value(next: number | Timing) {
      if (typeof next !== "number") {
        this.base = this.value;
        this.since = performance.now();
      }
      this.current = next;
    }
    freeze() {
      this.current = this.value;
    }
  }
  return {
    cancelAnimation: (value: Shared) => value.freeze(),
    Easing: { linear: 0 },
    ReduceMotion: { Never: "never" },
    useSharedValue: (value: number) => useState(() => new Shared(value))[0],
    withRepeat: (value: Timing) => ({ ...value, repeat: true }),
    withTiming: (to: number, options: { duration: number }) => ({ to, duration: options.duration }),
  };
});

let root: Root;
let container: HTMLDivElement;
let clock: ReturnType<typeof useLogoAvatarClock>;
function Clock({ running, activity }: { running: boolean; activity: string }) {
  clock = useLogoAvatarClock(running);
  return <span>{activity}</span>;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps elapsed native phase across activity rerenders and offscreen/reduced-motion pauses", () => {
  act(() => root.render(<Clock running activity="reading" />));
  act(() => vi.advanceTimersByTime(1200));
  expect(clock.value).toBeCloseTo(1200);
  act(() => root.render(<Clock running activity="writing" />));
  act(() => vi.advanceTimersByTime(300));
  expect(clock.value).toBeCloseTo(1500);
  act(() => root.render(<Clock running={false} activity="writing" />));
  act(() => vi.advanceTimersByTime(5000));
  expect(clock.value).toBeCloseTo(1500);
  act(() => root.render(<Clock running activity="computer" />));
  act(() => vi.advanceTimersByTime(400));
  expect(clock.value).toBeCloseTo(1900);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the native clock moving after repeated24-second wraps", () => {
  act(() => root.render(<Clock running activity="reading" />));
  act(() => vi.advanceTimersByTime(49_200));
  expect(clock.value % 24000).toBeCloseTo(1200);
  act(() => root.render(<Clock running={false} activity="reading" />));
  expect(clock.value % 24000).toBeCloseTo(1200);
  act(() => root.render(<Clock running activity="computer" />));
  act(() => vi.advanceTimersByTime(800));
  expect(clock.value % 24000).toBeCloseTo(2000);
  expect(vi.getTimerCount()).toBe(0);
});
