import { useLingui } from "@lingui/react/macro";
import type { PressableProps } from "react-native";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import type { MobileArtifactTarget } from "../../lib/artifacts/artifact-open";
import { fitImageSize } from "../../lib/messages/inline-image";
import { useImagePreview } from "./use-image-preview";

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
  const { t } = useLingui();
  const tokens = mobileTokens();
  const { width: windowWidth } = useWindowDimensions();
  const maxWidth = Math.min(Math.round(windowWidth * 0.68), 400);
  const { preview: state } = useImagePreview(threadTarget, artifactId, mimeType);

  const canOpen = state.status !== "loading";
  const openLabel = canOpen ? t`Open image ${name}` : undefined;

  if (state.status === "ready") {
    const size = fitImageSize(state.size, maxWidth, MAX_INLINE_HEIGHT);
    return (
      <Pressable
        {...pressableProps}
        accessibilityRole="imagebutton"
        accessibilityLabel={openLabel}
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
    <Pressable
      {...pressableProps}
      accessibilityRole={canOpen ? "button" : pressableProps?.accessibilityRole}
      accessibilityLabel={openLabel ?? pressableProps?.accessibilityLabel}
      onPress={canOpen ? onOpen : undefined}
    >
      <View style={[styles.placeholder, { backgroundColor: tokens.muted }]}>
        <Text style={[styles.label, { color: labelColor }]}>🖼 {name}</Text>
        {state.status === "loading" ? (
          <ActivityIndicator
            color={tokens.mutedForeground}
            accessibilityLabel={t`Loading image…`}
          />
        ) : (
          <Text style={[styles.hint, { color: tokens.mutedForeground }]}>{t`Tap to open`}</Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  image: { borderRadius: 12, overflow: "hidden" },
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
