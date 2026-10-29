import type { ComponentProps } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageActionProps } from "../components/thread/message-bubble";

const mocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(async (_text: string) => true),
  // Markdown extraction itself is covered by chat-ui's native parser tests.
  markdownCodeBlocks: vi.fn((_markdown: string): string[] => []),
  actionProps: undefined as MessageActionProps | undefined,
}));

vi.mock("react-native", () => ({
  ActionSheetIOS: {},
  Alert: { alert: vi.fn() },
  Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
  View: "div",
}));
vi.mock("react-native-reanimated", () => ({
  default: { Text: "span" },
  useReducedMotion: () => true,
  ZoomIn: {},
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.setStringAsync }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("@rakazo/chat-ui/native", () => ({ markdownCodeBlocks: mocks.markdownCodeBlocks }));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("../components/message-action-menu", () => ({ presentMessageMenu: vi.fn() }));
vi.mock("../components/message-context-menu", () => ({
  MessageContextMenu: ({ children }: { children: unknown }) => children,
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/reply-line", () => ({ ReplyLine: () => null }));
vi.mock("../components/time-separator", () => ({ TimeSeparator: () => null }));
vi.mock("../components/unread-divider", () => ({ UnreadDivider: () => null }));
// Capture the accessibility actions MessageRow hands its bubble.
vi.mock("../components/thread/message-bubble", () => ({
  MessageBubble: ({ actionProps }: { actionProps: MessageActionProps }) => {
    mocks.actionProps = actionProps;
    return null;
  },
}));

import { MessageRow } from "../components/thread/message-row";

type RowProps = ComponentProps<typeof MessageRow>;

function messageMenu(role: "bot" | "user", blocks: string[], markedUnread = false) {
  const text = blocks.map((code) => `\`\`\`\n${code}\n\`\`\``).join("\n\n");
  mocks.markdownCodeBlocks.mockReturnValue(blocks);
  mocks.actionProps = undefined;
  const props = {
    message: {
      id: "message-1",
      role,
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: [{ kind: "text", text }],
    },
    actions: {},
    bubbleBotId: "bot-1",
    showBotSenderName: false,
    bots: [],
    readOnly: false,
    onCall: false,
    canAnswer: false,
    canDismiss: false,
    highlighted: false,
    separator: false,
    headerAdjacent: false,
    unreadDivider: false,
    markedUnread,
    replyAuthor: "",
    waitingForUser: false,
    inGroup: false,
    columnWidth: 400,
    enableJump: false,
    index: 0,
  } as unknown as RowProps;
  renderToStaticMarkup(createElement(MessageRow, props));
  const actionProps = mocks.actionProps as MessageActionProps | undefined;
  if (!actionProps?.accessibilityActions || !actionProps.onAccessibilityAction) {
    throw new Error("MessageRow did not pass accessibility actions to its bubble");
  }
  const { accessibilityActions, onAccessibilityAction } = actionProps;
  return {
    accessibilityActions,
    run: (actionName: string) =>
      onAccessibilityAction({ nativeEvent: { actionName } } as Parameters<
        typeof onAccessibilityAction
      >[0]),
    text,
  };
}

beforeEach(() => {
  mocks.setStringAsync.mockClear();
  mocks.markdownCodeBlocks.mockClear();
});

describe("MessageRow code copy accessibility action", () => {
  it("offers Copy code for a bot reply with one block and dispatches its exact text", () => {
    const code = "const a = 1;\n\n  return a;";
    const menu = messageMenu("bot", [code]);
    expect(mocks.markdownCodeBlocks).toHaveBeenCalledWith(menu.text);
    expect(menu.accessibilityActions).toContainEqual({ name: "copyCode", label: "Copy code" });
    menu.run("copyCode");
    expect(mocks.setStringAsync).toHaveBeenCalledExactlyOnceWith(code);
  });

  it.each([
    ["bot", ["first", "second"]],
    ["bot", []],
    ["user", ["first"]],
  ] as const)("omits Copy code for %s with %j", (role, blocks) => {
    const menu = messageMenu(role, [...blocks]);
    expect(menu.accessibilityActions.some((action) => action.name === "copyCode")).toBe(false);
    menu.run("copyCode");
    expect(mocks.setStringAsync).not.toHaveBeenCalled();
    if (role === "user") expect(mocks.markdownCodeBlocks).not.toHaveBeenCalled();
  });
});

it("hides the completed unread action while preserving code copy", () => {
  const available = messageMenu("bot", ["example"]);
  expect(available.accessibilityActions).toContainEqual({
    name: "unread",
    label: "Mark as unread",
  });
  const completed = messageMenu("bot", ["example"], true);
  expect(completed.accessibilityActions.some((action) => action.name === "unread")).toBe(false);
  expect(completed.accessibilityActions).toContainEqual({ name: "copyCode", label: "Copy code" });
});
