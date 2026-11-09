import type { NativeStackNavigationOptions } from "expo-router";
import { router } from "expo-router";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Animated, Pressable, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { iosAtLeast } from "../lib/native-controls";
import { getVoicePlaybackState, subscribeVoicePlayback } from "../lib/voice";
import { NativeSymbol } from "./native-symbol";

export function openInvite() {
  router.push("/invite");
}

/**
 * The auto-read toggle. While this bot's reply is being read aloud the speaker pulses, so the
 * header shows at a glance that reading is in progress; it rests when the reading stops.
 * The iOS 26 native item beside it cannot animate, so it stays static there.
 */
function AutoSpeakHeaderButton({
  botId,
  autoSpeak,
  onToggleAutoSpeak,
  label,
  color,
  accentColor,
}: {
  /** The chat's bot: only its own playback pulses the speaker. */
  botId: string | undefined;
  autoSpeak: boolean | undefined;
  onToggleAutoSpeak: () => void;
  label: string;
  color: string;
  accentColor?: string;
}) {
  const speaking = useSyncExternalStore(
    subscribeVoicePlayback,
    () => {
      const state = getVoicePlaybackState();
      return state.status === "playing" && state.botId !== undefined && state.botId === botId;
    },
    () => false,
  );
  const reduceMotion = useReducedMotion();
  const pulse = useMemo(() => new Animated.Value(1), []);
  useEffect(() => {
    if (!speaking || reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.18, duration: 450, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 450, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [speaking, reduceMotion, pulse]);
  const speakerAndroidIcon = autoSpeak ? "volume-high-outline" : "volume-mute-outline";
  const speakerColor = autoSpeak ? (accentColor ?? color) : color;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: autoSpeak }}
      hitSlop={8}
      onPress={onToggleAutoSpeak}
    >
      <Animated.View style={{ transform: [{ scale: pulse }] }}>
        <NativeSymbol
          ios={autoSpeak ? "speaker.wave.2" : "speaker.slash"}
          android={speakerAndroidIcon}
          size={21}
          color={speakerColor}
        />
      </Animated.View>
    </Pressable>
  );
}

/**
 * A chat header's right side: the group's settings button in a group, the invite gift in a bot
 * chat when the account can invite, plus the auto-read toggle in a one-to-one bot chat. The
 * bot's own actions live in its profile, which the title opens. The chat route declares it when
 * the screen is created, so the title is centred against it from the first frame; both use this
 * one builder so the item never changes shape.
 */
export function threadHeaderRight({
  botId,
  inGroup,
  readOnly,
  t,
  color,
  accentColor,
  onGroupSettings,
  onInvite,
  autoSpeak,
  onToggleAutoSpeak,
  computerRunning,
  onOpenComputerFloat,
  onOpenVoiceChat,
}: {
  /** The chat's bot; the auto-read speaker pulses only for its own playback. */
  botId?: string;
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
  /** Whether this bot's computer is running; the float entry shows only then. */
  computerRunning?: boolean;
  /** Opens the computer screen float; absent when there is no computer to watch. */
  onOpenComputerFloat?: () => void;
  /** Opens the full-screen voice chat; absent outside a one-to-one bot chat. */
  onOpenVoiceChat?: () => void;
}): NativeStackNavigationOptions {
  const label = inGroup ? t("Group settings") : t("Invite a friend");
  const onPress = inGroup ? onGroupSettings : onInvite;
  const showAutoSpeak = !inGroup && !readOnly && onToggleAutoSpeak !== undefined;
  const autoSpeakLabel = autoSpeak ? t("Stop reading replies aloud") : t("Read replies aloud");
  const showComputerFloat =
    !inGroup && !readOnly && computerRunning === true && onOpenComputerFloat !== undefined;
  const computerLabel = t("Computer screen");
  const showVoiceChat = !inGroup && !readOnly && onOpenVoiceChat !== undefined;
  const voiceLabel = t("Voice chat");
  // Undefined, not an empty list, so an older iOS header keeps a Restore button set elsewhere.
  if ((readOnly || !onPress) && !showAutoSpeak && !showComputerFloat && !showVoiceChat) {
    return { headerRight: undefined, unstable_headerRightItems: undefined };
  }
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
            ...(showComputerFloat
              ? [
                  {
                    type: "button" as const,
                    label: computerLabel,
                    accessibilityLabel: computerLabel,
                    icon: {
                      type: "sfSymbol",
                      name: "desktopcomputer",
                    } as const,
                    onPress: onOpenComputerFloat,
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
            ...(showVoiceChat
              ? [
                  {
                    type: "button" as const,
                    label: voiceLabel,
                    accessibilityLabel: voiceLabel,
                    icon: {
                      type: "sfSymbol",
                      name: "phone",
                    } as const,
                    onPress: onOpenVoiceChat,
                  },
                ]
              : []),
          ],
        }
      : { unstable_headerRightItems: undefined }),
    headerRight: () => (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 20 }}>
        {showAutoSpeak ? (
          <AutoSpeakHeaderButton
            botId={botId}
            autoSpeak={autoSpeak}
            onToggleAutoSpeak={onToggleAutoSpeak}
            label={autoSpeakLabel}
            color={color}
            accentColor={accentColor}
          />
        ) : null}
        {showComputerFloat ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={computerLabel}
            hitSlop={8}
            onPress={onOpenComputerFloat}
          >
            <NativeSymbol ios="desktopcomputer" android="desktop-outline" size={21} color={color} />
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
        {showVoiceChat ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={voiceLabel}
            hitSlop={8}
            onPress={onOpenVoiceChat}
          >
            <NativeSymbol ios="phone" android="call-outline" size={21} color={color} />
          </Pressable>
        ) : null}
      </View>
    ),
  };
}
