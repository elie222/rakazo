// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api";

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
  ChatMarkdown: () => null,
  plainTextLinkParts: (text: string) => [{ type: "text", value: text }],
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
vi.mock("../components/inline-image-attachment", () => ({ InlineImageAttachment: () => null }));
vi.mock("../components/instruction-undo", () => ({ InstructionUndo: () => null }));
vi.mock("../components/McpApprovalCard", () => ({ McpApprovalCard: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));

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
      onPreviewMarkdown={() => undefined}
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
