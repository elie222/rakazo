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

let roots: Root[] = [];
const clocks: Record<string, ReturnType<typeof useLogoAvatarClock>> = {};
function Clock({ name, running }: { name: string; running: boolean }) {
  clocks[name] = useLogoAvatarClock(running);
  return null;
}
function mount(name: string, running = true) {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(<Clock name={name} running={running} />));
  return root;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(24_000 * 1000 + 1200);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("starts at the shared clock's point in the loop", () => {
  mount("first");
  expect(clocks.first!.value).toBeCloseTo(1200);
  act(() => vi.advanceTimersByTime(300));
  expect(clocks.first!.value).toBeCloseTo(1500);
  // Only the timer that starts the next run is armed: no frame or interval timers.
  expect(vi.getTimerCount()).toBe(1);
});

it("starts a new run from the shared clock when one runs out", () => {
  mount("first");
  act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 700));
  expect(clocks.first!.value % 24_000).toBeCloseTo(1_900);
  expect(clocks.first!.value).toBeLessThan(24 * 60 * 60 * 1000);
});

it("keeps two copies mounted at different times in step", () => {
  mount("first");
  act(() => vi.advanceTimersByTime(7_300));
  mount("second");
  act(() => vi.advanceTimersByTime(500));
  expect(clocks.second!.value % 24_000).toBeCloseTo(clocks.first!.value % 24_000);
  expect(clocks.second!.value % 24_000).toBeCloseTo(9_000);
});

it("catches up with the shared clock after a pause", () => {
  const root = mount("first");
  act(() => root.render(<Clock name="first" running={false} />));
  act(() => vi.advanceTimersByTime(5_000));
  act(() => root.render(<Clock name="first" running />));
  expect(clocks.first!.value).toBeCloseTo(6_200);
});
