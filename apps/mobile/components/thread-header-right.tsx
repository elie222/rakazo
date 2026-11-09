import type { NativeStackNavigationOptions } from "expo-router";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { iosAtLeast } from "../lib/native-controls";
import { NativeSymbol } from "./native-symbol";

export function openInvite() {
  router.push("/invite");
}

/**
 * A chat header's right side: the group's settings button in a group, the invite gift in a bot
 * chat when the account can invite, plus the auto-read toggle in a one-to-one bot chat. The
 * bot's own actions live in its profile, which the title opens. The chat route declares it when
 * the screen is created, so the title is centred against it from the first frame; both use this
 * one builder so the item never changes shape.
 */
export function threadHeaderRight({
  inGroup,
  readOnly,
  t,
  color,
  accentColor,
  onGroupSettings,
  onInvite,
  autoSpeak,
  onToggleAutoSpeak,
}: {
  inGroup: boolean;
  readOnly: boolean;
  t: (text: string) => string;
  color: string;
  /** Accent color for the auto-read toggle's on state; defaults to the header color. */
  accentColor?: string;
  onGroupSettings: () => void;
  /** Opens the invite sheet; absent when the account cannot invite. */
  onInvite?: () => void;
  /** Whether the current bot reads its replies aloud; absent outside a one-to-one bot chat. */
  autoSpeak?: boolean;
  /** Toggles the current bot's auto-read; absent outside a one-to-one bot chat. */
  onToggleAutoSpeak?: () => void;
}): NativeStackNavigationOptions {
  const label = inGroup ? t("Group settings") : t("Invite a friend");
  const onPress = inGroup ? onGroupSettings : onInvite;
  const showAutoSpeak = !inGroup && !readOnly && onToggleAutoSpeak !== undefined;
  const autoSpeakLabel = autoSpeak ? t("Stop reading replies aloud") : t("Read replies aloud");
  // Undefined, not an empty list, so an older iOS header keeps a Restore button set elsewhere.
  if ((readOnly || !onPress) && !showAutoSpeak) {
    return { headerRight: undefined, unstable_headerRightItems: undefined };
  }
  const speakerAndroidIcon = autoSpeak ? "volume-high-outline" : "volume-mute-outline";
  const speakerColor = autoSpeak ? (accentColor ?? color) : color;
  return {
    ...(iosAtLeast(26)
      ? {
          unstable_headerRightItems: () => [
            ...(showAutoSpeak
              ? [
                  {
                    type: "button" as const,
                    label: autoSpeakLabel,
                    accessibilityLabel: autoSpeakLabel,
                    icon: {
                      type: "sfSymbol",
                      name: autoSpeak ? "speaker.wave.2" : "speaker.slash",
                    } as const,
                    onPress: onToggleAutoSpeak,
                  },
                ]
              : []),
            ...(onPress
              ? [
                  {
                    type: "button" as const,
                    label,
                    accessibilityLabel: label,
                    icon: {
                      type: "sfSymbol",
                      name: inGroup ? "gearshape" : "gift",
                    } as const,
                    onPress,
                  },
                ]
              : []),
          ],
        }
      : { unstable_headerRightItems: undefined }),
    headerRight: () => (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 20 }}>
        {showAutoSpeak ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={autoSpeakLabel}
            accessibilityState={{ selected: autoSpeak }}
            hitSlop={8}
            onPress={onToggleAutoSpeak}
          >
            <NativeSymbol
              ios={autoSpeak ? "speaker.wave.2" : "speaker.slash"}
              android={speakerAndroidIcon}
              size={21}
              color={speakerColor}
            />
          </Pressable>
        ) : null}
        {onPress ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            hitSlop={8}
            onPress={onPress}
          >
            <NativeSymbol
              ios={inGroup ? "gearshape" : "gift"}
              android={inGroup ? "settings-outline" : "gift-outline"}
              size={21}
              color={color}
            />
          </Pressable>
        ) : null}
      </View>
    ),
  };
}
