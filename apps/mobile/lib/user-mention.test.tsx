// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, Fragment } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageCaption } from "../components/message-caption";
import { UserMentionsContext, userMentionTargets } from "./message-mentions";

vi.mock("react-native", () => ({
  Text: ({
    children,
    onPress,
    accessibilityRole,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    style?: unknown;
  }) =>
    createElement(
      "span",
      {
        onClick: onPress,
        role: accessibilityRole,
        "data-style": JSON.stringify(Object.assign({}, ...[style].flat())),
      },
      children,
    ),
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement("i", { "data-style": JSON.stringify(style) }, children),
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock("@rakazo/chat-ui/native", () => {
  // Stands in for the real link finder, which has its own tests: explicit URLs and emails.
  const plainTextLinkParts = (text: string) =>
    text
      .split(/(https?:\/\/\S+|[^\s@]+@[^\s@]+\.[a-z]+)/)
      .map((value, index) => ({ type: index % 2 ? "link" : "text", value, href: value }))
      .filter((part) => part.value);
  return {
    ChatMarkdown: ({ children }: { children?: ReactNode }) => createElement("p", null, children),
    plainTextLinkParts,
    LinkifiedText: ({
      children,
      renderText,
    }: {
      children: string;
      renderText?: (text: string) => ReactNode;
    }) =>
      createElement(
        "b",
        null,
        plainTextLinkParts(children).map((part, index) =>
          createElement(
            Fragment,
            { key: index },
            part.type === "text" && renderText ? renderText(part.value) : part.value,
          ),
        ),
      ),
  };
});
vi.mock("../components/bot-avatar", () => ({
  BotAvatar: ({ identity, size }: { identity?: string; size?: number }) =>
    createElement("img", { "data-avatar": identity, "data-size": size }),
}));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, size }: { ios: string; size?: number }) =>
    createElement("svg", { "data-symbol": ios, "data-size": size }),
}));

const tokens = { chatUserForeground: "bubble-text" } as never;
const members = [
  { botId: "bot-ada", name: "Ada", color: "#112233" },
  { botId: "bot-ben", name: "Ben Stone", color: "#445566" },
];

describe("sent message mentions", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onOpenBot = vi.fn();
  function render(text: string, role: "user" | "bot" = "user", withMembers = members) {
    act(() =>
      root.render(
        <UserMentionsContext.Provider
          value={{ targets: userMentionTargets(withMembers), onOpenBot }}
        >
          <MessageCaption
            role={role}
            text={text}
            tokens={tokens}
            colorScheme="light"
            streaming={false}
          />
        </UserMentionsContext.Provider>,
      ),
    );
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onOpenBot.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("draws a member mention with a 15pt avatar in medium weight, without a background", () => {
    render("hey @Ada can you look");
    const mention = container.querySelector('span[role="link"]')!;
    expect(mention.textContent).toBe("Ada");
    expect(JSON.parse(mention.getAttribute("data-style")!)).toEqual({ fontWeight: "500" });
    expect(mention.querySelector("[data-avatar]")!.getAttribute("data-avatar")).toBe("bot-ada");
    expect(mention.querySelector("[data-avatar]")!.getAttribute("data-size")).toBe("15");
    expect(container.textContent).toBe("hey Ada can you look");
  });

  it("opens the bot's chat when the mention is tapped", () => {
    render("@Ben Stone, thanks");
    act(() => container.querySelector<HTMLElement>('span[role="link"]')!.click());
    expect(onOpenBot).toHaveBeenCalledWith("bot-ben", "Ben Stone");
  });

  it("shows everyone with a people icon that does not navigate", () => {
    render("@everyone please check");
    const mention = container.querySelector("span[data-style]:not([role])")!;
    expect(container.querySelector('[data-symbol="person.3"]')).not.toBeNull();
    expect(container.querySelector('span[role="link"]')).toBeNull();
    act(() => (mention as HTMLElement).click());
    expect(onOpenBot).not.toHaveBeenCalled();
  });

  it("offers everyone only when the group has two or more members", () => {
    render("@everyone hi", "user", members.slice(0, 1));
    expect(container.querySelector("[data-symbol]")).toBeNull();
    expect(container.textContent).toBe("@everyone hi");
  });

  it("keeps a link whole when its address contains a member's name", () => {
    render("see https://example.test/@Ada, then ask @Ada");
    expect(container.querySelectorAll('span[role="link"]')).toHaveLength(1);
    expect(container.textContent).toBe("see https://example.test/@Ada, then ask Ada");
    render("https://example.test/@Ada?x=1");
    expect(container.querySelector("[data-avatar]")).toBeNull();
    expect(container.textContent).toBe("https://example.test/@Ada?x=1");
  });

  it("reads @everyone as the group, never as a bot named everyone", () => {
    render("@everyone hi", "user", [
      ...members,
      { botId: "bot-all", name: "Everyone", color: "#000000" },
    ]);
    expect(container.querySelector("[data-avatar]")).toBeNull();
    expect(container.querySelector("[data-symbol]")).not.toBeNull();
  });

  it("leaves a name two members share as plain text", () => {
    render("@Ada hi", "user", [...members, { botId: "bot-ada-2", name: "ada", color: "#778899" }]);
    expect(container.querySelector("[data-avatar]")).toBeNull();
    expect(container.textContent).toBe("@Ada hi");
  });

  it("leaves text without a known name and bot replies as they were", () => {
    render("email ada@example.test or @Zed");
    expect(container.querySelector("[data-avatar]")).toBeNull();
    expect(container.textContent).toBe("email ada@example.test or @Zed");
    render("@Ada replied", "bot");
    expect(container.querySelector("[data-avatar]")).toBeNull();
  });
});
