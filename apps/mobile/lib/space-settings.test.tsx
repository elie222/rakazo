// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpaceSettings from "../app/(settings)/space";

const state = vi.hoisted(() => ({
  push: vi.fn(),
  rpc: vi.fn(),
  overrides: [] as string[],
}));
type SwitchProps = {
  accessibilityLabel?: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
};
const { element, toggle } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
      createElement(tag, { "aria-label": accessibilityLabel }, children),
  toggle: ({ accessibilityLabel, value, disabled, onValueChange }: SwitchProps) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": accessibilityLabel,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { useI18n: () => ({ t }) };
});
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async (spaceId: string) => ({
    apiBase: "https://app.example.test",
    headers: { "x-rakazo-space-id": spaceId },
  }),
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ spaceId: "space-other", name: "Work" }),
  useRouter: () => ({ push: state.push }),
}));
vi.mock("react-native", () => ({
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: element("span"),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: element("div") }));
vi.mock("../components/native-switch", () => ({ NativeSwitch: toggle }));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: element("section"),
  SettingsRow: ({
    title,
    onPress,
    trailing,
  }: {
    title: string;
    onPress?: () => void;
    trailing?: ReactNode;
  }) =>
    createElement(
      "div",
      null,
      onPress ? createElement("button", { type: "button", onClick: onPress }, title) : title,
      trailing,
    ),
}));

const spaceContext = {
  requestContext: {
    apiBase: "https://app.example.test",
    headers: { "x-rakazo-space-id": "space-other" },
  },
};
let root: Root;
let container: HTMLDivElement;
const control = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.overrides = [];
  state.push.mockReset();
  state.rpc
    .mockReset()
    .mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
      if (proc === "spaceSettings/overrides") return state.overrides;
      if (proc === "spaceSettings/setOverride") {
        const setting = input!.setting as string;
        state.overrides = input!.enabled
          ? [...state.overrides, setting]
          : state.overrides.filter((entry) => entry !== setting);
        return state.overrides;
      }
      throw new Error(`Unexpected RPC: ${proc}`);
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(SpaceSettings)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("follows the account until a setting is customized, then opens the same screen for the Space", async () => {
  expect(state.rpc).toHaveBeenCalledWith("spaceSettings/overrides", undefined, spaceContext);
  for (const name of ["Models", "Voice", "Approvals"])
    expect(control(`Customize ${name}`)?.checked).toBe(false);
  expect(container.querySelector("button")).toBeNull();

  await act(async () => control("Customize Models")!.click());
  expect(state.rpc).toHaveBeenCalledWith(
    "spaceSettings/setOverride",
    { setting: "models", enabled: true },
    spaceContext,
  );
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/models",
    params: { spaceId: "space-other" },
  });
  expect(control("Customize Models")?.checked).toBe(true);

  state.push.mockReset();
  await act(async () => container.querySelector("button")!.click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/models",
    params: { spaceId: "space-other" },
  });

  await act(async () => control("Customize Models")!.click());
  expect(state.rpc).toHaveBeenLastCalledWith(
    "spaceSettings/setOverride",
    { setting: "models", enabled: false },
    spaceContext,
  );
  expect(control("Customize Models")?.checked).toBe(false);
});

it("opens the Approvals screen for the Space once approvals are customized", async () => {
  await act(async () => control("Customize Approvals")!.click());
  expect(state.rpc).toHaveBeenCalledWith(
    "spaceSettings/setOverride",
    { setting: "confirmations", enabled: true },
    spaceContext,
  );
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/approvals",
    params: { spaceId: "space-other" },
  });
});
