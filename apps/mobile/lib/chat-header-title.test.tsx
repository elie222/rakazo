// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatTitle } from "../components/chat-header-title";
import { ChatHeaderTitle, publishChatTitle } from "../components/chat-header-title";
import type { MobileBot } from "./api";
import type { InboxSpace } from "./inbox-spaces";
import { setSearchInbox } from "./search-inbox";

const push = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({
  Pressable: ({
    children,
    disabled,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) =>
    createElement(
      "button",
      { type: "button", disabled, "aria-label": accessibilityLabel, onClick: onPress },
      children,
    ),
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("../components/glass-surface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../components/chat-title-avatar", () => ({
  ChatTitleAvatar: ({ bot, status }: { bot?: { color: string }; status?: string }) =>
    createElement("i", { "data-color": bot?.color ?? "slot", "data-status": status }),
}));
vi.mock("../components/chat-title-label", () => ({
  ChatTitleLabel: ({ label, placeholder }: { label: string; placeholder: boolean }) =>
    createElement("b", { "data-placeholder": String(placeholder) }, label),
}));
vi.mock("../components/thread-header-styles", () => ({ createThreadHeaderStyles: () => ({}) }));
vi.mock("./native", () => ({ useThemedStyles: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./api", () => ({ currentApiBase: () => "http://api.test" }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => 1,
  subscribeSessionGeneration: () => () => undefined,
}));

const helper = {
  id: "bot-1",
  name: "Helper",
  color: "#2A92FE::shape_2",
  status: "running",
  spaceId: "space-1",
} as MobileBot;
const inbox = (bots: unknown[]) =>
  [
    { id: "space-1", name: "Personal", isDefault: true, hasContent: true, bots, groups: [] },
  ] as unknown as InboxSpace[];

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  push.mockClear();
  setSearchInbox([]);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
const render = (params: Parameters<typeof ChatHeaderTitle>[0]["params"], routeKey = "thread-1") =>
  act(() => root.render(<ChatHeaderTitle routeKey={routeKey} params={params} />));
const published = (color: string): ChatTitle => ({
  bot: { ...helper, color },
  status: undefined,
  composing: false,
  name: "Helper",
  settings: { pathname: "/bot-settings", params: { botId: "bot-1" } },
});
const avatar = () => container.querySelector("i");
const name = () => container.querySelector("b");
const button = () => container.querySelector("button")!;

it("draws the inbox's bot from the route alone, before the chat publishes anything", () => {
  setSearchInbox(inbox([helper]));
  render({ botId: "bot-1" });
  expect(avatar()?.getAttribute("data-color")).toBe(helper.color);
  expect(avatar()?.getAttribute("data-status")).toBe("running");
  expect(name()?.textContent).toBe("Helper");
  expect(name()?.getAttribute("data-placeholder")).toBe("false");
  expect(button().getAttribute("aria-label")).toBe("Chat settings");
});

it("reserves the avatar for an unknown bot and marks a missing name as a placeholder", () => {
  render({ botId: "bot-1" });
  expect(avatar()?.getAttribute("data-color")).toBe("slot");
  expect(name()?.textContent).toBe("Bot");
  expect(name()?.getAttribute("data-placeholder")).toBe("true");
});

it("shows what the open chat publishes, in the same title", () => {
  render({ botId: "bot-1", name: "Helper" });
  let clear = () => {};
  act(() => {
    clear = publishChatTitle("thread-1", published("#FF781C"));
  });
  expect(avatar()?.getAttribute("data-color")).toBe("#FF781C");
  act(() => button().click());
  expect(push).toHaveBeenCalledWith({ pathname: "/bot-settings", params: { botId: "bot-1" } });
  act(() => clear());
  expect(avatar()?.getAttribute("data-color")).toBe("slot");
});

it("opens a group's settings from its title, with no avatar, and keeps a read-only chat inert", () => {
  render({ groupId: "group-1", name: "Team" });
  expect(avatar()).toBeNull();
  act(() => button().click());
  expect(push).toHaveBeenCalledWith({
    pathname: "/group-settings",
    params: { groupId: "group-1" },
  });
  render({ botId: "bot-1", name: "Helper", readOnly: "1" });
  expect(button().disabled).toBe(true);
  expect(button().getAttribute("aria-label")).toBe("Helper");
});

it("keeps each screen's title its own, even for two screens of the same chat", () => {
  // Two screens of one chat, as during a push onto it, a pop or a cancelled swipe back.
  const both = (a: string, b: string) =>
    act(() =>
      root.render(
        <>
          <ChatHeaderTitle routeKey={a} params={{ botId: "bot-1", name: "Helper" }} />
          <ChatHeaderTitle routeKey={b} params={{ botId: "bot-1", name: "Helper" }} />
        </>,
      ),
    );
  both("thread-a", "thread-b");
  const colors = () =>
    Array.from(container.querySelectorAll("i"), (mark) => mark.getAttribute("data-color"));
  let clearA = () => {};
  let clearB = () => {};
  act(() => {
    clearA = publishChatTitle("thread-a", published("#AAAAAA"));
  });
  expect(colors()).toEqual(["#AAAAAA", "slot"]);
  act(() => {
    clearB = publishChatTitle("thread-b", published("#BBBBBB"));
  });
  expect(colors()).toEqual(["#AAAAAA", "#BBBBBB"]);
  // The leaving screen withdraws only its own title.
  act(() => clearA());
  expect(colors()).toEqual(["slot", "#BBBBBB"]);
  act(() => clearB());
  expect(colors()).toEqual(["slot", "slot"]);
});
