// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatSplit } from "./chat-route-header";
import { chatRouteHeader } from "./chat-route-header";

const push = vi.hoisted(() => vi.fn());
const setInboxHidden = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: () => null,
  View: () => null,
}));
vi.mock("../../../lib/appearance/appearance", () => ({
  mobileTokens: () => ({ foreground: "#000" }),
}));
vi.mock("../../../lib/native/native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("../../../lib/layout/split-view", () => ({ setInboxHidden }));
vi.mock("../../../lib/thread/scroll/thread-edges", () => ({
  threadEdgeOptions: () => ({ headerTransparent: true }),
}));
vi.mock("../../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./chat-header-title", () => ({ ChatHeaderTitle: () => null }));
vi.mock("../../native/sheet-header", () => ({
  trailingHeaderOptions: (label: string) => ({
    unstable_headerRightItems: () => [{ type: "button", label }],
  }),
}));

beforeEach(() => {
  push.mockClear();
  setInboxHidden.mockClear();
});
const alone: ChatSplit = { split: false, inboxHidden: false };
const header = (params: object, split = alone, canInvite = false) =>
  chatRouteHeader({ key: "thread-1", params }, split, { push } as never, canInvite);
const rightItems = (options: ReturnType<typeof chatRouteHeader>) =>
  options.unstable_headerRightItems?.({ tintColor: undefined } as never) ?? [];
const leftItems = (options: ReturnType<typeof chatRouteHeader>) =>
  options.unstable_headerLeftItems?.({ tintColor: undefined } as never) ?? [];

it("declares a bot chat's title and its invite gift when the screen is created", () => {
  const options = header({ botId: "bot-1", name: "Helper" }, alone, true);
  expect(options.headerTitle).toBeTypeOf("function");
  expect(options.headerTitleAlign).toBe("center");
  expect(options.headerTransparent).toBe(true);
  const [item] = rightItems(options);
  expect(item).toMatchObject({ type: "button", icon: { type: "sfSymbol", name: "gift" } });
  (item as { onPress: () => void }).onPress();
  expect(push).toHaveBeenCalledWith("/invite");
  expect(options.headerRight).toBeTypeOf("function");
  expect(options.headerBackVisible).toBe(true);
});

it("leaves a bot chat's right side empty when the account cannot invite", () => {
  const options = header({ botId: "bot-1", name: "Helper" });
  expect(rightItems(options)).toEqual([]);
  expect(options.headerRight).toBeUndefined();
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

it("declares an archived chat's Restore button in place of the gift", () => {
  const options = header({ botId: "bot-1", readOnly: "1" }, alone, true);
  expect(options.headerTitle).toBeTypeOf("function");
  expect(rightItems(options)).toEqual([{ type: "button", label: "Restore" }]);
});

it("beside the chat list, leaves hiding it to the list and declares Show chats once hidden", () => {
  const options = header({ botId: "bot-1" }, { split: true, inboxHidden: false });
  expect(options.headerBackVisible).toBe(false);
  expect(leftItems(options)).toEqual([]);
  const hidden = header({ botId: "bot-1" }, { split: true, inboxHidden: true });
  expect(hidden.headerBackVisible).toBe(false);
  const [item] = leftItems(hidden);
  expect(item).toMatchObject({ type: "button", label: "Show chats" });
  (item as { onPress: () => void }).onPress();
  expect(setInboxHidden).toHaveBeenCalledWith(false);
});

it("folded like a book beside the chat list, declares neither a back nor a sidebar button", () => {
  const options = header({ botId: "bot-1" }, { split: true, inboxHidden: true, foldActive: true });
  expect(options.headerBackVisible).toBe(false);
  expect(options.headerLeft).toBeUndefined();
  expect(leftItems(options)).toEqual([]);
  expect(header({ botId: "bot-1" }).headerBackVisible).toBe(true);
});
