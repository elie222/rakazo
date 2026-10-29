import type { NativeStackNavigationOptions } from "expo-router";
import { Platform, Pressable, View } from "react-native";
import { iosAtLeast } from "../lib/native-controls";
import { NativeSymbol } from "./native-symbol";

/** One of a bot chat's actions in its "…" menu. */
export type ThreadHeaderAction = { text: string; destructive?: boolean; onPress: () => void };

/**
 * A chat header's right side: the group's settings button in a group, the bot's "…" actions
 * otherwise. The chat route declares it when the screen is created, so the title is centred
 * against it from the first frame; the open chat then fills in the actions. Both use this one
 * builder so the item never changes shape or size.
 */
export function threadHeaderRight({
  inGroup,
  readOnly,
  hasBot,
  t,
  color,
  rowStyle,
  onGroupSettings,
  onBotActions,
  menuActions,
  computerLabel,
}: {
  inGroup: boolean;
  readOnly: boolean;
  hasBot: boolean;
  t: (text: string) => string;
  color: string;
  rowStyle?: object;
  onGroupSettings: () => void;
  onBotActions: () => void;
  menuActions: readonly ThreadHeaderAction[];
  /** The menu action that gets the computer icon. */
  computerLabel?: string;
}): NativeStackNavigationOptions {
  return {
    ...(Platform.OS === "ios" && !readOnly && (!inGroup || iosAtLeast(26))
      ? {
          unstable_headerRightItems: () => [
            inGroup
              ? {
                  type: "button" as const,
                  label: t("Group settings"),
                  accessibilityLabel: t("Group settings"),
                  icon: { type: "sfSymbol" as const, name: "gearshape" },
                  onPress: onGroupSettings,
                }
              : {
                  type: "menu" as const,
                  label: t("Bot actions"),
                  accessibilityLabel: t("Bot actions"),
                  icon: { type: "sfSymbol" as const, name: "ellipsis" },
                  disabled: !hasBot,
                  menu: {
                    items: menuActions.map((action) => ({
                      type: "action" as const,
                      label: action.text,
                      destructive: action.destructive,
                      ...(action.text === computerLabel
                        ? { icon: { type: "sfSymbol" as const, name: "desktopcomputer" } }
                        : {}),
                      onPress: action.onPress,
                    })),
                  },
                },
          ],
        }
      : {}),
    headerRight: () =>
      inGroup ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Group settings")}
          hitSlop={8}
          onPress={onGroupSettings}
        >
          <NativeSymbol ios="gearshape" android="settings-outline" size={21} color={color} />
        </Pressable>
      ) : (
        <View style={rowStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Bot actions")}
            hitSlop={8}
            onPress={onBotActions}
          >
            <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={21} color={color} />
          </Pressable>
        </View>
      ),
  };
}
