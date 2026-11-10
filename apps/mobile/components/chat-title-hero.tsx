import type { SpaceBot } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { Pressable, View } from "react-native";
import { customTitleTextStyle, scaledLineHeight, useCustomSettings } from "../lib/custom-settings";
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

/** Bottom padding under the avatar/name. */
const CHAT_TITLE_HERO_PADDING_BOTTOM = 16;
/** One line of the bot's name (typeScale.cardTitle lineHeight). */
const CHAT_TITLE_HERO_NAME_LINE_HEIGHT = typeScale.cardTitle.lineHeight;

/**
 * The hero's full height: avatar + one name line + bottom padding. The thread
 * screen always reserves this much top clearance for the list, so the list's
 * oldest message never drifts into the hero area. The height is a layout
 * constant, never measured, so the clearance and the hero can never disagree
 * and leave a gap for the conversation to show through.
 */
export const CHAT_TITLE_HERO_MAX_HEIGHT =
  CHAT_TITLE_HERO_AVATAR_SIZE + CHAT_TITLE_HERO_NAME_LINE_HEIGHT + CHAT_TITLE_HERO_PADDING_BOTTOM;

/**
 * The hero's height at a title font size: the name line grows with the title
 * slot, so the thread screen's top clearance must grow with it.
 */
export function chatTitleHeroHeight(titleFontSize: number): number {
  return (
    CHAT_TITLE_HERO_AVATAR_SIZE + scaledLineHeight(titleFontSize) + CHAT_TITLE_HERO_PADDING_BOTTOM
  );
}

/**
 * A one-to-one chat's title at the top of its messages: the big state-linked avatar with
 * its name under it. Solid background (the thread screen paints it), never transparent:
 * a see-through hero lets the scrolling conversation show through above the avatar.
 * No live process line here — the top bar shows no real-time process. Tapping the avatar
 * opens the bot menu.
 */
export function ChatTitleHero({
  bot,
  status,
  composing,
  name,
  onAvatarPress,
  userId,
}: {
  bot: MobileBot | SpaceBot | undefined;
  status: string | undefined;
  composing: boolean;
  name: string | undefined;
  /** Opens the bot menu. */
  onAvatarPress?: () => void;
  /** The account whose interface settings style the name. */
  userId?: string;
}) {
  const styles = useThemedStyles(createThreadHeaderStyles);
  const customSettings = useCustomSettings(userId ?? "");
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
      <ChatTitleLabel
        label={name ?? ""}
        placeholder={!name}
        style={[styles.title, customTitleTextStyle(customSettings)]}
      />
    </View>
  );
}
