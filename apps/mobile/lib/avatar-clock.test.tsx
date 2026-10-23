// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityMark } from "../components/activity-mark";

/** Every animated style built, newest last, so a test can sample it later. */
const styles = vi.hoisted(() => [] as Array<() => Record<string, unknown>>);
/**
 * Whether code runs as a worklet (on the UI thread), and whether the JS thread sees a
 * running animation move or only the value it last wrote.
 */
const thread = vi.hoisted(() => ({ ui: false, jsSeesFrames: true }));
/** Runs `worklet` the way the UI thread would. */
function onUI<T>(worklet: () => T): T {
  thread.ui = true;
  try {
    return worklet();
  } finally {
    thread.ui = false;
  }
}

// Shared values whose timings run on the (fake) clock, as they would on the UI thread.
vi.mock("react-native-reanimated", () => {
  type Timing = { timing: true; to: number; duration: number };
  class Shared {
    private stored: unknown;
    private from = 0;
    private at = 0;
    constructor(value: unknown) {
      this.stored = value;
    }
    get value(): unknown {
      const stored = this.stored as Timing | undefined;
      if (!stored || typeof stored !== "object" || !("timing" in stored)) return this.stored;
      if (!thread.ui && !thread.jsSeesFrames) return this.from;
      const t = stored.duration > 0 ? Math.min((Date.now() - this.at) / stored.duration, 1) : 1;
      return this.from + (stored.to - this.from) * t;
    }
    set value(next: unknown) {
      if (next && typeof next === "object" && "timing" in next) {
        this.from = onUI(() => this.value as number);
        this.at = Date.now();
      }
      this.stored = next;
    }
    freeze() {
      this.stored = this.value;
    }
  }
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  const easing = (value: unknown) => value;
  const fade = { duration: () => ({}) };
  return {
    default: { View: passthrough, createAnimatedComponent: () => passthrough },
    cancelAnimation: (value: Shared) => onUI(() => value.freeze()),
    Easing: { in: easing, out: easing, inOut: easing, quad: 0, cubic: 0, linear: 0 },
    FadeIn: fade,
    FadeOut: fade,
    ReduceMotion: { Never: "never" },
    useAnimatedProps: (worklet: () => unknown) => onUI(worklet),
    useAnimatedStyle: (worklet: () => Record<string, unknown>) => {
      styles.push(worklet);
      return onUI(worklet);
    },
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => useState(() => new Shared(value))[0],
    withSpring: (value: unknown) => value,
    withTiming: (to: number, config?: { duration?: number }) => ({
      timing: true,
      to,
      duration: config?.duration ?? 300,
    }),
  };
});
vi.mock("react-native-svg", () => {
  const element = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return { default: element, Ellipse: element, G: element, Path: element, Rect: element };
});
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, children),
  Image: () => null,
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ mutedForeground: "#888", background: "#FFF", workingDot: "#3FA266" }),
}));

const bot = { id: "bot-1", color: "#2A92FE::shape_2", status: "running" };

/** The body transform, as rotate and translateY, of the avatar whose styles are `range`. */
function body([from, to]: readonly [number, number]) {
  for (const style of styles.slice(from, to).reverse()) {
    const transform = onUI(style).transform as Array<Record<string, unknown>> | undefined;
    if (!transform?.some((step) => "rotate" in step)) continue;
    const rotate = Number.parseFloat(String(transform.find((step) => "rotate" in step)?.rotate));
    const translateY = Number(transform.find((step) => "translateY" in step)?.translateY);
    return { rotate, translateY };
  }
  throw new Error("no body style");
}

describe("the activity mark's clock", () => {
  const roots: Root[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    styles.length = 0;
  });
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const mount = () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    const from = styles.length;
    act(() => root.render(<ActivityMark bots={[bot]} atBottom />));
    return { container, styles: [from, styles.length] as const };
  };

  it.each([
    ["sees running animations move", true],
    ["only sees what it last wrote", false],
  ])(
    "plays a reaction a moment later, on top of the working motion, when the JS thread %s",
    (_, jsSeesFrames) => {
      thread.jsSeesFrames = jsSeesFrames;
      // Two marks started together play the same clips; only one is tapped.
      const still = mount();
      const tapped = mount();
      act(() => vi.advanceTimersByTime(1000));
      act(() => tapped.container.querySelector("button")?.click());
      act(() => vi.advanceTimersByTime(200));
      expect(Math.abs(body(tapped.styles).rotate - body(still.styles).rotate)).toBeGreaterThan(20);
      act(() => vi.advanceTimersByTime(1000));
      expect(body(tapped.styles).rotate).toBeCloseTo(body(still.styles).rotate);
    },
  );

  it.each([
    ["sees running animations move", true],
    ["only sees what it last wrote", false],
  ])("keeps playing clips across timeline rebuilds when the JS thread %s", (_, jsSeesFrames) => {
    thread.jsSeesFrames = jsSeesFrames;
    const mark = mount();
    // Long enough for the timeline to be rebuilt more than once.
    act(() => vi.advanceTimersByTime(400_000));
    const poses = new Set<string>();
    for (let step = 0; step < 50; step += 1) {
      act(() => vi.advanceTimersByTime(100));
      const { rotate, translateY } = body(mark.styles);
      poses.add(`${rotate.toFixed(2)} ${translateY.toFixed(4)}`);
    }
    expect(poses.size).toBeGreaterThan(5);
  });
});
