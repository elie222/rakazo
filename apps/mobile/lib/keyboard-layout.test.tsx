// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { LayoutChangeEvent, View } from "react-native";
import { KeyboardEvents } from "react-native-keyboard-controller";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardLayout } from "./keyboard-layout";

const native = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  insets: { top: 24, bottom: 24, left: 0, right: 0 },
  focused: true,
  appState: "active",
  platform: "android",
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => () => void) => {
    const focused = native.focused;
    useEffect(() => (focused ? effect() : undefined), [effect, focused]);
  },
}));
vi.mock("react-native", () => {
  const listen = (name: string, callback: (...args: any[]) => void) => {
    native.listeners.set(name, callback);
    return { remove: () => native.listeners.delete(name) };
  };
  return {
    AppState: {
      get currentState() {
        return native.appState;
      },
      addEventListener: (_name: string, callback: (...args: any[]) => void) =>
        listen("app", callback),
    },
    Dimensions: { addEventListener: listen },
    Keyboard: {
      addListener: listen,
    },
    Platform: {
      get OS() {
        return native.platform;
      },
      Version: 34,
      constants: { Brand: "test", Model: "test" },
    },
  };
});
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardEvents: { addListener: vi.fn(() => ({ remove() {} })) },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => native.insets }));

