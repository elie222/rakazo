import type { SpaceBot } from "@rakazo/contracts";
import { Text, View } from "react-native";
import type { MobileBot } from "../lib/mobile-types";
import { useThemedStyles } from "../lib/native";
import { ChatTitleAvatar } from "./chat-title-avatar";
import { ChatTitleLabel } from "./chat-title-label";
import { createThreadHeaderStyles } from "./thread-header-styles";

/**
 * The chat's big title avatar. The native title bar's height is fixed by the OS, and an
 * overflowing title view is clipped on Android, so the 80pt-plus avatar cannot live inside
 * the bar: the bar keeps its 34pt capsule and the title area grows downward instead, with
 * the avatar big and centered at the top of the chat, as in the mockup. It floats above
 * the messages and never scrolls away; the capsule stays as the title when scrolled.
 */
export const CHAT_TITLE_HERO_AVATAR_SIZE = 88;

/**
 * A one-to-one chat's title at the top of its messages: the big state-linked avatar beside
 * its name, with what the bot is doing under it while it works. Display only; the title
 * capsule in the bar opens the profile.
 */
export function ChatTitleHero({
  bot,
  status,
  composing,
  name,
  activityLine,
}: {
  bot: MobileBot | SpaceBot | undefined;
  status: string | undefined;
  composing: boolean;
  name: string | undefined;
  /** What the bot is doing right now, shown under its name while it works. */
  activityLine?: string | null;
}) {
  const styles = useThemedStyles(createThreadHeaderStyles);
  return (
    <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 16, paddingHorizontal: 16 }}>
      <ChatTitleAvatar
        bot={bot}
        status={status}
        composing={composing}
        size={CHAT_TITLE_HERO_AVATAR_SIZE}
      />
      <ChatTitleLabel label={name ?? ""} placeholder={!name} style={styles.title} />
      {activityLine ? (
        <Text key={activityLine} numberOfLines={1} style={styles.subtitle}>
          {activityLine}
        </Text>
      ) : null}
    </View>
  );
}
