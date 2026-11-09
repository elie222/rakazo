import { Share } from "react-native";

export const messageMenuSymbols = [
  "reply",
  "copy",
  "share",
  "react",
  "quote",
  "speak",
  "select",
  "unread",
] as const;

export type MessageMenuSymbol = (typeof messageMenuSymbols)[number];

/** Opens the system share sheet for a message's plain text. */
export function shareMessageText(text: string): void {
  if (!text.trim()) return;
  void Share.share({ message: text }).catch(() => undefined);
}

export type MessageMenuEntry = {
  id: string;
  title: string;
  symbol?: MessageMenuSymbol;
  displayInline?: boolean;
  subactions?: MessageMenuEntry[];
};

const reactionPrefix = "reaction:";

export function messageMenuReactionId(reaction: string): string {
  return `${reactionPrefix}${reaction}`;
}

export function messageMenuReaction(id: string): string | null {
  return id.startsWith(reactionPrefix) ? id.slice(reactionPrefix.length) : null;
}

export function buildMessageContextMenu({
  labels,
  reactions,
  include,
}: {
  labels: Record<MessageMenuSymbol, string>;
  reactions: readonly string[];
  include: {
    reply?: boolean;
    quote: boolean;
    react: boolean;
    speak: boolean;
    select: boolean;
    unread?: boolean;
    share?: boolean;
  };
}): MessageMenuEntry[] {
  const secondary: MessageMenuEntry[] = [
    ...(include.quote ? [entry("quote", labels.quote)] : []),
    ...(include.speak ? [entry("speak", labels.speak)] : []),
    ...(include.select ? [entry("select", labels.select)] : []),
  ];
  return [
    ...(include.reply !== false ? [entry("reply", labels.reply)] : []),
    ...(include.unread ? [entry("unread", labels.unread)] : []),
    entry("copy", labels.copy),
    ...(include.share !== false ? [entry("share", labels.share)] : []),
    ...(include.react
      ? [
          {
            ...entry("react", labels.react),
            subactions: reactions.map((reaction) => ({
              id: messageMenuReactionId(reaction),
              title: reaction,
            })),
          },
        ]
      : []),
    ...(secondary.length > 0
      ? [
          {
            id: "secondary",
            title: "",
            displayInline: true,
            subactions: secondary,
          },
        ]
      : []),
  ];
}

function entry(symbol: MessageMenuSymbol, title: string): MessageMenuEntry {
  return { id: symbol, title, symbol };
}
