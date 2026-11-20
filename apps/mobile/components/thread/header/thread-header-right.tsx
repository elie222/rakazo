import { t } from "@lingui/core/macro";
import type { NativeStackNavigationOptions } from "expo-router";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { iosAtLeast } from "../../../lib/native/native-controls";
import { NativeSymbol } from "../../native/native-symbol";

export function openInvite() {
  router.push("/invite");
}

/**
 * A chat header's right side: the group's settings button in a group, the invite gift in a bot
 * chat when the account can invite, and beside it the bot chat's threads once it has any. The
 * bot's own actions live in its profile, which the title opens. The chat route declares it when
 * the screen is created, so the title is centred against it from the first frame; both use this
 * one builder so the items keep their shape.
 */
export function threadHeaderRight({
  inGroup,
  readOnly,
  color,
  onGroupSettings,
  onInvite,
  onThreads,
}: {
  inGroup: boolean;
  readOnly: boolean;
  color: string;
  onGroupSettings: () => void;
  /** Opens the invite sheet; absent when the account cannot invite. */
  onInvite?: () => void;
  /** Opens the bot chat's threads; absent until it has one. */
  onThreads?: () => void;
}): NativeStackNavigationOptions {
  const onPress = inGroup ? onGroupSettings : onInvite;
  const buttons = readOnly
    ? []
    : [
        // The first item sits furthest right.
        ...(onPress
          ? [
              {
                label: inGroup ? t`Group settings` : t`Invite a friend`,
                ios: inGroup ? ("gearshape" as const) : ("gift" as const),
                android: inGroup ? ("settings-outline" as const) : ("gift-outline" as const),
                onPress,
              },
            ]
          : []),
        ...(onThreads && !inGroup
          ? [
              {
                label: t`Threads`,
                ios: "bubble.left.and.bubble.right" as const,
                android: "chatbubbles-outline" as const,
                onPress: onThreads,
              },
            ]
          : []),
      ];
  // Undefined, not an empty list, so an older iOS header keeps a Restore button set elsewhere.
  if (!buttons.length) return { headerRight: undefined, unstable_headerRightItems: undefined };
  return {
    ...(iosAtLeast(26)
      ? {
          unstable_headerRightItems: () =>
            buttons.map((button) => ({
              type: "button" as const,
              label: button.label,
              accessibilityLabel: button.label,
              icon: { type: "sfSymbol" as const, name: button.ios },
              onPress: button.onPress,
            })),
        }
      : { unstable_headerRightItems: undefined }),
    headerRight: () => (
      <View style={{ flexDirection: "row-reverse", alignItems: "center", gap: 18 }}>
        {buttons.map((button) => (
          <Pressable
            key={button.ios}
            accessibilityRole="button"
            accessibilityLabel={button.label}
            hitSlop={8}
            onPress={button.onPress}
          >
            <NativeSymbol ios={button.ios} android={button.android} size={21} color={color} />
          </Pressable>
        ))}
      </View>
    ),
  };
}
