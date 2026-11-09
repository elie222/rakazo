// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(async (_text: string) => true),
  share: vi.fn(async (_args: unknown) => ({})),
  symbols: [] as { ios: string; android: string; size: number }[],
  markdownCodeBlocks: vi.fn((_markdown: string): string[] => []),
  reducedMotion: false,
  stopVoicePlayback: vi.fn(),
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const styleData = (style: unknown) =>
    JSON.stringify(typeof style === "function" ? style({ pressed: false }) : style);
  return {
    ActionSheetIOS: {},
    Alert: { alert: vi.fn() },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Share: { share: mocks.share },
    View: ({ children, style }: { children?: unknown; style?: unknown }) =>
      createElement("div", { "data-style": styleData(style) }, children as never),
    Text: ({ children, style }: { children?: unknown; style?: unknown }) =>
      createElement("span", { "data-style": styleData(style) }, children as never),
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityRole,
      style,
    }: {
      children?: unknown;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      style?: unknown;
    }) =>
      createElement(
        "button",
        {
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          "data-style": styleData(style),
          onClick: onPress,
        },
        children as never,
      ),
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      flatten: (styles: unknown) => (Array.isArray(styles) ? Object.assign({}, ...styles) : styles),
      hairlineWidth: 1,
    },
  };
});
vi.mock("react-native-reanimated", async () => {
  const { createElement } = await import("react");
  return {
    default: {
      Text: "span",
      View: ({ children, style }: { children?: unknown; style?: unknown }) =>
        createElement("div", { "data-animated": "true", style: style as never }, children as never),
    },
    useReducedMotion: () => mocks.reducedMotion,
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    withRepeat: (value: unknown) => value,
    withSequence: (...values: unknown[]) => values[0],
    withTiming: (value: unknown) => value,
    cancelAnimation: () => undefined,
    ZoomIn: { duration: () => ({ withInitialValues: () => ({}) }) },
  };
});
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.setStringAsync }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("./voice", () => ({ stopVoicePlayback: mocks.stopVoicePlayback }));
vi.mock("@rakazo/chat-ui/native", () => ({ markdownCodeBlocks: mocks.markdownCodeBlocks }));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    background: "#fff",
    foreground: "#000",
    muted: "#f2f2f1",
    mutedForeground: "#666",
    accent: "#eee",
    link: "#0c64c1",
  }),
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
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, android, size }: { ios: string; android: string; size: number }) => {
    mocks.symbols.push({ ios, android, size });
    return null;
  },
}));
vi.mock("../components/thread/message-bubble", () => ({
  MessageBubble: () => null,
}));

import { MessageRow } from "../components/thread/message-row";

type RowProps = ComponentProps<typeof MessageRow>;

const roots: Root[] = [];

function renderRow({
  role = "bot",
  id = "m1",
  readOnly = false,
  speaking = false,
  favorited = false,
}: {
  role?: "bot" | "user";
  id?: string;
  readOnly?: boolean;
  speaking?: boolean;
  favorited?: boolean;
} = {}) {
  const actions = {
    speak: vi.fn(),
    react: vi.fn(async (_message: unknown, _reaction: unknown) => true),
    favorite: vi.fn(),
    regenerate: vi.fn(),
    reply: vi.fn(),
    quote: vi.fn(),
    select: vi.fn(),
    markUnread: vi.fn(),
    answer: vi.fn(async () => undefined),
    openBot: vi.fn(),
    openComputer: vi.fn(),
    previewFile: vi.fn(),
    previewImage: vi.fn(),
    jump: vi.fn(),
    dismissChoice: vi.fn(),
    openPeerChat: vi.fn(),
    layout: vi.fn(),
    helperToggle: vi.fn(),
  };
  const message = {
    id,
    role,
    createdAt: "2026-01-01T00:00:00.000Z",
    blocks: [{ kind: "text", text: "Hello world" }],
  };
  const props = {
    message,
    actions,
    bubbleBotId: "bot-1",
    showBotSenderName: false,
    bots: [],
    readOnly,
    onCall: false,
    canAnswer: false,
    canDismiss: false,
    highlighted: false,
    separator: false,
    headerAdjacent: false,
    unreadDivider: false,
    markedUnread: false,
    replyAuthor: "",
    waitingForUser: false,
    speaking,
    favorited,
    inGroup: false,
    columnWidth: 400,
    enableJump: false,
    index: 0,
  } as unknown as RowProps;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(MessageRow, props));
  });
  return {
    container,
    root,
    actions,
    message,
    rerender: (next: { speaking: boolean }) =>
      act(() => {
        root.render(createElement(MessageRow, { ...props, speaking: next.speaking }));
      }),
  };
}

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")] as HTMLButtonElement[];
}

function labels(container: HTMLElement): (string | null)[] {
  return buttons(container).map((button) => button.getAttribute("aria-label"));
}

