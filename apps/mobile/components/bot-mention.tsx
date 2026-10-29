import type { BotAvatarSet } from "@rakazo/contracts";
import type { ChildBotBlock } from "@rakazo/core";
import { resolvePersonaColorDef } from "@rakazo/core";
import type { ColorTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { MessageMentionsContext } from "../lib/message-mentions";
import { BotAvatar } from "./bot-avatar";
import { NativeSymbol } from "./native-symbol";

const ICON_SIZE = 16;

/** A bot named inline in its color. A deleted, archived, or missing bot keeps only its name. */
export function BotMention({
  block,
  color,
  avatarSet,
  tokens,
  onOpenBot,
}: {
  block: ChildBotBlock;
  color: string | undefined;
  avatarSet?: BotAvatarSet;
  tokens: ColorTokens;
  onOpenBot: (botId: string, name: string) => void;
}) {
  const live = block.status === "created" && color;
  return (
    <Text
      accessibilityRole={live ? "link" : undefined}
      onPress={live ? () => onOpenBot(block.botId, block.name) : undefined}
      style={{
        color: live ? resolvePersonaColorDef(block.botId, color).light : tokens.foreground,
        fontWeight: "500",
      }}
    >
      {/* An inline view sits on the baseline; this lowers it to centre on the capitals. */}
      <View style={{ width: ICON_SIZE + 5, height: ICON_SIZE, transform: [{ translateY: 3 }] }}>
        {live ? (
          <BotAvatar color={color} avatarSet={avatarSet} identity={block.botId} size={ICON_SIZE} />
        ) : (
          <NativeSymbol
            ios="person"
            android="person-outline"
            size={ICON_SIZE - 2}
            color={tokens.mutedForeground}
          />
        )}
      </View>
      {block.name}
    </Text>
  );
}

/** Lets a reply's text name the bots it announces. */
export function MessageMentions({
  mentions,
  colorOf,
  avatarSetOf,
  tokens,
  onOpenBot,
  children,
}: {
  mentions: readonly ChildBotBlock[];
  colorOf: (botId: string) => string | undefined;
  avatarSetOf?: (botId: string) => BotAvatarSet | undefined;
  tokens: ColorTokens;
  onOpenBot: (botId: string, name: string) => void;
  children: ReactNode;
}) {
  const render = (id: string) => {
    const block = mentions.find((mention) => mention.botId === id);
    return block ? (
      <BotMention
        block={block}
        color={colorOf(id)}
        avatarSet={avatarSetOf?.(id)}
        tokens={tokens}
        onOpenBot={onOpenBot}
      />
    ) : undefined;
  };
  return (
    <MessageMentionsContext.Provider value={render}>{children}</MessageMentionsContext.Provider>
  );
}
