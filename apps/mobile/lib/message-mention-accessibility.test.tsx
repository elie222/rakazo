// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act, createContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./mobile-types";

vi.mock("./haptics", () => ({
  hapticImpact: vi.fn(),
  hapticSelection: vi.fn(),
  hapticSuccess: vi.fn(),
}));

const surfaces = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
  Pressable: ({ children, ...props }: { children?: unknown }) => {
    surfaces.push(props);
    return <button type="button">{children as never}</button>;
  },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "span",
  TextInput: "input",
  View: "div",
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  useAnimatedStyle: (style: () => unknown) => style(),
  useReducedMotion: () => true,
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));

vi.mock("expo-secure-store", () => ({}));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./artifact-open", () => ({ openMobileArtifact: vi.fn() }));
vi.mock("./native", () => ({ native: {}, useResolvedAppearance: () => "dark" }));

vi.mock("@rakazo/chat-ui/native", () => ({
  MarkdownLongPressContext: createContext(undefined),
  ChatMarkdown: () => null,
  plainTextLinkParts: (text: string) => {
    let start = 0;
    return text
      .split(/(\[[^\]]*\]\(page:[^)]+\))/)
      .filter(Boolean)
      .map((piece) => {
        const page = piece.match(/^\[([^\]]*)\]\(page:([^)]+)\)$/);
        const part = page
          ? { type: "page", value: page[1], pageId: page[2] }
          : { type: "text", value: piece, start };
        start += piece.length;
        return part;
      });
  },
  withBlockMentions: <T,>(blocks: T) => blocks,
}));

