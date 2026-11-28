import { t } from "@lingui/core/macro";
import type { ImperativeRouter, NativeStackNavigationOptions } from "expo-router";
import { Pressable, View } from "react-native";
import { iosAtLeast } from "../../../lib/native/native-controls";
import { NativeSymbol } from "../../native/native-symbol";

export function openInvite(router: ImperativeRouter) {
  router.push("/invite");
}

type HeaderAction = {
  label: string;
  sfSymbol: "gearshape" | "phone" | "gift";
  android: "settings-outline" | "call-outline" | "gift-outline";
  onPress: () => void;
};

/**
 * A chat header's right side: the group's settings button in a group; in a bot chat, Call (as on
 * desktop) and the invite gift when the account can invite. The bot's own actions live in its
 * profile, which the title opens. The chat route declares it when the screen is created, so the
 * title is centred against it from the first frame; both use this one builder so the items never
 * change shape.
 */
export function threadHeaderRight({
  inGroup,
  readOnly,
  color,
  onGroupSettings,
  onCall,
  onInvite,
}: {
  inGroup: boolean;
  readOnly: boolean;
  color: string;
  onGroupSettings: () => void;
  /** Rings the bot; absent in a group. */
  onCall?: () => void;
  /** Opens the invite sheet; absent when the account cannot invite. */
  onInvite?: () => void;
}): NativeStackNavigationOptions {
  const actions: HeaderAction[] = [];
  if (inGroup) {
    actions.push({
      label: t`Group settings`,
      sfSymbol: "gearshape",
      android: "settings-outline",
      onPress: onGroupSettings,
    });
  } else {
    if (onCall)
      actions.push({ label: t`Call`, sfSymbol: "phone", android: "call-outline", onPress: onCall });
    if (onInvite)
      actions.push({
        label: t`Invite a friend`,
        sfSymbol: "gift",
        android: "gift-outline",
        onPress: onInvite,
      });
  }
  // Undefined, not an empty list, so an older iOS header keeps a Restore button set elsewhere.
  if (readOnly || actions.length === 0)
    return { headerRight: undefined, unstable_headerRightItems: undefined };
  return {
    ...(iosAtLeast(26)
      ? {
          unstable_headerRightItems: () =>
            actions.map((action) => ({
              type: "button" as const,
              label: action.label,
              accessibilityLabel: action.label,
              icon: { type: "sfSymbol" as const, name: action.sfSymbol },
              onPress: action.onPress,
            })),
        }
      : { unstable_headerRightItems: undefined }),
    headerRight: () => (
      <View style={{ flexDirection: "row", gap: 18 }}>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            hitSlop={8}
            onPress={action.onPress}
          >
            <NativeSymbol ios={action.sfSymbol} android={action.android} size={21} color={color} />
          </Pressable>
        ))}
      </View>
    ),
  };
}