function click(button: HTMLButtonElement): Promise<void> {
  return act(async () => {
    button.click();
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.reducedMotion = false;
  mocks.setStringAsync.mockClear();
  mocks.share.mockClear();
  mocks.stopVoicePlayback.mockClear();
  mocks.symbols.length = 0;
  mocks.markdownCodeBlocks.mockClear();
});

describe("MessageRow action row", () => {
  it("shows the five v12 buttons in order under a bot reply", () => {
    const { container } = renderRow();
    expect(labels(container)).toEqual(["Copy", "Speak message", "Share", "Favorite", "Regenerate"]);
  });

  it("lays the row out as the mockup does: 36×36 tiles, 6pt apart, regenerate pushed right", () => {
    const { container } = renderRow();
    const row = buttons(container)[0]!.parentElement!;
    const rowStyle = JSON.parse(row.getAttribute("data-style") ?? "{}");
    expect(rowStyle).toMatchObject({
      flexDirection: "row",
      gap: 6,
      marginTop: 10,
      marginBottom: 20,
    });
    // Four tiles, a flex spacer, then the regenerate tile.
    expect(row.children).toHaveLength(6);
    expect(
      JSON.parse((row.children[4] as HTMLElement).getAttribute("data-style") ?? "{}"),
    ).toMatchObject({ flex: 1 });
    for (const button of buttons(container)) {
      const style = JSON.parse(button.getAttribute("data-style") ?? "{}");
      expect(style).toMatchObject({ width: 36, height: 36, borderRadius: 10 });
    }
    expect(mocks.symbols).toEqual([
      { ios: "doc.on.doc", android: "copy-outline", size: 19 },
      { ios: "speaker.wave.2", android: "volume-high-outline", size: 19 },
      { ios: "paperplane", android: "paper-plane-outline", size: 19 },
      { ios: "bookmark", android: "bookmark-outline", size: 19 },
      { ios: "arrow.clockwise", android: "refresh-outline", size: 19 },
    ]);
  });

  it("copies the message text", async () => {
    const { container } = renderRow();
    await click(buttons(container)[0]!);
    expect(mocks.setStringAsync).toHaveBeenCalledExactlyOnceWith("Hello world");
  });

  it("reads the message aloud", async () => {
    const { container, actions, message } = renderRow();
    await click(buttons(container)[1]!);
    expect(actions.speak).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "m1" }));
    expect(message).toMatchObject({ id: "m1" });
  });

  it("favorites through the favorite action", async () => {
    const { container, actions } = renderRow();
    await click(buttons(container)[3]!);
    expect(actions.favorite).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "m1" }));
  });

  it("fills the bookmark tile for a favorited reply", () => {
    const { container } = renderRow({ favorited: true });
    expect(labels(container)).toContain("Unfavorite");
    expect(mocks.symbols).toContainEqual({ ios: "bookmark.fill", android: "bookmark", size: 19 });
    const favoriteButton = buttons(container).find(
      (button) => button.getAttribute("aria-label") === "Unfavorite",
    )!;
    const style = JSON.parse(favoriteButton.getAttribute("data-style") ?? "{}");
    expect(style).toMatchObject({ backgroundColor: "#2f6bff" });
  });

  it("stops playback instead of speaking again while the reply is speaking", async () => {
    const { container, actions } = renderRow({ speaking: true });
    await click(buttons(container)[1]!);
    expect(mocks.stopVoicePlayback).toHaveBeenCalledTimes(1);
    expect(actions.speak).not.toHaveBeenCalled();
  });

  it("shares the message text", async () => {
    const { container } = renderRow();
    await click(buttons(container)[2]!);
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith({ message: "Hello world" });
  });

  it("regenerates the reply", async () => {
    const { container, actions } = renderRow();
    await click(buttons(container)[4]!);
    expect(actions.regenerate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "m1" }),
    );
  });

  it("shows no action row for user messages or in-progress replies", () => {
    expect(labels(renderRow({ role: "user" }).container)).toEqual([]);
    expect(labels(renderRow({ id: "progress:1" }).container)).toEqual([]);
  });

  it("keeps copy, speak, share and favorite in read-only history without regenerate", () => {
    const { container } = renderRow({ readOnly: true });
    expect(labels(container)).toEqual(["Copy", "Speak message", "Share", "Favorite"]);
  });

  it("pulses only the speaking message's speaker icon", () => {
    const { container } = renderRow({ speaking: true });
    const speakButton = buttons(container).find(
      (button) => button.getAttribute("aria-label") === "Speak message",
    )!;
    expect(speakButton.querySelector("[data-animated]")).not.toBeNull();
    for (const button of buttons(container)) {
      if (button === speakButton) continue;
      expect(button.querySelector("[data-animated]")).toBeNull();
    }
  });

  it("leaves the speaker icon static when nothing is speaking", () => {
    const { container } = renderRow();
    expect(container.querySelector("[data-animated]")).toBeNull();
  });

  it("stops the pulse when the message stops speaking", () => {
    const { container, rerender } = renderRow({ speaking: true });
    expect(container.querySelector("[data-animated]")).not.toBeNull();
    rerender({ speaking: false });
    expect(container.querySelector("[data-animated]")).toBeNull();
  });

  it("leaves the speaker icon static under reduced motion while speaking", () => {
    mocks.reducedMotion = true;
    const { container } = renderRow({ speaking: true });
    expect(container.querySelector("[data-animated]")).toBeNull();
  });
});
