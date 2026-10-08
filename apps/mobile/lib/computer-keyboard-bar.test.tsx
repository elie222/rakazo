// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ComputerKeyboardBar } from "../components/computer-keyboard-bar";
import type { NativeActionButtonProps } from "./native-controls";

type InputProps = {
  value: string;
  onFocus: () => void;
  onBlur: () => void;
  onChangeText: (text: string) => void;
  onSubmitEditing: () => void;
};
const input = vi.hoisted(() => ({ props: {} as InputProps }));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextInput: forwardRef((props: InputProps, ref) => {
    input.props = props;
    useImperativeHandle(ref, () => ({
      focus: props.onFocus,
      blur: props.onBlur,
      setNativeProps: vi.fn(),
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

describe("computer keyboard accessory", () => {
  it("toggles focus and consumes Ctrl once for keys, typing and Return", async () => {
    const view = document.createElement("div");
    const root = createRoot(view);
    const onCommand = vi.fn();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => root.render(createElement(ComputerKeyboardBar, { onCommand })));
      const button = (name: string) =>
        view.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;
      const click = async (name: string) => act(async () => button(name).click());
      expect(view.querySelectorAll('[data-size="compact"]')).toHaveLength(8);
      expect(button("Show keyboard").dataset.icon).toBe("keyboard");
      await click("Show keyboard");
      expect(button("Hide keyboard").getAttribute("aria-pressed")).toBe("true");
      await click("Hide keyboard");
      expect(button("Show keyboard").getAttribute("aria-pressed")).toBe("false");
      await click("Control");
      expect(button("Control").getAttribute("aria-pressed")).toBe("true");
      await click("Escape");
      expect(onCommand).toHaveBeenLastCalledWith({ type: "key", name: "Escape", control: true });
      expect(button("Control").getAttribute("aria-pressed")).toBe("false");
      await click("Tab");
      expect(onCommand).toHaveBeenLastCalledWith({ type: "key", name: "Tab" });
      await click("Control");
      await act(async () => input.props.onChangeText(`${input.props.value}c`));
      expect(onCommand).toHaveBeenLastCalledWith({ type: "char", text: "c", control: true });
      expect(button("Control").getAttribute("aria-pressed")).toBe("false");
      await click("Control");
      await act(async () => input.props.onSubmitEditing());
      expect(onCommand).toHaveBeenLastCalledWith({ type: "key", name: "Return", control: true });
      expect(button("Control").getAttribute("aria-pressed")).toBe("false");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
