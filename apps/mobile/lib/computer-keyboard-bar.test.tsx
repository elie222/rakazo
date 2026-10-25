// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerKeyboardBar } from "../components/computer-keyboard-bar";
import type { NativeActionButtonProps } from "./native-controls";

type InputProps = {
  value?: string;
  multiline?: boolean;
  autoCorrect?: boolean;
  autoCapitalize?: string;
  submitBehavior?: string;
  onFocus: () => void;
  onBlur: () => void;
  onChangeText: (text: string) => void;
  onKeyPress?: (event: { nativeEvent: { key: string } }) => void;
  onSelectionChange?: (event: {
    nativeEvent: { selection: { start: number; end: number } };
  }) => void;
  onSubmitEditing: () => void;
};
const input = vi.hoisted(() => ({
  props: {} as InputProps,
  focus: (() => {}) as () => void,
  blur: (() => {}) as () => void,
  setNativeProps: (() => {}) as () => void,
  setSelection: (() => {}) as (start: number, end: number) => void,
  appState: undefined as ((state: string) => void) | undefined,
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      input.appState = listener;
      return { remove: () => undefined };
    },
  },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextInput: forwardRef((props: InputProps, ref) => {
    input.props = props;
    useImperativeHandle(ref, () => ({
      focus: input.focus,
      blur: input.blur,
      setNativeProps: input.setNativeProps,
      setSelection: input.setSelection,
    }));
    return null;
  }),
}));
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: () => false }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}), useResolvedAppearance: () => "light" }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: (props: NativeActionButtonProps) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel ?? props.label}
      aria-pressed={props.selected}
      data-size={props.size}
      data-icon={props.icon?.ios}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));

async function renderBar() {
  const view = document.createElement("div");
  const root = createRoot(view);
  const onCommand = vi.fn();
  // A focused field: focus() and blur() report back the way the native input does.
  input.focus = vi.fn(() => input.props.onFocus());
  input.blur = vi.fn(() => input.props.onBlur());
  input.setNativeProps = vi.fn();
  input.setSelection = vi.fn();
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const render = (active: boolean) =>
    act(async () => root.render(createElement(ComputerKeyboardBar, { active, onCommand })));
  await render(true);
  const button = (name: string) => view.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
  // Whatever the field starts with; typed values below are what it holds after each keystroke.
  const start = input.props.value ?? "";
  return {
    view,
    onCommand,
    button,
    click: async (name: string) => act(async () => button(name)!.click()),
    type: async (...values: string[]) => {
      for (const value of values) await act(async () => input.props.onChangeText(start + value));
    },
    // iOS reports some keystrokes twice before React renders again.
    typeTwice: async (...values: string[]) => {
      for (const value of values) {
        await act(async () => {
          const onChangeText = input.props.onChangeText;
          onChangeText(start + value);
          onChangeText(start + value);
        });
      }
    },
    key: async (key: string) => act(async () => input.props.onKeyPress?.({ nativeEvent: { key } })),
    setActive: render,
    select: async (start: number, end = start) =>
      act(async () =>
        input.props.onSelectionChange?.({ nativeEvent: { selection: { start, end } } }),
      ),
    later: (ms: number) => {
      now += ms;
    },
    unmount: async () => act(async () => root.unmount()),
  };
}

