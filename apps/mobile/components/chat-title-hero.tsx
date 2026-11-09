import type { SpaceBot } from "@rakazo/contracts";
import { Pressable, Text, View } from "react-native";
import type { MobileBot } from "../lib/mobile-types";
import { useThemedStyles } from "../lib/native";
import { ChatTitleAvatar } from "./chat-title-avatar";
import { ChatTitleLabel } from "./chat-title-label";
import { createThreadHeaderStyles } from "./thread-header-styles";

/**
 * The chat's big title avatar. The native title bar's height is fixed by the OS, and an
 * overflowing title view is clipped on Android, so the 80pt-plus avatar cannot live inside
 * the bar: the bar keeps its title without an avatar and the title area grows downward
 * instead, with the avatar big and centered at the top of the chat, as in the mockup. It
 * floats above the messages and never scrolls away; the capsule stays as the title when
 * scrolled. Tapping the avatar opens the bot menu.
 */
export const CHAT_TITLE_HERO_AVATAR_SIZE = 88;

/**
 * A one-to-one chat's title at the top of its messages: the big state-linked avatar beside
 * its name, with what the bot is doing under it while it works. Tapping the avatar opens
 * the bot menu; while a reply is being read aloud the subtitle says so instead.
 */
export function ChatTitleHero({
  bot,
  status,
  composing,
  name,
  activityLine,
  speakingLine,
  onAvatarPress,
}: {
  bot: MobileBot | SpaceBot | undefined;
  status: string | undefined;
  composing: boolean;
  name: string | undefined;
  /** What the bot is doing right now, shown under its name while it works. */
  activityLine?: string | null;
  /** While a reply is being read aloud, shown instead of the activity line. */
  speakingLine?: string;
  /** Opens the bot menu. */
  onAvatarPress?: () => void;
}) {
  const styles = useThemedStyles(createThreadHeaderStyles);
  const subtitle = speakingLine ?? activityLine;
  return (
    <View style={{ alignItems: "center", paddingTop: 0, paddingBottom: 16, paddingHorizontal: 16 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={name ?? ""}
        disabled={!onAvatarPress}
        onPress={onAvatarPress}
      >
        <ChatTitleAvatar
          bot={bot}
          status={status}
          composing={composing}
          size={CHAT_TITLE_HERO_AVATAR_SIZE}
        />
      </Pressable>
      <ChatTitleLabel label={name ?? ""} placeholder={!name} style={styles.title} />
      {subtitle ? (
        <Text key={subtitle} numberOfLines={1} style={styles.subtitle}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
