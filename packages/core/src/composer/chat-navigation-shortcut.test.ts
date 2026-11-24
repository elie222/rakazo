import { expect, it } from "vitest";
import { resolveChatNavigationShortcut } from "./chat-navigation-shortcut.js";

it("maps Command+K to search", () => {
  expect(resolveChatNavigationShortcut({ key: "k", metaKey: true })).toBe("search");
});

it("maps Ctrl+N to a new chat on web", () => {
  expect(resolveChatNavigationShortcut({ key: "n", ctrlKey: true })).toBe("new-chat");
});

it("leaves Command+Shift+K to the host", () => {
  expect(resolveChatNavigationShortcut({ key: "K", metaKey: true, shiftKey: true })).toBeNull();
});