describe("computer keyboard accessory", () => {
  afterEach(() => vi.restoreAllMocks());

  it("toggles focus and consumes Ctrl once for keys, typing and Return", async () => {
    const bar = await renderBar();
    try {
      expect(bar.view.querySelectorAll('[data-size="compact"]')).toHaveLength(8);
      expect(bar.button("Show keyboard")!.dataset.icon).toBe("keyboard");
      await bar.click("Show keyboard");
      expect(bar.button("Hide keyboard")!.getAttribute("aria-pressed")).toBe("true");
      await bar.click("Hide keyboard");
      expect(bar.button("Show keyboard")!.getAttribute("aria-pressed")).toBe("false");
      await bar.click("Control");
      expect(bar.button("Control")!.getAttribute("aria-pressed")).toBe("true");
      await bar.click("Escape");
      expect(bar.onCommand).toHaveBeenLastCalledWith({
        type: "key",
        name: "Escape",
        control: true,
      });
      expect(bar.button("Control")!.getAttribute("aria-pressed")).toBe("false");
      await bar.click("Tab");
      expect(bar.onCommand).toHaveBeenLastCalledWith({ type: "key", name: "Tab" });
      await bar.click("Control");
      await bar.type("c");
      expect(bar.onCommand).toHaveBeenLastCalledWith({ type: "char", text: "c", control: true });
      expect(bar.button("Control")!.getAttribute("aria-pressed")).toBe("false");
      await bar.click("Control");
      await act(async () => input.props.onSubmitEditing());
      expect(bar.onCommand).toHaveBeenLastCalledWith({
        type: "key",
        name: "Return",
        control: true,
      });
      expect(bar.button("Control")!.getAttribute("aria-pressed")).toBe("false");
    } finally {
      await bar.unmount();
    }
  });

  it("uses a single-line field that the app never writes to", async () => {
    const bar = await renderBar();
    try {
      expect(input.props.value).toBeUndefined();
      expect(input.props.multiline).toBeUndefined();
      expect(input.props.autoCorrect).toBe(false);
      expect(input.props.autoCapitalize).toBe("none");
      expect(input.props.submitBehavior).toBe("submit");
      await bar.type("ab", "b");
      expect(input.setNativeProps).not.toHaveBeenCalled();
    } finally {
      await bar.unmount();
    }
  });

  it("sends a keystroke reported twice once", async () => {
    const bar = await renderBar();
    try {
      await bar.typeTwice("4", "44");
      expect(bar.onCommand.mock.calls).toEqual([
        [{ type: "text", text: "4" }],
        [{ type: "text", text: "4" }],
      ]);
    } finally {
      await bar.unmount();
    }
  });

  it("sends a code typed digit by digit, each reported twice, with corrections and Enter", async () => {
    const bar = await renderBar();
    try {
      await bar.typeTwice("4", "48", "482", "4829", "48291", "482913");
      await bar.key("Backspace");
      await bar.typeTwice("48291");
      await bar.key("Backspace");
      await bar.typeTwice("4829", "48295", "482957");
      await act(async () => input.props.onSubmitEditing());
      expect(bar.onCommand.mock.calls.map(([command]) => command)).toEqual([
        { type: "text", text: "4" },
        { type: "text", text: "8" },
        { type: "text", text: "2" },
        { type: "text", text: "9" },
        { type: "text", text: "1" },
        { type: "text", text: "3" },
        { type: "backspace", count: 1 },
        { type: "backspace", count: 1 },
        { type: "text", text: "5" },
        { type: "text", text: "7" },
        { type: "key", name: "Return" },
      ]);
    } finally {
      await bar.unmount();
    }
  });

  it("sends one Backspace per press with nothing typed, including a held repeat", async () => {
    const bar = await renderBar();
    try {
      await bar.key("Backspace");
      expect(bar.onCommand.mock.calls).toEqual([[{ type: "backspace", count: 1 }]]);
      await bar.key("Backspace");
      await bar.key("Backspace");
      expect(bar.onCommand).toHaveBeenCalledTimes(3);
      await bar.key("a");
      expect(bar.onCommand).toHaveBeenCalledTimes(3);
      await bar.click("Control");
      await bar.key("Backspace");
      expect(bar.onCommand).toHaveBeenLastCalledWith({
        type: "key",
        name: "Backspace",
        control: true,
      });
    } finally {
      await bar.unmount();
    }
  });

  it("deletes typed text once when the key press comes before the change", async () => {
    const bar = await renderBar();
    try {
      await bar.type("ab");
      bar.onCommand.mockClear();
      bar.later(100);
      await bar.key("Backspace");
      await bar.key("Backspace");
      await bar.type("a");
      bar.later(100);
      await bar.key("Backspace");
      await bar.type("");
      bar.later(100);
      await bar.key("Backspace");
      expect(bar.onCommand.mock.calls).toEqual([
        [{ type: "backspace", count: 1 }],
        [{ type: "backspace", count: 1 }],
        [{ type: "backspace", count: 1 }],
      ]);
    } finally {
      await bar.unmount();
    }
  });

  it("counts a fast empty-field Backspace after an iOS deletion", async () => {
    const bar = await renderBar();
    try {
      await bar.type("a");
      bar.onCommand.mockClear();
      await bar.key("Backspace");
      await bar.type("");
      bar.later(10);
      await bar.key("Backspace");
      expect(bar.onCommand.mock.calls).toEqual([
        [{ type: "backspace", count: 1 }],
        [{ type: "backspace", count: 1 }],
      ]);
    } finally {
      await bar.unmount();
    }
  });

  it("deletes typed text once when the key press comes after the change", async () => {
    const bar = await renderBar();
    try {
      await bar.type("ab", "a");
      await bar.key("Backspace");
      await bar.type("");
      await bar.key("Backspace");
      expect(bar.onCommand.mock.calls).toEqual([
        [{ type: "text", text: "ab" }],
        [{ type: "backspace", count: 1 }],
        [{ type: "backspace", count: 1 }],
      ]);
      await bar.type("a");
      bar.onCommand.mockClear();
      await bar.type("");
      await bar.key("Backspace");
      expect(bar.onCommand.mock.calls).toEqual([[{ type: "backspace", count: 1 }]]);
      await bar.key("Backspace");
      expect(bar.onCommand).toHaveBeenCalledTimes(2);
      await bar.type("b");
      await bar.type("");
      bar.later(100);
      await bar.key("Backspace");
      expect(bar.onCommand).toHaveBeenCalledTimes(5);
    } finally {
      await bar.unmount();
    }
  });

  it("keeps the caret at the end and sends nothing for an edit before it", async () => {
    const bar = await renderBar();
    try {
      await bar.type("482");
      bar.onCommand.mockClear();
      await bar.select(3);
      expect(input.setSelection).not.toHaveBeenCalled();
      await bar.select(1);
      expect(input.setSelection).toHaveBeenCalledWith(3, 3);
      await bar.select(0, 3);
      expect(input.setSelection).toHaveBeenLastCalledWith(3, 3);
      await bar.type("4182");
      expect(bar.onCommand).not.toHaveBeenCalled();
      await bar.type("41829");
      await bar.type("4182");
      expect(bar.onCommand.mock.calls).toEqual([
        [{ type: "text", text: "9" }],
        [{ type: "backspace", count: 1 }],
      ]);
      expect(input.setNativeProps).not.toHaveBeenCalled();
    } finally {
      await bar.unmount();
    }
  });

  it("still sends a Backspace whose selection arrives before its change", async () => {
    const bar = await renderBar();
    try {
      await bar.type("abc");
      bar.onCommand.mockClear();
      await bar.select(2);
      await bar.type("ab");
      expect(bar.onCommand.mock.calls).toEqual([[{ type: "backspace", count: 1 }]]);
      vi.mocked(input.setSelection).mockClear();
      await bar.select(2);
      expect(input.setSelection).not.toHaveBeenCalled();
      expect(input.setNativeProps).not.toHaveBeenCalled();
    } finally {
      await bar.unmount();
    }
  });

  it("closes for good when the screen starts closing", async () => {
    const bar = await renderBar();
    try {
      await bar.click("Show keyboard");
      expect(input.focus).toHaveBeenCalledTimes(1);
      await bar.setActive(false);
      expect(input.blur).toHaveBeenCalledTimes(1);
      await act(async () => input.props.onBlur());
      expect(input.focus).toHaveBeenCalledTimes(1);
      expect(bar.button("Show keyboard")!.getAttribute("aria-pressed")).toBe("false");

      await bar.click("Show keyboard");
      await act(async () => input.props.onBlur());
      expect(input.focus).toHaveBeenCalledTimes(1);
      expect(bar.button("Show keyboard")!.getAttribute("aria-pressed")).toBe("false");
      await bar.type("a", "");
      await bar.key("Backspace");
      await act(async () => input.props.onSubmitEditing());
      for (const key of ["Escape", "Tab", "Left", "Down", "Up", "Right"]) {
        await bar.click(key);
      }
      expect(bar.onCommand).not.toHaveBeenCalled();

      // A release that fails leaves the screen open; the keyboard stays closed until the toggle.
      await bar.setActive(true);
      expect(input.focus).toHaveBeenCalledTimes(1);
      await bar.click("Show keyboard");
      expect(input.focus).toHaveBeenCalledTimes(2);
      expect(bar.button("Hide keyboard")!.getAttribute("aria-pressed")).toBe("true");
      await bar.type("b");
      expect(bar.onCommand).toHaveBeenLastCalledWith({ type: "text", text: "b" });
    } finally {
      await bar.unmount();
    }
  });

  it("takes focus back while the keyboard is on", async () => {
    const bar = await renderBar();
    try {
      await bar.click("Show keyboard");
      expect(input.focus).toHaveBeenCalledTimes(1);
      await act(async () => input.props.onBlur());
      expect(input.focus).toHaveBeenCalledTimes(2);
      expect(bar.button("Hide keyboard")!.getAttribute("aria-pressed")).toBe("true");
      await bar.click("Tab");
      await bar.type("x");
      expect(input.focus).toHaveBeenCalledTimes(2);
    } finally {
      await bar.unmount();
    }
  });

  it("stays closed after the toggle or unmounting closes it, and stays up in the background", async () => {
    const bar = await renderBar();
    try {
      await bar.click("Show keyboard");
      await bar.click("Hide keyboard");
      expect(input.blur).toHaveBeenCalledTimes(1);
      expect(input.focus).toHaveBeenCalledTimes(1);
      expect(bar.button("Show keyboard")!.getAttribute("aria-pressed")).toBe("false");
      await act(async () => input.props.onBlur());
      expect(input.focus).toHaveBeenCalledTimes(1);

      await bar.click("Tab");
      expect(input.focus).toHaveBeenCalledTimes(1);

      await bar.click("Show keyboard");
      await act(async () => input.appState?.("inactive"));
      await act(async () => input.appState?.("background"));
      await act(async () => input.appState?.("active"));
      expect(input.blur).toHaveBeenCalledTimes(1);
      expect(bar.button("Hide keyboard")!.getAttribute("aria-pressed")).toBe("true");

      const onBlur = input.props.onBlur;
      await bar.unmount();
      onBlur();
      expect(input.focus).toHaveBeenCalledTimes(2);
    } finally {
      await bar.unmount();
    }
  });
});