vi.mock("../components/message-caption", () => ({
  MessageCaption: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../components/ComputerCard", () => ({
  ComputerCard: ({ onOpen }: { onOpen: () => void }) => {
    onOpen();
    return null;
  },
}));
// Cards this file doesn't exercise; each has its own tests.
vi.mock("../components/thread/ask-block", () => ({ AskBlock: () => null }));
vi.mock("../components/AskActions", () => ({ AskActions: () => null }));
vi.mock("../components/AppConnectCard", () => ({ AppConnectCard: () => null }));
vi.mock("../components/audio-attachment", () => ({ AudioAttachment: () => null }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/ChoiceCard", () => ({ ChoiceCard: () => null }));
vi.mock("../components/ImportSetupCard", () => ({ ImportSetupCard: () => null }));
vi.mock("../components/inline-image-attachment", () => ({ InlineImageAttachment: () => null }));
vi.mock("../components/instruction-undo", () => ({ InstructionUndo: () => null }));
vi.mock("../components/McpApprovalCard", () => ({ McpApprovalCard: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/pages/page-card", () => ({ PageCard: () => null }));
vi.mock("../components/thread/mcp-app-card", () => ({ McpAppCard: () => null }));

import { MessageBubble } from "../components/thread/message-bubble";

type BubbleProps = ComponentProps<typeof MessageBubble>;

function Bubble(props: Partial<BubbleProps> & Pick<BubbleProps, "message">) {
  return (
    <MessageBubble
      botId="bot-1"
      bots={[]}
      showBotSenderName={false}
      canAnswer={false}
      canDismiss={false}
      onAnswer={async () => undefined}
      onOpenBot={() => undefined}
      onOpenComputer={() => undefined}
      onPreviewFile={() => undefined}
      onPreviewImage={() => undefined}
      onOpenPeerChat={() => undefined}
      actionProps={{}}
      {...props}
    />
  );
}

type SurfaceProps = {
  accessible?: boolean;
  accessibilityActions?: { name: string; label?: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};

describe("bots named in a sent message", () => {
  let container: HTMLDivElement;
  const onOpenBot = vi.fn();
  const forwarded = vi.fn();
  const members = [
    { botId: "bot-ada", name: "Ada", color: "#112233" },
    { botId: "bot-ben", name: "Ben", color: "#445566" },
  ] as MobileSnapshot["members"];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    surfaces.length = 0;
    onOpenBot.mockClear();
    forwarded.mockClear();
    container = document.createElement("div");
    document.body.append(container);
  });
  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });
  function surface(text: string, role: "user" | "bot" = "user") {
    const root = createRoot(container);
    act(() =>
      root.render(
        <Bubble
          groupId="group"
          members={members}
          onOpenBot={onOpenBot}
          message={{ id: "message", role, blocks: [{ kind: "text", text }] }}
          actionProps={{
            accessibilityActions: [{ name: "reply", label: "Reply" }],
            onAccessibilityAction: forwarded,
          }}
        />,
      ),
    );
    act(() => root.unmount());
    return surfaces.find((props) => props.accessible) as SurfaceProps | undefined;
  }
  const action = (actionName: string) => ({ nativeEvent: { actionName } });

  it("offers each named bot as an action of the message, next to the message's own", () => {
    const props = surface("@Ada and @Ben, then @Ada again");
    expect(props!.accessibilityActions).toEqual([
      { name: "reply", label: "Reply" },
      { name: "open-bot:bot-ada", label: "Open Ada" },
      { name: "open-bot:bot-ben", label: "Open Ben" },
    ]);
  });

  it("opens the bot from its action and passes the other actions on", () => {
    const props = surface("hi @Ben");
    props!.onAccessibilityAction!(action("open-bot:bot-ben"));
    expect(onOpenBot).toHaveBeenCalledWith("bot-ben", "Ben");
    expect(forwarded).not.toHaveBeenCalled();
    props!.onAccessibilityAction!(action("reply"));
    expect(forwarded).toHaveBeenCalledOnce();
    expect(onOpenBot).toHaveBeenCalledOnce();
  });

  it("names no bot from a page link's title", () => {
    expect(surface("[@Ada notes](page:pg_1) for @Ben")!.accessibilityActions).toEqual([
      { name: "reply", label: "Reply" },
      { name: "open-bot:bot-ben", label: "Open Ben" },
    ]);
  });

  it("adds nothing when no bot is named or the message is not the user's", () => {
    expect(surface("no names here")!.accessibilityActions).toEqual([
      { name: "reply", label: "Reply" },
    ]);
    surfaces.length = 0;
    expect(surface("@Ada replied", "bot")!.accessibilityActions).toEqual([
      { name: "reply", label: "Reply" },
    ]);
  });
});

describe("bot authors after leaving a group", () => {
  const bots = [
    { id: "departed", name: "Ada" },
    { id: "remaining", name: "Ben" },
  ] as BubbleProps["bots"];
  const members = [{ botId: "remaining", name: "Ben" }] as MobileSnapshot["members"];

  function textFor(message: BubbleProps["message"], overrides: Partial<BubbleProps> = {}) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <Bubble
          groupId="group"
          botName="Project group"
          showBotSenderName
          bots={bots}
          members={members}
          message={message}
          {...overrides}
        />,
      ),
    );
    const text = container.textContent;
    act(() => root.unmount());
    vi.unstubAllGlobals();
    return text;
  }

  it.each([
    { blocks: [{ kind: "text", text: "Earlier reply" }] },
    {
      blocks: [
        {
          kind: "file",
          name: "notes.txt",
          artifactId: "artifact",
          mimeType: "text/plain",
          size: 5,
        },
      ],
    },
  ] satisfies { blocks: BubbleProps["message"]["blocks"] }[])(
    "keeps the departed author's name on %j",
    ({ blocks }) => {
      const text = textFor({ id: "message", role: "bot", botId: "departed", blocks });
      expect(text).toContain("Ada");
      expect(text).not.toContain("Project group");
    },
  );

  it("keeps both handoff names from the space roster", () => {
    const text = textFor(
      {
        id: "handoff",
        role: "bot",
        blocks: [{ kind: "handoff", fromBotId: "departed", toBotId: "remaining", text: "Review" }],
      },
      { members: [] },
    );
    expect(text).toContain("Ada messaged Ben");
  });

  it("prefers the current member's name to the roster", () => {
    expect(
      textFor(
        {
          id: "message",
          role: "bot",
          botId: "remaining",
          blocks: [{ kind: "text", text: "Reply" }],
        },
        { members: [{ botId: "remaining", name: "Updated Ben" }] as MobileSnapshot["members"] },
      ),
    ).toContain("Updated Ben");
  });

  it("does not add a sender header in a direct chat", () => {
    expect(
      textFor(
        {
          id: "message",
          role: "bot",
          botId: "departed",
          blocks: [{ kind: "text", text: "Reply" }],
        },
        { groupId: undefined, showBotSenderName: false },
      ),
    ).not.toContain("Ada");
  });
});
