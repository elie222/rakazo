// @vitest-environment jsdom

import { act, createElement, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEYBOARD_SETTLE_MS, useThreadKeyboard } from "./thread-keyboard";

type Handler = (event: { progress: number; height: number }) => void;

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler | undefined>,
  input: { value: null as object | null },
  reaction: null as null | (() => void),
}));

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { isVisible: () => false },
  useKeyboardHandler: (handlers: Record<string, Handler>) => {
    mocks.handlers = handlers;
  },
  useReanimatedFocusedInput: () => ({ input: mocks.input }),
}));

vi.mock("react-native-reanimated", () => ({
  useSharedValue: <T,>(value: T) => useRef({ value }).current,
  useAnimatedReaction: <T,>(prepare: () => T, react: (current: T, previous: T | null) => void) => {
    const previous = useRef<T | null>(null);
    mocks.reaction = () => {
      const current = prepare();
      react(current, previous.current);
      previous.current = current;
    };
  },
}));

vi.mock("react-native-worklets", () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

let root: Root;
let keyboard: ReturnType<typeof useThreadKeyboard>;

function Probe() {
  keyboard = useThreadKeyboard();
  return null;
}

function focus(focused: boolean) {
  mocks.input.value = focused ? { target: 1 } : null;
  act(() => mocks.reaction?.());
}

function keyboardEnd(progress: number) {
  act(() => mocks.handlers.onEnd?.({ progress, height: progress * 300 }));
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.input.value = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  act(() => mocks.reaction?.());
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("useThreadKeyboard", () => {
  it("follows the keyboard while an input is focused", () => {
    focus(true);
    keyboardEnd(1);
    act(() => vi.advanceTimersByTime(KEYBOARD_SETTLE_MS * 2));
    expect(keyboard.progress.value).toBe(1);
    expect(keyboard.avoiding).toBe(true);
  });

  it("lowers the composer when the keyboard hides without a hide event", () => {
    focus(true);
    keyboardEnd(1);
    focus(false);
    act(() => vi.advanceTimersByTime(KEYBOARD_SETTLE_MS));
    expect(keyboard.progress.value).toBe(0);
    expect(keyboard.avoiding).toBe(false);
  });

  it("leaves a normal hide alone", () => {
    focus(true);
    keyboardEnd(1);
    focus(false);
    keyboardEnd(0);
    act(() => vi.advanceTimersByTime(KEYBOARD_SETTLE_MS));
    expect(keyboard.avoiding).toBe(true);
  });

  it("does not lower the keyboard when focus moves to another input", () => {
    focus(true);
    keyboardEnd(1);
    focus(false);
    focus(true);
    act(() => vi.advanceTimersByTime(KEYBOARD_SETTLE_MS));
    expect(keyboard.progress.value).toBe(1);
    expect(keyboard.avoiding).toBe(true);
  });

  it("avoids the keyboard again when it next shows", () => {
    focus(true);
    keyboardEnd(1);
    focus(false);
    act(() => vi.advanceTimersByTime(KEYBOARD_SETTLE_MS));
    act(() => mocks.handlers.onStart?.({ progress: 1, height: 300 }));
    expect(keyboard.avoiding).toBe(true);
  });

  it("avoids the keyboard again when an input focuses under a keyboard that stayed up", () => {
    focus(true);
    keyboardEnd(1);
    focus(false);
    act(() => vi.advanceTimersByTime(KEYBOARD_SETTLE_MS));
    focus(true);
    expect(keyboard.avoiding).toBe(true);
  });
});
