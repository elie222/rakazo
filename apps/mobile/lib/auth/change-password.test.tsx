// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ChangePassword from "../../app/(settings)/change-password";
import { announceToScreenReader } from "../native/announce";

vi.mock("../native/announce", () => ({ announceToScreenReader: vi.fn() }));

const session = vi.hoisted(() => ({
  order: [] as string[],
  endCallBeforeSessionEnd: vi.fn(async () => {
    session.order.push("threads/endCall");
  }),
  changePassword: vi.fn(async () => {
    session.order.push("change-password");
  }),
}));

vi.mock("../calls/call-session", () => ({
  endCallBeforeSessionEnd: session.endCallBeforeSessionEnd,
}));
vi.mock("./api-auth", () => ({ changePassword: session.changePassword }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("../native/native", () => ({
  native: { page: "white", fill: "gray", tertiaryLabel: "gray", label: "black" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../api/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ canGoBack: () => true, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../../components/native/native-action-button", () => ({
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
  let hangUp!: Deferred;
  session.endCallBeforeSessionEnd.mockImplementationOnce(async () => {
    session.order.push("threads/endCall");
    hangUp = deferred();
    await hangUp.promise;
  });
  await act(async () => {
    button.click();
  });
  expect(session.changePassword).not.toHaveBeenCalled();
  await act(async () => {
    hangUp.resolve();
  });
  expect(session.order).toEqual(["threads/endCall", "change-password"]);
  expect(session.endCallBeforeSessionEnd).toHaveBeenCalledOnce();
  expect(session.changePassword).toHaveBeenCalledWith("old-password", "new-password");
  expect(announceToScreenReader).not.toHaveBeenCalled();
});

function fillPasswords(confirmation = "new-password") {
  type("Current password", "old-password");
  type("New password", "new-password");
  type("Confirm password", confirmation);
}

async function submit() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
  });
}

it("announces every mismatch with the displayed text, including an identical retry", async () => {
  fillPasswords("different-password");
  expect(announceToScreenReader).not.toHaveBeenCalled();
  for (let attempt = 1; attempt <= 2; attempt++) {
    await submit();
    const shown = container.querySelector("p")!.textContent;
    expect(shown).toBe("Passwords do not match");
    expect(announceToScreenReader).toHaveBeenCalledTimes(attempt);
    expect(announceToScreenReader).toHaveBeenLastCalledWith(shown);
  }
  expect(session.endCallBeforeSessionEnd).not.toHaveBeenCalled();
  expect(session.changePassword).not.toHaveBeenCalled();
});

it("announces every refused password change with the displayed error", async () => {
  fillPasswords();
  for (let attempt = 1; attempt <= 2; attempt++) {
    session.changePassword.mockRejectedValueOnce(new Error("Wrong current password"));
    await submit();
    const shown = container.querySelector("p")!.textContent;
    // The existing errorText mock returns the user-facing fallback.
    expect(shown).toBe("Could not change password");
    expect(announceToScreenReader).toHaveBeenCalledTimes(attempt);
    expect(announceToScreenReader).toHaveBeenLastCalledWith(shown);
  }
});

it("announces a call teardown failure without changing the password", async () => {
  fillPasswords();
  session.endCallBeforeSessionEnd.mockRejectedValueOnce(new Error("Could not end call"));
  await submit();
  expect(session.changePassword).not.toHaveBeenCalled();
  expect(announceToScreenReader).toHaveBeenCalledExactlyOnceWith(
    container.querySelector("p")!.textContent,
  );
});

it("does not announce a failure after leaving the screen", async () => {
  fillPasswords();
  const request = deferred();
  session.changePassword.mockImplementationOnce(() => request.promise);
  await submit();
  expect(session.changePassword).toHaveBeenCalledOnce();
  act(() => root.render(null));
  await act(async () => {
    request.reject(new Error("Wrong current password"));
  });
  expect(announceToScreenReader).not.toHaveBeenCalled();
});

it("stays silent on success after an announced mismatch", async () => {
  fillPasswords("different-password");
  await submit();
  expect(announceToScreenReader).toHaveBeenCalledOnce();
  type("Confirm password", "new-password");
  await submit();
  expect(session.changePassword).toHaveBeenCalledOnce();
  expect(container.querySelector("p")).toBeNull();
  expect(announceToScreenReader).toHaveBeenCalledOnce();
});
