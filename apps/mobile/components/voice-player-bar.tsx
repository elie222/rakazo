import { useLingui } from "@lingui/react/macro";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import {
  getVoicePlaybackState,
  pauseVoicePlayback,
  resumeVoicePlayback,
  stopVoicePlayback,
  subscribeVoicePlayback,
} from "../lib/voice";
import { GlassSurface } from "./glass-surface";
import { NativeSymbol } from "./native-symbol";

/**
 * Pause / Resume / Stop for a reply that is being spoken. Rendered only while
 * something is speaking or paused, as a normal block in the layout so it never
 * covers the message list or composer, and it follows the user across screens
 * because playback state, including who is speaking, lives in `lib/voice`.
 */
export function VoicePlayerBar({
  style,
}: {
  style?: { marginTop?: number; marginBottom?: number; marginHorizontal?: number };
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const tokens = mobileTokens();
  const playback = useSyncExternalStore(subscribeVoicePlayback, getVoicePlaybackState);
  if (playback.status === "idle") return null;

  const speakerColor = playback.speaker?.color ?? tokens.foreground;
  const paused = playback.status === "paused";

  return (
    <GlassSurface style={[styles.bar, style]}>
      <NativeSymbol ios="waveform" android="pulse-outline" size={16} color={speakerColor} />
      <Text numberOfLines={1} style={[styles.name, { color: speakerColor }]}>
        {playback.speaker?.name || t`Bot`}
      </Text>
      {paused ? (
        <VoiceControlButton
          accessibilityLabel={t`Play`}
          onPress={resumeVoicePlayback}
          ios="play.fill"
          android="play"
        />
      ) : playback.canPause ? (
        <VoiceControlButton
          accessibilityLabel={t`Pause`}
          onPress={pauseVoicePlayback}
          ios="pause.fill"
          android="pause"
        />
      ) : null}
      <VoiceControlButton
        accessibilityLabel={t`Stop`}
        onPress={stopVoicePlayback}
        ios="stop.fill"
        android="stop"
      />
    </GlassSurface>
  );
}

function VoiceControlButton({
  accessibilityLabel,
  onPress,
  ios,
  android,
}: {
  accessibilityLabel: string;
  onPress: () => void;
  ios: string;
  android: Parameters<typeof NativeSymbol>[0]["android"];
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.6 }]}
    >
      <NativeSymbol
        ios={ios}
        android={android}
        size={18}
        color={mobileTokens().secondaryForeground}
      />
    </Pressable>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    bar: {
      marginHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 56,
      paddingStart: 20,
      paddingEnd: 7,
    },
    name: { flexGrow: 1, flexShrink: 1, ...typeScale.secondary, fontWeight: fontWeight.medium },
    button: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.secondary,
    },
  });
}
