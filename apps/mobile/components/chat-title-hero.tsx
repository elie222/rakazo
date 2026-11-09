import type { SpaceBot } from "@rakazo/contracts";
import { Pressable, Text, View } from "react-native";
import type { MobileBot } from "../lib/mobile-types";
import { useThemedStyles } from "../lib/native";
import { ChatTitleAvatar } from "./chat-title-avatar";
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

/** Bottom padding under the avatar/subtitle. */
const CHAT_TITLE_HERO_PADDING_BOTTOM = 16;
/** Gap between the avatar and the subtitle line, as in the mockup. */
const CHAT_TITLE_HERO_SUBTITLE_GAP = 7;
/** One line of caption text (typeScale.caption lineHeight). */
const CHAT_TITLE_HERO_SUBTITLE_LINE_HEIGHT = 18;

/**
 * The hero's full height: avatar + subtitle gap + one subtitle line + bottom padding. The
 * thread screen always reserves this much top clearance for the list, subtitle or not, so
 * the list's oldest message never drifts into the hero area when the subtitle appears or
 * disappears. The height is a layout constant, never measured, so the clearance and the
 * hero can never disagree and leave a gap for the conversation to show through.
 */
export const CHAT_TITLE_HERO_MAX_HEIGHT =
  CHAT_TITLE_HERO_AVATAR_SIZE +
  CHAT_TITLE_HERO_SUBTITLE_GAP +
  CHAT_TITLE_HERO_SUBTITLE_LINE_HEIGHT +
  CHAT_TITLE_HERO_PADDING_BOTTOM;

/**
 * A one-to-one chat's title at the top of its messages: the big state-linked avatar with
 * what the bot is doing under it while it works. Hollowed out: no name row, no background
 * box, just the circular avatar and one process line floating over the chat. Tapping the
 * avatar opens the bot menu; while a reply is being read aloud the subtitle says so instead.
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
  /** What the bot is doing right now, shown under the avatar while it works. */
  activityLine?: string | null;
  /** While a reply is being read aloud, shown instead of the activity line. */
  speakingLine?: string;
  /** Opens the bot menu. */
  onAvatarPress?: () => void;
}) {
  const styles = useThemedStyles(createThreadHeaderStyles);
  const subtitle = speakingLine ?? activityLine;
  return (
    <View
      style={{
        alignItems: "center",
        paddingTop: 0,
        paddingBottom: CHAT_TITLE_HERO_PADDING_BOTTOM,
        paddingHorizontal: 16,
      }}
    >
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
      {subtitle ? (
        <Text
          key={subtitle}
          numberOfLines={1}
          style={[styles.subtitle, { marginTop: CHAT_TITLE_HERO_SUBTITLE_GAP }]}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
