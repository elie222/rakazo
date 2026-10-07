export const messageMenuSymbols = ["reply", "copy", "react", "quote", "speak", "select"] as const;

export type MessageMenuSymbol = (typeof messageMenuSymbols)[number];

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
  include: { quote: boolean; react: boolean; speak: boolean; select: boolean };
}): MessageMenuEntry[] {
  const secondary: MessageMenuEntry[] = [
    ...(include.quote ? [entry("quote", labels.quote)] : []),
    ...(include.speak ? [entry("speak", labels.speak)] : []),
    ...(include.select ? [entry("select", labels.select)] : []),
  ];
  return [
    entry("reply", labels.reply),
    entry("copy", labels.copy),
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
