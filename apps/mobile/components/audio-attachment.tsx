import { useEffect, useRef, useState } from "react";
import type { PressableProps } from "react-native";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { audioArtifactUri, openMobileArtifact } from "../lib/artifact-open";
import {
  createAttachmentAudioPlayer,
  INITIAL_ATTACHMENT_AUDIO_STATE,
} from "../lib/attachment-audio";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/user-error";
import { GlassIconButton } from "./glass-icon-button";

export function AudioAttachment({
  target,
  artifactId,
  name,
  mimeType,
  pressableProps,
}: {
  target: MobileArtifactTarget;
  artifactId: string;
  name: string;
  mimeType: string;
  pressableProps?: Omit<PressableProps, "onPress" | "children" | "style">;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [state, setState] = useState(INITIAL_ATTACHMENT_AUDIO_STATE);
  const player = useRef<ReturnType<typeof createAttachmentAudioPlayer> | null>(null);
  const botId = "botId" in target ? target.botId : undefined;
  const groupId = "groupId" in target ? target.groupId : undefined;
  useEffect(() => {
    const requestTarget: MobileArtifactTarget =
      botId !== undefined ? { botId } : { groupId: groupId! };
    const instance = createAttachmentAudioPlayer(
      () => audioArtifactUri(requestTarget, artifactId, mimeType),
      setState,
    );
    player.current = instance;
    setState(INITIAL_ATTACHMENT_AUDIO_STATE);
    return () => {
      player.current = null;
      instance.dispose();
    };
  }, [botId, groupId, artifactId, mimeType]);
  // The row takes the message long-press; screen readers get the message actions on the
  // name instead so the play and share buttons stay separately focusable.
  const { accessibilityActions, onAccessibilityAction, ...touchProps } = pressableProps ?? {};
  return (
    <Pressable
      {...touchProps}
      accessible={false}
      style={{
        gap: 6,
        padding: 12,
        borderWidth: 1,
        borderColor: tokens.border,
        borderRadius: 12,
        backgroundColor: tokens.card,
      }}
    >
      <Text
        accessible
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        numberOfLines={1}
        style={{ color: tokens.foreground, fontSize: 15 }}
      >
        {name}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {state.loading ? (
          <ActivityIndicator color={tokens.mutedForeground} />
        ) : (
          <GlassIconButton
            accessibilityLabel={state.playing ? t("Pause") : t("Play")}
            ios={state.playing ? "pause.fill" : "play.fill"}
            android={state.playing ? "pause" : "play"}
            onPress={() => void player.current?.toggle()}
          />
        )}
        <Text style={{ flex: 1, color: tokens.mutedForeground, fontSize: 13 }}>
          {playbackTime(state.currentTime)} / {playbackTime(state.duration)}
        </Text>
        <GlassIconButton
          accessibilityLabel={t("Share {name}", { name })}
          ios="square.and.arrow.up"
          android="share-social-outline"
          onPress={() =>
            void openMobileArtifact(target, artifactId, name, mimeType).catch((error) =>
              Alert.alert(t("Could not share file"), errorText(error, t("Try again."))),
            )
          }
        />
      </View>
      {state.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 13 }}>
          {t("Could not play that clip.")}
        </Text>
      ) : null}
    </Pressable>
  );
}

function playbackTime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
