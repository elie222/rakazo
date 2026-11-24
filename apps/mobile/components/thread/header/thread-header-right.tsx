import { t } from "@lingui/core/macro";
import type { ImperativeRouter, NativeStackNavigationOptions } from "expo-router";
import { Pressable, View } from "react-native";
import { iosAtLeast } from "../../../lib/native/native-controls";
import { NativeSymbol } from "../../native/native-symbol";

export function openInvite(router: ImperativeRouter) {
  router.push("/invite");
}

/** Chat actions keep their shape from the route's first frame through the live header. */
export function threadHeaderRight({
  inGroup,
  readOnly,
  color,
  onGroupSettings,
  onInvite,
  onShowPins,
}: {
  inGroup: boolean;
  readOnly: boolean;
  color: string;
  onGroupSettings: () => void;
  onInvite?: () => void;
  onShowPins?: () => void;
}): NativeStackNavigationOptions {
  const chatAction = inGroup
    ? ({
        title: t`Group settings`,
        ios: "gearshape",
        android: "settings-outline",
        onPress: onGroupSettings,
      } as const)
    : onInvite
      ? ({
          title: t`Invite a friend`,
          ios: "gift",
          android: "gift-outline",
          onPress: onInvite,
        } as const)
      : null;
  const pinsAction = onShowPins
    ? ({
        title: t`Pinned messages`,
        ios: "pin",
        android: "pin-outline",
        onPress: onShowPins,
      } as const)
    : null;
  const actions = [chatAction, pinsAction].filter((action) => action !== null);
  if (readOnly || !actions.length) {
    return { headerRight: undefined, unstable_headerRightItems: undefined };
  }
  return {
    unstable_headerRightItems: iosAtLeast(26)
      ? () =>
          actions.map(({ title, ios, onPress }) => ({
            type: "button",
            label: title,
            accessibilityLabel: title,
            icon: { type: "sfSymbol", name: ios },
            onPress,
          }))
      : undefined,
    headerRight: () => (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        {actions.toReversed().map(({ title, ios, android, onPress }) => (
          <Pressable
            key={ios}
            accessibilityRole="button"
            accessibilityLabel={title}
            hitSlop={8}
            onPress={onPress}
          >
            <NativeSymbol ios={ios} android={android} size={21} color={color} />
          </Pressable>
        ))}
      </View>
    ),
  };
}
