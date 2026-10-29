// @vitest-environment jsdom

import type { CSSProperties, ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PickChatPane } from "../components/pick-chat-pane";
import { useHomeHeader } from "./use-home-header";

const home = vi.hoisted(() => ({
  options: {} as Record<string, any>,
  setOptions: vi.fn(),
  push: vi.fn(),
  t: vi.fn((text: string) => text),
  insets: { top: 20, bottom: 30, left: 0, right: 12 },
}));
const { styled } = vi.hoisted(() => ({
  styled:
    (tag: string) =>
    ({ children, style }: { children?: ReactNode; style?: CSSProperties | CSSProperties[] }) =>
      createElement(tag, { style: Object.assign({}, ...[style].flat()) }, children),
}));

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: styled("span"),
  View: styled("div"),
}));
vi.mock("expo-router", () => {
  const navigation = { setOptions: home.setOptions };
  const router = { push: home.push };
  return { useNavigation: () => navigation, useRouter: () => router };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => home.insets }));
vi.mock("./i18n", () => {
  const i18n = { t: home.t, locale: "en" };
  return { useI18n: () => i18n };
});
vi.mock("./material-icons", () => ({ materialIcons: {} }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: { page: "white", secondaryLabel: "gray" },
  useThemedStyles: (factory: () => unknown) => factory(),
}));

const toggleActivityMode = vi.fn();
const runCreateAction = vi.fn();

function Inbox({ embedded = false }: { embedded?: boolean }) {
  useHomeHeader({
    nativeHeader: !embedded,
    ready: true,
    hasSession: true,
    initials: "A",
    activityMode: false,
    toggleActivityMode,
    runCreateAction,
  });
  return <p>{embedded ? "Embedded inbox" : "Compact inbox"}</p>;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  home.options = { headerShown: false };
  home.setOptions.mockReset();
  home.setOptions.mockImplementation((next: Record<string, unknown>) => {
    home.options = { ...home.options, ...next };
  });
  home.push.mockReset();
  home.t.mockImplementation((text: string) => text);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "hides the index header on every unfold and restores compact controls (initial split: %s)",
  (initialSplit) => {
    for (const split of [initialSplit, false, true, false, true]) {
      // The index route shows the placeholder on a split window and the compact inbox otherwise;
      // the chat list beside the placeholder is embedded and has no navigation bar.
      act(() =>
        root.render(
          split ? (
            <>
              <Inbox embedded />
              <PickChatPane />
            </>
          ) : (
            <Inbox />
          ),
        ),
      );
      expect(home.options.headerShown).toBe(!split);
      if (!split) {
        expect(home.options.headerTransparent).toBe(true);
        expect(home.options.headerStyle).toEqual({ backgroundColor: "transparent" });
        expect(
          home.options.unstable_headerLeftItems().map((item: { label: string }) => item.label),
        ).toEqual(["Account"]);
        expect(
          home.options
            .unstable_headerRightItems()
            .map((item: { accessibilityLabel: string }) => item.accessibilityLabel),
        ).toEqual(["Activity", "Search", "Create"]);
      }
    }
  },
);

it("leaves the navigation bar alone from the embedded inbox", () => {
  act(() => root.render(<Inbox embedded />));
  expect(container.textContent).toBe("Embedded inbox");
  expect(home.setOptions).not.toHaveBeenCalled();
});

it("wires the compact header items to their actions", () => {
  act(() => root.render(<Inbox />));
  const [account] = home.options.unstable_headerLeftItems();
  const [activity, search, create] = home.options.unstable_headerRightItems();
  account.onPress();
  search.onPress();
  activity.onPress();
  for (const item of create.menu.items) item.onPress();
  expect(home.push.mock.calls).toEqual([["/account"], ["/search"]]);
  expect(toggleActivityMode).toHaveBeenCalledOnce();
  expect(runCreateAction.mock.calls).toEqual([["bot"], ["group"], ["space"]]);
});

it("shows a translated, safe-area-centred placeholder only in the split pane", () => {
  home.t.mockImplementation(() => "Kies een chat");
  act(() => root.render(<PickChatPane />));
  expect(home.t).toHaveBeenCalledWith("Pick a chat");
  expect(container.textContent).toBe("Kies een chat");
  const pane = container.firstElementChild as HTMLElement;
  expect(pane.style.alignItems).toBe("center");
  expect(pane.style.justifyContent).toBe("center");
  expect(pane.style.paddingTop).toBe("20px");
  expect(pane.style.paddingBottom).toBe("30px");
  expect(pane.style.paddingRight).toBe("12px");
  expect(container.querySelector("span")!.style.color).toBe("gray");
});