let root: Root;
let layout: ReturnType<typeof useKeyboardLayout>;
function Harness() {
  layout = useKeyboardLayout();
  return null;
}
function view(y: number, height: number) {
  return {
    measureInWindow: (callback: (...values: number[]) => void) => callback(0, y, 400, height),
  } as unknown as View;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.listeners.clear();
  native.focused = true;
  native.appState = "active";
  native.platform = "android";
  vi.mocked(KeyboardEvents.addListener).mockClear();
  native.insets = { top: 24, bottom: 24, left: 0, right: 0 };
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe("keyboard layout recovery", () => {
  beforeEach(async () => {
    await act(async () => root.render(createElement(Harness)));
  });
  it("uses the wrapper window origin even with a nonzero parent-relative y and remeasures after resume", async () => {
    expect(layout.offset).toBe(0);
    layout.container.current = view(88, 712);
    await act(async () =>
      layout.onLayout({ nativeEvent: { layout: { y: 8 } } } as LayoutChangeEvent),
    );
    expect(layout.offset).toBe(88);
    layout.container.current = view(100, 700);
    await act(async () => layout.onFocus());
    expect(layout.offset).toBe(100);
    layout.container.current = view(64, 736);
    await act(async () => native.listeners.get("app")?.("active"));
    expect(layout.offset).toBe(64);
  });
  it("ignores a stale asynchronous measurement from before a later keyboard event", async () => {
    let delayed: ((...values: number[]) => void) | undefined;
    layout.container.current = {
      measureInWindow: (callback: typeof delayed) => {
        delayed = callback;
      },
    } as unknown as View;
    await act(async () => layout.onFocus());
    layout.container.current = view(90, 710);
    await act(async () => native.listeners.get("keyboardDidShow")?.());
    expect(layout.offset).toBe(90);
    await act(async () => delayed?.(0, 0, 400, 800));
    expect(layout.offset).toBe(90);
  });
  it("remeasures after the animation settles and coalesces its delayed callbacks", async () => {
    const measured = vi.fn((callback: (...values: number[]) => void) => callback(0, 88, 400, 712));
    layout.container.current = { measureInWindow: measured } as unknown as View;
    for (let i = 0; i < 40; i++) {
      await act(async () =>
        layout.onLayout({ nativeEvent: { layout: { y: 8 } } } as LayoutChangeEvent),
      );
    }
    expect(layout.offset).toBe(88);
    expect(measured).toHaveBeenCalledTimes(40);
    measured.mockImplementation((callback) => callback(0, 100, 400, 700));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(layout.offset).toBe(100);
    expect(measured).toHaveBeenCalledTimes(41);
  });
  it("remeasures on app state changes, refreshes only in foreground, and stops when unfocused", async () => {
    const measured = vi.fn((callback: (...values: number[]) => void) => callback(0, 88, 400, 712));
    layout.container.current = { measureInWindow: measured } as unknown as View;
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(layout.offset).toBe(88);
    expect(measured).toHaveBeenCalledTimes(1);
    measured.mockImplementation((callback) => callback(0, 96, 400, 704));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(layout.offset).toBe(96);
    expect(measured).toHaveBeenCalledTimes(2);

    measured.mockImplementation((callback) => callback(0, 100, 400, 700));
    await act(async () => {
      native.appState = "background";
      native.listeners.get("app")?.(native.appState);
    });
    expect(layout.offset).toBe(100);
    expect(measured).toHaveBeenCalledTimes(3);
    measured.mockImplementation((callback) => callback(0, 104, 400, 696));
    await act(async () => vi.advanceTimersByTimeAsync(349));
    expect(measured).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(layout.offset).toBe(104);
    expect(measured).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(measured).toHaveBeenCalledTimes(4);

    measured.mockImplementation((callback) => callback(0, 108, 400, 692));
    await act(async () => {
      native.appState = "active";
      native.listeners.get("app")?.(native.appState);
    });
    expect(layout.offset).toBe(108);
    expect(measured).toHaveBeenCalledTimes(5);
    measured.mockImplementation((callback) => callback(0, 112, 400, 688));
    await act(async () => vi.advanceTimersByTimeAsync(349));
    expect(measured).toHaveBeenCalledTimes(5);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(layout.offset).toBe(112);
    expect(measured).toHaveBeenCalledTimes(6);

    // Unfocusing also cancels a pending app-state re-check.
    await act(async () => native.listeners.get("app")?.(native.appState));
    expect(measured).toHaveBeenCalledTimes(7);
    native.focused = false;
    await act(async () => root.render(createElement(Harness)));
    measured.mockImplementation((callback) => callback(0, 116, 400, 684));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(layout.offset).toBe(112);
    expect(measured).toHaveBeenCalledTimes(7);
    native.focused = true;
    await act(async () => root.render(createElement(Harness)));
    expect(layout.offset).toBe(116);
    expect(measured).toHaveBeenCalledTimes(8);
  });
  it("keeps a known offset when native measurement stalls and recovers on the next focus", async () => {
    layout.container.current = view(88, 712);
    await act(async () => layout.onFocus());
    expect(layout.offset).toBe(88);
    let delayed: ((...values: number[]) => void) | undefined;
    layout.container.current = {
      measureInWindow: (callback: typeof delayed) => {
        delayed = callback;
      },
    } as unknown as View;
    await act(async () => layout.onFocus());
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(layout.offset).toBe(88);
    await act(async () => delayed?.(0, 0, 400, 800));
    expect(layout.offset).toBe(88);
    layout.container.current = view(100, 700);
    await act(async () => layout.onFocus());
    expect(layout.offset).toBe(100);
  });
  it("remeasures when safe area insets change without a dimension event", async () => {
    layout.container.current = view(88, 712);
    await act(async () => layout.onFocus());
    expect(layout.offset).toBe(88);
    layout.container.current = view(72, 728);
    native.insets = { ...native.insets, top: 8 };
    await act(async () => root.render(createElement(Harness)));
    expect(layout.offset).toBe(72);
  });
});

describe("non-Android keyboard layout", () => {
  it.each(["ios", "web", "windows", "macos"])("does nothing on %s", async (platform) => {
    native.platform = platform;
    await act(async () => root.render(createElement(Harness)));
    const measured = vi.fn();
    layout.container.current = { measureInWindow: measured } as unknown as View;
    await act(async () => {
      layout.onLayout({ nativeEvent: { layout: { y: 8 } } } as LayoutChangeEvent);
      layout.onFocus();
    });
    native.insets = { ...native.insets, top: 8 };
    await act(async () => root.render(createElement(Harness)));
    expect(layout.offset).toBe(0);
    expect(native.listeners.size).toBe(0);
    expect(KeyboardEvents.addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(measured).not.toHaveBeenCalled();
    expect(layout.offset).toBe(0);
  });
});
