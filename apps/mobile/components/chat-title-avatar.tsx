import type { SpaceBot } from "@rakazo/contracts";
import { StyleSheet, View } from "react-native";
import type { MobileBot } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";

/** The avatar in a one-to-one chat's title capsule. */
export const CHAT_TITLE_AVATAR_SIZE = 28;

function createChatTitleAvatarStyles() {
  const size = CHAT_TITLE_AVATAR_SIZE;
  return StyleSheet.create({
    placeholder: {
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: mobileTokens().secondary,
    },
  });
}

/**
 * The bot's avatar in a chat title. While the bot isn't known yet a plain circle holds the
 * avatar's place, so the capsule has its final width from the first frame of the push.
 */
export function ChatTitleAvatar({
  bot,
  status,
  composing,
}: {
  bot: MobileBot | SpaceBot | undefined;
  status: string | undefined;
  composing: boolean;
}) {
  const styles = useThemedStyles(createChatTitleAvatarStyles);
  if (!bot) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.placeholder}
      />
    );
  }
  return (
    <BotAvatar
      color={bot.color}
      avatarSet={bot.avatarSet}
      identity={bot.id}
      size={CHAT_TITLE_AVATAR_SIZE}
      status={status}
      composing={composing}
      muted={bot.notifyOnFinish === false}
    />
  );
}
