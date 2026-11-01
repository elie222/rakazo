// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatSplit } from "../components/chat-route-header";
import { chatRouteHeader } from "../components/chat-route-header";

const push = vi.hoisted(() => vi.fn());
const setInboxHidden = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ OS: "ios" }));
vi.mock("react-native", () => ({
  Platform: platform,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": props.accessibilityLabel,
        onClick: props.onPress,
        disabled: props.disabled,
      },
      props.children,
    ),
  View: (props: { children?: ReactNode }) => createElement("div", null, props.children),
}));
vi.mock("expo-router", () => ({ router: { push } }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ foreground: "#000" }) }));
vi.mock("./native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("./split-view", () => ({ setInboxHidden }));
vi.mock("./thread-edges", () => ({ threadEdgeOptions: () => ({ headerTransparent: true }) }));
vi.mock("../components/thread-header-styles", () => ({
  createThreadHeaderStyles: () => ({ headerActions: {} }),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/chat-header-title", () => ({ ChatHeaderTitle: () => null }));
vi.mock("../components/sheet-header", () => ({
  trailingHeaderOptions: (label: string) => ({
    unstable_headerRightItems: () => [{ type: "button", label }],
  }),
}));

beforeEach(() => {
  platform.OS = "ios";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  push.mockClear();
  setInboxHidden.mockClear();
});
const t = (text: string) => text;
const alone: ChatSplit = { split: false, inboxHidden: false };
const header = (params: object, split = alone) =>
  chatRouteHeader({ key: "thread-1", params }, t, split);
const rightItems = (options: ReturnType<typeof chatRouteHeader>) =>
  options.unstable_headerRightItems?.({ tintColor: undefined } as never) ?? [];
const leftItems = (options: ReturnType<typeof chatRouteHeader>) =>
  options.unstable_headerLeftItems?.({ tintColor: undefined } as never) ?? [];

it("declares a bot chat's title and its … menu when the screen is created", () => {
  const options = header({ botId: "bot-1", name: "Helper" });
  expect(options.headerTitle).toBeTypeOf("function");
  expect(options.headerTitleAlign).toBe("center");
  expect(options.headerTransparent).toBe(true);
  const [computer, item] = rightItems(options);
  expect(computer).toMatchObject({
    type: "button",
    label: "Open computer",
    icon: { type: "sfSymbol", name: "desktopcomputer" },
  });
  (computer as { onPress: () => void }).onPress();
  expect(push).toHaveBeenCalledWith({
    pathname: "/computer",
    params: { botId: "bot-1", name: "Helper" },
  });
  expect(item).toMatchObject({ type: "menu", icon: { type: "sfSymbol", name: "ellipsis" } });
  expect(options.headerRight).toBeTypeOf("function");
  expect(options.headerBackVisible).toBe(true);
});

it("opens the computer directly from an Android bot header", async () => {
  platform.OS = "android";
  const options = header({ botId: "bot-1", name: "Helper" });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(options.headerRight?.({} as never)));
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Open computer"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(push).toHaveBeenCalledWith({
      pathname: "/computer",
      params: { botId: "bot-1", name: "Helper" },
    });
    expect(container.querySelector('[aria-label="Bot actions"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("declares a group chat's settings button, which opens the group's settings", () => {
  const options = header({ groupId: "group-1" });
  expect(options.headerTitle).toBeTypeOf("function");
  const [item] = rightItems(options);
  expect(item).toMatchObject({ type: "button", icon: { type: "sfSymbol", name: "gearshape" } });
  (item as { onPress: () => void }).onPress();
  expect(push).toHaveBeenCalledWith({
    pathname: "/group-settings",
    params: { groupId: "group-1" },
  });
});

it("declares an archived chat's Restore button in place of the … menu", () => {
  const options = header({ botId: "bot-1", readOnly: "1" });
  expect(options.headerTitle).toBeTypeOf("function");
  expect(rightItems(options)).toEqual([{ type: "button", label: "Restore" }]);
});

it("beside the chat list, declares the sidebar button in place of the back button", () => {
  const options = header({ botId: "bot-1" }, { split: true, inboxHidden: false });
  expect(options.headerBackVisible).toBe(false);
  const [item] = leftItems(options);
  expect(item).toMatchObject({ type: "button", label: "Hide chats" });
  (item as { onPress: () => void }).onPress();
  expect(setInboxHidden).toHaveBeenCalledWith(true);
  const [shown] = leftItems(header({ botId: "bot-1" }, { split: true, inboxHidden: true }));
  expect(shown).toMatchObject({ label: "Show chats" });
});

it("folded like a book beside the chat list, declares neither a back nor a sidebar button", () => {
  const options = header({ botId: "bot-1" }, { split: true, inboxHidden: true, foldActive: true });
  expect(options.headerBackVisible).toBe(false);
  expect(options.headerLeft).toBeUndefined();
  expect(leftItems(options)).toEqual([]);
  expect(header({ botId: "bot-1" }).headerBackVisible).toBe(true);
});
