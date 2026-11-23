import {
  continuedSenderMessageIds,
  resolvePersonaColorDef,
  shouldShowBotSenderName,
} from "@rakazo/core";
import { botColors, darkTokens } from "@rakazo/ui-tokens";
import type { ComponentProps } from "react";
import { createContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { MobileBot, MobileSnapshot } from "../../lib/api/mobile-types";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
  Pressable: "button",
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
vi.mock("../../lib/notifications/live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("../../lib/api/network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("../../lib/artifacts/artifact-open", () => ({ openMobileArtifact: vi.fn() }));
vi.mock("../../lib/native/native", () => ({ native: {}, useResolvedAppearance: () => "dark" }));

vi.mock("@rakazo/chat-ui/native", () => ({
  MarkdownLongPressContext: createContext(undefined),
  ChatMarkdown: () => null,
  withBlockMentions: <T,>(blocks: T) => blocks,
}));

vi.mock("../messages/message-caption", () => ({
  MessageCaption: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../../lib/pages/page-card", () => ({ PageCard: () => null }));
vi.mock("./mcp-app-card", () => ({ McpAppCard: () => null }));
vi.mock("../cards/ComputerCard", () => ({
  ComputerCard: ({ onOpen }: { onOpen: () => void }) => {
    onOpen();
    return null;
  },
}));
// Cards this file doesn't exercise; each has its own tests.
vi.mock("./ask-block", () => ({ AskBlock: () => null }));
vi.mock("../cards/AskActions", () => ({ AskActions: () => null }));
vi.mock("../cards/AppConnectCard", () => ({ AppConnectCard: () => null }));
vi.mock("./routine-event-row", () => ({ RoutineEventRows: () => null }));
vi.mock("../media/audio-attachment", () => ({ AudioAttachment: () => null }));
vi.mock("../bots/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../cards/ChoiceCard", () => ({ ChoiceCard: () => null }));
vi.mock("../cards/ImportSetupCard", () => ({ ImportSetupCard: () => null }));
vi.mock("../media/inline-image-attachment", () => ({ InlineImageAttachment: () => null }));
vi.mock("../cards/change-undo", () => ({
  ChangeUndo: () => null,
  isUndoableChange: () => false,
}));
vi.mock("../cards/McpApprovalCard", () => ({ McpApprovalCard: () => null }));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../native/native-action-button", () => ({ NativeActionButton: () => null }));

import { hasSenderLabelContent, MessageBubble } from "./message-bubble";

type BubbleProps = ComponentProps<typeof MessageBubble>;

it("keeps the sender label on a reply after an unlabeled question card", () => {
  const reply: BubbleProps["message"] = {
    id: "reply",
    role: "bot",
    botId: "bot-a",
    blocks: [{ kind: "text", text: "Here is the answer." }],
  };
  const questionBlocks: BubbleProps["message"]["blocks"] = [
    { kind: "ask", text: "Which one?" },
    { kind: "choice", question: "Which one?", options: [{ id: "yes", letter: "A", label: "Yes" }] },
  ];
  for (const block of questionBlocks) {
    const question = { ...reply, id: "question", blocks: [block] };
    const hidden = continuedSenderMessageIds(
      [
        { kind: "message", message: question },
        { kind: "message", message: reply },
      ],
      new Set(),
      null,
      hasSenderLabelContent,
    );
    const html = renderToStaticMarkup(
      <Bubble
        message={reply}
        botName="Sender"
        showBotSenderName
        hideSenderLabel={hidden.has(reply.id)}
      />,
    );
    expect(html).toContain(">Sender</span>");
  }
});

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

function contrastRatio(text: string, surface: string): number {
  const luminance = (hex: string) =>
    [1, 3, 5].reduce((sum, offset, i) => {
      const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return (
        sum +
        [0.2126, 0.7152, 0.0722][i]! * (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      );
    }, 0);
  return (luminance(text) + 0.05) / (luminance(surface) + 0.05);
}

it.each(["text", "image"] as const)("keeps per-bot sender colours on %s messages", (kind) => {
  for (const [index, color] of botColors.entries()) {
    const id = `bot-${index}`;
    const html = renderToStaticMarkup(
      <Bubble
        botId={id}
        groupId="group"
        showBotSenderName={true}
        bots={[{ id, color } as MobileBot]}
        members={[{ botId: id, name: "Sender" }] as MobileSnapshot["members"]}
        message={{
          id: "message",
          role: "bot",
          botId: id,
          blocks: [
            kind === "text"
              ? { kind, text: "Hello" }
              : { kind, name: "Picture", artifactId: "artifact-1", mimeType: "image/png" },
          ],
        }}
        actionProps={{}}
      />,
    );
    const senderColor = resolvePersonaColorDef(id, color).hex;
    expect(html).toContain(`color:${senderColor}`);
    for (const surface of [darkTokens.muted, darkTokens.background]) {
      expect(contrastRatio(senderColor, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(html).toContain(">Sender</span>");
  }
});

it.each(["text", "image"] as const)(
  "shows %s sender labels only when speakers need distinguishing",
  (kind) => {
    for (const { isGroup, speakerBotIds, expected } of [
      { isGroup: false, speakerBotIds: ["bot-a", "bot-a"], expected: false },
      { isGroup: true, speakerBotIds: ["bot-a"], expected: true },
      { isGroup: false, speakerBotIds: ["bot-a", "bot-b"], expected: true },
    ]) {
      const html = renderToStaticMarkup(
        <Bubble
          botId="bot-a"
          botName="Sender"
          bots={[]}
          groupId={isGroup ? "group" : undefined}
          showBotSenderName={shouldShowBotSenderName({ isGroup, speakerBotIds })}
          members={[{ botId: "bot-a", name: "Sender" }] as MobileSnapshot["members"]}
          message={{
            id: "message",
            role: "bot",
            botId: "bot-a",
            blocks: [
              kind === "text"
                ? { kind, text: "Hello" }
                : { kind, name: "Picture", artifactId: "artifact-1", mimeType: "image/png" },
            ],
          }}
          actionProps={{}}
        />,
      );
      expect(html.includes(">Sender</span>")).toBe(expected);
      if (!expected) expect(html).not.toContain("margin-bottom:4px");
    }
  },
);

it("keeps the bot name when opening a computer without a sender label", () => {
  const opened: string[][] = [];
  renderToStaticMarkup(
    <Bubble
      botId="bot-a"
      botName="Sender"
      bots={[]}
      showBotSenderName={false}
      message={{
        id: "message",
        role: "bot",
        botId: "bot-a",
        blocks: [{ kind: "computer", state: "ready", text: "" }],
      }}
      onOpenComputer={(...args) => opened.push(args)}
      actionProps={{}}
    />,
  );
  expect(opened).toEqual([["bot-a", "Sender"]]);
});

it.each(["text", "image"] as const)(
  "shows another person's %s message as received with their name",
  (kind) => {
    const render = (authorName?: string, hideSenderLabel = false) =>
      renderToStaticMarkup(
        <Bubble
          botId="bot-a"
          bots={[]}
          showBotSenderName={false}
          hideSenderLabel={hideSenderLabel}
          authorName={authorName}
          message={{
            id: "message",
            role: "user",
            blocks: [
              kind === "text"
                ? { kind, text: "Hello" }
                : { kind, artifactId: "picture", mimeType: "image/png", name: "Picture" },
            ],
          }}
          actionProps={{}}
        />,
      );
    const theirs = render("Ana");
    expect(theirs).toContain(">Ana</span>");
    expect(theirs).toContain(`background-color:${darkTokens.muted}`);
    expect(theirs).not.toContain(`background-color:${darkTokens.chatUser}`);

    const followUp = render("Ana", true);
    expect(followUp).not.toContain(">Ana</span>");
    if (kind === "text") expect(followUp).toContain(`background-color:${darkTokens.muted}`);
    expect(followUp).not.toContain(`background-color:${darkTokens.chatUser}`);

    const mine = render();
    expect(mine).not.toContain("Ana");
    expect(mine).not.toContain(`background-color:${darkTokens.muted}`);
    // An inline image of one's own carries no bubble at all.
    if (kind === "text") expect(mine).toContain(`background-color:${darkTokens.chatUser}`);
  },
);
