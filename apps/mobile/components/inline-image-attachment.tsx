import { useEffect, useState } from "react";
import type { PressableProps } from "react-native";
import { Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { imageArtifactUri } from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import type { ImageSize } from "../lib/inline-image";
import { fitImageSize } from "../lib/inline-image";

const MAX_INLINE_HEIGHT = 360;

/**
 * An image attachment rendered inside a chat bubble. The artifact is fetched through the
 * authenticated RPC (the server does not serve artifacts to a bare URL), cached on disk and
 * shown at its natural size, scaled down to fit the bubble. Tapping it opens the viewer.
 */
export function InlineImageAttachment({
  threadTarget,
  artifactId,
  name,
  mimeType,
  onOpen,
  pressableProps,
  labelColor,
}: {
  threadTarget: MobileArtifactTarget;
  artifactId: string;
  name: string;
  mimeType: string;
  onOpen: () => void;
  pressableProps?: Omit<PressableProps, "onPress" | "children" | "style">;
  labelColor: string;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const { width: windowWidth } = useWindowDimensions();
  const maxWidth = Math.min(Math.round(windowWidth * 0.68), 400);
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; uri: string; size: ImageSize } | { status: "error" }
  >({ status: "loading" });
  const targetBotId = "botId" in threadTarget ? threadTarget.botId : undefined;
  const targetGroupId = "groupId" in threadTarget ? threadTarget.groupId : undefined;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const target: MobileArtifactTarget =
      targetBotId !== undefined ? { botId: targetBotId } : { groupId: targetGroupId! };
    imageArtifactUri(target, artifactId, mimeType)
      .then(
        (uri) =>
          new Promise<{ uri: string; size: ImageSize }>((resolve, reject) => {
            Image.getSize(
              uri,
              (width, height) => resolve({ uri, size: { width, height } }),
              reject,
            );
          }),
      )
      .then((loaded) => {
        if (!cancelled) setState({ status: "ready", ...loaded });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [targetBotId, targetGroupId, artifactId, mimeType]);

  if (state.status === "ready") {
    const size = fitImageSize(state.size, maxWidth, MAX_INLINE_HEIGHT);
    return (
      <Pressable
        {...pressableProps}
        accessibilityRole="imagebutton"
        accessibilityLabel={t("Open image {name}", { name })}
        onPress={onOpen}
      >
        <Image
          source={{ uri: state.uri }}
          style={[styles.image, size, { backgroundColor: tokens.muted }]}
          accessibilityIgnoresInvertColors
        />
      </Pressable>
    );
  }
  return (
    <Pressable {...pressableProps} onPress={state.status === "error" ? onOpen : undefined}>
      <View style={[styles.placeholder, { backgroundColor: tokens.muted }]}>
        <Text style={[styles.label, { color: labelColor }]}>🖼 {name}</Text>
        <Text style={[styles.hint, { color: tokens.mutedForeground }]}>
          {state.status === "loading" ? t("Loading image…") : t("Tap to open")}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  image: { borderRadius: 12 },
  placeholder: {
    minHeight: 44,
    justifyContent: "center",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  label: { fontSize: 15 },
  hint: { fontSize: 13, marginTop: 2 },
});
