// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxHeader } from "../components/inbox-header";

const header = vi.hoisted(() => ({
  platform: { OS: "ios" },
  push: vi.fn(),
}));
const { labelled } = vi.hoisted(() => ({
  labelled:
    (tag: string) =>
    ({
      children,
      accessibilityLabel,
      onPress,
    }: {
      children?: ReactNode;
      accessibilityLabel?: string;
      onPress?: () => void;
    }) =>
      createElement(tag, { "aria-label": accessibilityLabel, onClick: onPress }, children),
}));

vi.mock("react-native", () => ({
  Platform: header.platform,
  Pressable: labelled("button"),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: labelled("span"),
  View: labelled("div"),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    children,
    actions,
    onPressAction,
  }: {
    children?: ReactNode;
    actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) =>
    createElement(
      "menu",
      null,
      children,
      actions.map((action) =>
        createElement(
          "li",
          { key: action.id, onClick: () => onPressAction({ nativeEvent: { event: action.id } }) },
          action.title,
        ),
      ),
    ),
}));
vi.mock("expo-router", () => {
  const router = { push: header.push };
  return { useRouter: () => router };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("./material-icons", () => ({ materialIcons: {} }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({}),
  resolveMobileAppearance: () => "light",
}));
vi.mock("./i18n", () => {
  const i18n = { t: (text: string) => text };
  return { useI18n: () => i18n };
});
vi.mock("./native", () => ({ native: {}, useThemedStyles: () => ({}) }));

let root: Root;
let container: HTMLDivElement;
const toggleActivityMode = vi.fn();
const runCreateAction = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  header.push.mockReset();
  toggleActivityMode.mockReset();
  runCreateAction.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderHeader(platform: string) {
  header.platform.OS = platform;
  act(() =>
    root.render(
      <InboxHeader
        initials="A"
        activityMode={false}
        toggleActivityMode={toggleActivityMode}
        runCreateAction={runCreateAction}
        columnInsets={{ left: 0, right: 0 }}
      />,
    ),
  );
  return (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
}

it.each(["android", "ios"])("omits Artifacts from the %s fallback header", (platform) => {
  const control = renderHeader(platform);
  expect(
    Array.from(container.querySelectorAll("[aria-label]"), (node) =>
      node.getAttribute("aria-label"),
    ),
  ).toEqual(["Account", "Activity", "Search", "Create"]);
  act(() => control("Account").click());
  act(() => control("Search").click());
  act(() => control("Activity").click());
  expect(header.push.mock.calls).toEqual([["/account"], ["/search"]]);
  expect(toggleActivityMode).toHaveBeenCalledOnce();
});

it.each(["android", "ios"])("creates from the %s menu", (platform) => {
  renderHeader(platform);
  for (const item of container.querySelectorAll("li")) act(() => item.click());
  expect(runCreateAction.mock.calls).toEqual([["bot"], ["group"], ["space"]]);
});
