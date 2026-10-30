import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import { Text, useWindowDimensions, View } from "react-native";
import type { UserMentionTarget } from "../lib/message-mentions";
import { BotAvatar } from "./bot-avatar";
import { NativeSymbol } from "./native-symbol";

const AVATAR_SIZE = 15;
const AVATAR_GAP = 4;
/** An inline view sits on the baseline; this lowers it to centre on the capitals. */
const AVATAR_DROP = 3;

/**
 * A bot named in a sent message: a small avatar and the name in medium weight, in the text colour
 * the bubble gives it. Tapping a bot opens its chat.
 */
export function UserMention({
  target,
  label,
  color,
  onOpenBot,
}: {
  target: UserMentionTarget;
  label: string;
  color: string;
  onOpenBot: (botId: string, name: string) => void;
}) {
  const { fontScale } = useWindowDimensions();
  // Inline views do not follow Dynamic Type, so the avatar scales with the text up to the cap.
  const scale = Math.min(fontScale, MAX_FONT_SCALE);
  const size = AVATAR_SIZE * scale;
  const bot = target.kind === "bot" ? target : null;
  return (
    <Text
      accessibilityRole={bot ? "link" : undefined}
      onPress={bot ? () => onOpenBot(bot.id, bot.name) : undefined}
      style={{ fontWeight: "500" }}
    >
      <View
        style={{
          width: size + AVATAR_GAP * scale,
          height: size,
          transform: [{ translateY: AVATAR_DROP * scale }],
        }}
      >
        {bot ? (
          <BotAvatar color={bot.color} avatarSet={bot.avatarSet} identity={bot.id} size={size} />
        ) : (
          <NativeSymbol ios="person.3" android="people-outline" size={size} color={color} />
        )}
      </View>
      {label}
    </Text>
  );
}
