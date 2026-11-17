// @vitest-environment jsdom

import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createContext } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SignupSurvey from "../app/(settings)/signup-survey";

const state = vi.hoisted(() => ({
  selectedSpace: "space-1",
  rpc: vi.fn(),
  close: vi.fn(),
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => state.selectedSpace,
  captureApiRequestContext: async (spaceId: string | null = state.selectedSpace) => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./settings-sheet", () => ({ closeSettingsSheet: state.close }));
vi.mock("./call-keyboard-context", () => ({ CallKeyboardContext: createContext(false) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    KeyboardAvoidingView: View,
    ScrollView: View,
    View,
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles },
    TextInput: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
      <input aria-label={accessibilityLabel} />
    ),
  };
});
vi.mock("../components/menu-picker", () => ({
  MenuPickerMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/settings-group", () => ({
  useStackedSettings: () => false,
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ title }: { title: string }) => <p>{title}</p>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.rpc.mockReset();
  state.close.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<SignupSurvey />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const continueButton = () =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === "Continue")!;

it("closes at once and sends the answers once, however often Continue is pressed", async () => {
  const saving = deferred<unknown>();
  state.rpc.mockReturnValue(saving.promise);
  await act(async () => {
    continueButton().click();
    continueButton().click();
  });
  expect(state.close).toHaveBeenCalledOnce();
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith(
    "onboarding/signupSurvey",
    {},
    expect.objectContaining({ requestContext: expect.anything() }),
  );
  await act(async () => continueButton().click());
  expect(state.rpc).toHaveBeenCalledOnce();
  await act(async () => saving.resolve({}));
});

it("lets a failed save go without holding up the new account", async () => {
  state.rpc.mockRejectedValue(new Error("Offline"));
  await act(async () => continueButton().click());
  await act(flush);
  expect(state.close).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("Offline");
});
