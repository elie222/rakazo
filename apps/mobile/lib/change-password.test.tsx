// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ChangePassword from "../app/(settings)/change-password";

const session = vi.hoisted(() => ({
  order: [] as string[],
  endCallBeforeSessionEnd: vi.fn(async () => {
    session.order.push("threads/endCall");
  }),
  changePassword: vi.fn(async () => {
    session.order.push("change-password");
  }),
}));

vi.mock("./call-session", () => ({
  endCallBeforeSessionEnd: session.endCallBeforeSessionEnd,
}));
vi.mock("./api-auth", () => ({ changePassword: session.changePassword }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({
  native: { page: "white", fill: "gray", tertiaryLabel: "gray", label: "black" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: (_error: unknown, fallback: string) => fallback }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ canGoBack: () => true, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", disabled, onClick: onPress }, label),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    KeyboardAvoidingView: View,
    Platform: { OS: "ios" },
    ScrollView: View,
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: ({ children }: { children?: ReactNode }) => createElement("p", null, children),
    TextInput: ({
      accessibilityLabel,
      editable,
      onChangeText,
      value,
    }: {
      accessibilityLabel?: string;
      editable?: boolean;
      onChangeText?: (value: string) => void;
      value?: string;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        disabled: editable === false,
        value,
        onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
      }),
  };
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  session.order.length = 0;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(ChangePassword)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function type(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("ends an active call on the server before changing the password", async () => {
  type("Current password", "old-password");
  type("New password", "new-password");
  type("Confirm password", "new-password");
  const button = container.querySelector<HTMLButtonElement>("button")!;
  expect(button.disabled).toBe(false);
  // The hang-up is still in flight: the password must not change before it settles.
  let hangUp!: () => void;
  session.endCallBeforeSessionEnd.mockImplementationOnce(async () => {
    session.order.push("threads/endCall");
    await new Promise<void>((resolve) => {
      hangUp = resolve;
    });
  });
  await act(async () => {
    button.click();
  });
  expect(session.changePassword).not.toHaveBeenCalled();
  await act(async () => {
    hangUp();
  });
  expect(session.order).toEqual(["threads/endCall", "change-password"]);
  expect(session.endCallBeforeSessionEnd).toHaveBeenCalledOnce();
  expect(session.changePassword).toHaveBeenCalledWith("old-password", "new-password");
});
