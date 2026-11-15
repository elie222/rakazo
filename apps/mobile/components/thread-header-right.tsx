import { t } from "@lingui/core/macro";
import type { NativeStackNavigationOptions } from "expo-router";
import { router } from "expo-router";
import { iosAtLeast } from "../lib/native-controls";
import { GlassIconButton } from "./glass-icon-button";
import { CHAT_HEADER_CONTROL_SIZE } from "./thread-header-styles";

export function openInvite() {
  router.push("/invite");
}

/**
 * A chat header's right side: the group's settings button in a group, the invite gift in a bot
 * chat when the account can invite. The bot's own actions live in its profile, which the title
 * opens. The chat route declares it when the screen is created, so the title is centred against
 * it from the first frame; both use this one builder so the item never changes shape.
 */
export function threadHeaderRight({
  inGroup,
  readOnly,
  color,
  onGroupSettings,
  onInvite,
}: {
  inGroup: boolean;
  readOnly: boolean;
  color: string;
  onGroupSettings: () => void;
  /** Opens the invite sheet; absent when the account cannot invite. */
  onInvite?: () => void;
}): NativeStackNavigationOptions {
  const label = inGroup ? t`Group settings` : t`Invite a friend`;
  const onPress = inGroup ? onGroupSettings : onInvite;
  // Undefined, not an empty list, so an older iOS header keeps a Restore button set elsewhere.
  if (readOnly || !onPress) return { headerRight: undefined, unstable_headerRightItems: undefined };
  return {
    ...(iosAtLeast(26)
      ? {
          unstable_headerRightItems: () => [
            {
              type: "button" as const,
              label,
              accessibilityLabel: label,
              icon: { type: "sfSymbol" as const, name: inGroup ? "gearshape" : "gift" },
              onPress,
            },
          ],
        }
      : { unstable_headerRightItems: undefined }),
    headerRight: () => (
      <GlassIconButton
        accessibilityLabel={label}
        onPress={onPress}
        ios={inGroup ? "gearshape" : "gift"}
        android={inGroup ? "settings-outline" : "gift-outline"}
        size={CHAT_HEADER_CONTROL_SIZE}
        color={color}
      />
    ),
  };
}
