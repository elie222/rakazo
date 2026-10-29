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
  CHAT_TITLE_AVATAR_SIZE: 28,
  ChatTitleAvatar: ({ bot, status }: { bot?: { color: string }; status?: string }) =>
    createElement("i", { "data-color": bot?.color ?? "slot", "data-status": status }),
}));
vi.mock("../components/group-seats", () => ({
  GroupSeats: ({ members, size }: { members: { botId: string }[]; size: number }) =>
    createElement("s", {
      "data-members": members.map((member) => member.botId).join(","),
      "data-size": size,
    }),
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
const inbox = (bots: unknown[], groups: unknown[] = []) =>
  [
    { id: "space-1", name: "Personal", isDefault: true, hasContent: true, bots, groups },
  ] as unknown as InboxSpace[];
const member = (botId: string) => ({ botId, name: botId, color: "#2A92FE::shape_2" });

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
  opens: { pathname: "/bot-profile", params: { botId: "bot-1", name: "Helper" } },
});
const avatar = () => container.querySelector("i");
const name = () => container.querySelector("b");
const seats = () => container.querySelector("s");
const button = () => container.querySelector("button")!;

it("draws the inbox's bot from the route alone, before the chat publishes anything", () => {
  setSearchInbox(inbox([helper]));
  render({ botId: "bot-1" });
  expect(avatar()?.getAttribute("data-color")).toBe(helper.color);
  expect(avatar()?.getAttribute("data-status")).toBe("running");
  expect(name()?.textContent).toBe("Helper");
  expect(name()?.getAttribute("data-placeholder")).toBe("false");
  expect(button().getAttribute("aria-label")).toBe("Profile");
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
  expect(push).toHaveBeenCalledWith({
    pathname: "/bot-profile",
    params: { botId: "bot-1", name: "Helper" },
  });
  act(() => clear());
  expect(avatar()?.getAttribute("data-color")).toBe("slot");
});

it("opens a one-to-one chat's bot profile from its title, not the chat's settings", () => {
  render({ botId: "bot-1", name: "Helper" });
  act(() => button().click());
  expect(push).toHaveBeenCalledWith({
    pathname: "/bot-profile",
    params: { botId: "bot-1", name: "Helper" },
  });
});

it("opens group settings with a visible group mark before members load, and keeps a read-only chat inert", () => {
  render({ groupId: "group-1", name: "Team" });
  expect(avatar()).toBeNull();
  expect(seats()?.getAttribute("data-members")).toBe("");
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

it("seats a group's members from the inbox on the first frame, then from the open chat", () => {
  setSearchInbox(
    inbox([], [{ id: "group-1", name: "Team", members: [member("b2"), member("b1")] }]),
  );
  render({ groupId: "group-1", name: "Team" });
  expect(seats()?.getAttribute("data-members")).toBe("b2,b1");
  expect(seats()?.getAttribute("data-size")).toBe("28");
  // Seats sit before the name, in place of a one-to-one chat's avatar.
  expect(seats()?.nextElementSibling).toBe(name());
  let clear = () => {};
  act(() => {
    clear = publishChatTitle("thread-1", {
      bot: undefined,
      status: undefined,
      composing: false,
      name: "Team",
      members: [member("b3"), member("b2"), member("b1")],
      opens: { pathname: "/group-settings", params: { groupId: "group-1" } },
    });
  });
  expect(seats()?.getAttribute("data-members")).toBe("b3,b2,b1");
  act(() => clear());
});

it("keeps the inbox's seats while the open chat hasn't loaded its members", () => {
  setSearchInbox(inbox([], [{ id: "group-1", name: "Team", members: [member("b1")] }]));
  render({ groupId: "group-1" });
  act(() => {
    publishChatTitle("thread-1", {
      bot: undefined,
      status: undefined,
      composing: false,
      name: "Team",
      opens: null,
    });
  });
  expect(seats()?.getAttribute("data-members")).toBe("b1");
});

it("shows a group identity even with no roster, and never on a one-to-one chat", () => {
  render({ groupId: "group-9", name: "Team" });
  expect(seats()?.getAttribute("data-members")).toBe("");
  act(() => setSearchInbox(inbox([helper], [{ id: "group-1", members: [member("b1")] }])));
  render({ botId: "bot-1" });
  expect(seats()).toBeNull();
});
