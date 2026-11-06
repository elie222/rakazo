// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act, createContext } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileMessage } from "./api";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const element =
    (tag: string) =>
    ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      createElement(tag, { onClick: onPress }, children);
  return {
    Alert: { alert: vi.fn() },
    Appearance: { getColorScheme: () => "light", addChangeListener: () => ({ remove() {} }) },
    Linking: { openURL: vi.fn() },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Pressable: element("button"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element("span"),
    TextInput: () => createElement("input"),
    View: element("div"),
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 1, fontScale: 1 }),
  };
});

vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return {
    default: { View },
    useAnimatedStyle: (style: () => unknown) => style(),
    useReducedMotion: () => true,
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => value,
  };
});
vi.mock("expo-secure-store", () => ({}));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./artifact-open", () => ({ openMobileArtifact: vi.fn() }));
vi.mock("./native", () => ({
  native: { fill: "fill" },
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("@rakazo/chat-ui/native", () => ({
  MarkdownLongPressContext: createContext(undefined),
  ChatMarkdown: ({ children }: { children: string }) => <p>{children}</p>,
  withBlockMentions: <T,>(blocks: T) => blocks,
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
// Cards this file doesn't exercise; each has its own tests.
vi.mock("../components/message-caption", () => ({ MessageCaption: () => null }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/AppConnectCard", () => ({ AppConnectCard: () => null }));
vi.mock("../components/audio-attachment", () => ({ AudioAttachment: () => null }));
vi.mock("../components/ChoiceCard", () => ({ ChoiceCard: () => null }));
vi.mock("../components/ComputerCard", () => ({ ComputerCard: () => null }));
vi.mock("../components/pages/page-card", () => ({ PageCard: () => null }));
vi.mock("../components/thread/mcp-app-card", () => ({ McpAppCard: () => null }));
vi.mock("../components/inline-image-attachment", () => ({ InlineImageAttachment: () => null }));
vi.mock("../components/secret-ask-sheet", () => ({ SecretAskSheet: () => null }));
vi.mock("../components/vault-item-editor", () => ({ VaultItemEditor: () => null }));

import { MessageBubble } from "../components/thread/message-bubble";

type BubbleProps = ComponentProps<typeof MessageBubble>;

const approval: MobileMessage = {
  id: "message-1",
  role: "bot",
  runId: "run-1",
  blocks: [
    {
      kind: "ask",
      text: "Review before web_fetch",
      approvalEffectId: "effect-1",
      site: "example.net",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
    },
  ],
} as MobileMessage;

const question: MobileMessage = {
  id: "message-2",
  role: "bot",
  runId: "run-1",
  blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
} as MobileMessage;

describe("another member's card in a shared space", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  function render(props: Partial<BubbleProps> & Pick<BubbleProps, "message" | "canAnswer">) {
    act(() =>
      root.render(
        <MessageBubble
          botId="bot-1"
          bots={[]}
          showBotSenderName={false}
          canDismiss={false}
          onAnswer={async () => undefined}
          onOpenBot={() => undefined}
          onOpenComputer={() => undefined}
          onPreviewFile={() => undefined}
          onPreviewImage={() => undefined}
          onOpenPeerChat={() => undefined}
          actionProps={{}}
          {...props}
        />,
      ),
    );
  }

  const buttons = () => [...container.querySelectorAll("button")];

  it("keeps the approval's choices in place, disabled, and says who it waits on", () => {
    const onAnswer = vi.fn(async () => undefined);
    render({
      message: approval,
      canAnswer: false,
      waitingOn: { userId: "casey", name: "Casey" },
      onAnswer,
    });

    expect(buttons().map((button) => [button.textContent, button.disabled])).toEqual([
      ["Allow once", true],
      ["Always allow example.net", true],
      ["Deny", true],
    ]);
    expect(container.textContent).toContain("Waiting on Casey");
    expect(container.textContent).not.toContain("No longer active");
    act(() => buttons()[0]!.click());
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("says only the person who started it can answer when their name is not loaded", () => {
    render({ message: approval, canAnswer: false, waitingOn: { userId: "casey" } });
    expect(container.textContent).toContain("Only the person who started this can answer it");
    expect(buttons().every((button) => button.disabled)).toBe(true);
  });

  it("lets the run's own user answer as before", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render({ message: approval, canAnswer: true, onAnswer });

    expect(buttons().some((button) => button.disabled)).toBe(false);
    expect(container.textContent).not.toContain("Waiting on");
    await act(async () => buttons()[0]!.click());
    expect(onAnswer).toHaveBeenCalledWith(approval, "allow");
  });

  it("says who a question waits on instead of offering an answer field", () => {
    render({ message: question, canAnswer: false, waitingOn: { userId: "casey", name: "Casey" } });
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("Waiting on Casey");
    expect(container.textContent).not.toContain("Waiting for this bot’s response.");
  });

  it("still reads No longer active for a card nobody can answer", () => {
    render({ message: approval, canAnswer: false });
    expect(buttons()).toHaveLength(0);
    expect(container.textContent).toContain("No longer active");
  });
});
