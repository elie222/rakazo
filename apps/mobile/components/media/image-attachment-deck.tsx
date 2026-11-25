import { plural } from "@lingui/core/macro";
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
import type { ImageArtifactPreviewTarget } from "../../lib/artifacts/artifact-gallery";
import type { MobileArtifactTarget } from "../../lib/artifacts/artifact-open";
import { NativeSymbol } from "../native/native-symbol";
import { useImagePreview } from "./use-image-preview";

/** How far each card behind the first one peeks out, and how far it leans. */
const PEEK = 12;
const LEAN = 5;
const MAX_CARDS = 3;

/**
 * The pictures of one message as a stack: the first card whole, the ones behind it peeking out at
 * an angle. Tapping the stack opens them in the viewer, which moves between them.
 */
export function ImageAttachmentDeck({
  threadTarget,
  images,
  onOpen,
  actionProps,
  maxWidth = Number.POSITIVE_INFINITY,
}: {
  threadTarget: MobileArtifactTarget;
  images: readonly ImageArtifactPreviewTarget[];
  onOpen: (
    image: ImageArtifactPreviewTarget,
    images: readonly ImageArtifactPreviewTarget[],
  ) => void;
  actionProps?: Pick<
    PressableProps,
    "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
  >;
  maxWidth?: number;
}) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  const { width: windowWidth } = useWindowDimensions();
  const shown = images.slice(0, MAX_CARDS);
  const stackPadding = PEEK * (shown.length - 1) + 24;
  const width = Math.max(1, Math.min(Math.round(windowWidth * 0.5), 240, maxWidth - stackPadding));
  const height = Math.round(width * 1.5);

  return (
    <View style={styles.group}>
      <View style={{ width: width + stackPadding, height: height + stackPadding }}>
        {shown
          .map((image, index) => ({ image, index }))
          .reverse()
          .map(({ image, index }) => (
            <Pressable
              key={`${image.artifactId}-${index}`}
              accessibilityRole="imagebutton"
              accessibilityLabel={t`Open photo ${index + 1} of ${images.length}`}
              onPress={() => onOpen(image, images)}
              {...actionProps}
              style={[
                styles.card,
                {
                  width,
                  height,
                  backgroundColor: tokens.muted,
                  shadowColor: tokens.foreground,
                  transform: [
                    { translateX: PEEK * index },
                    { translateY: PEEK * index },
                    { rotate: `${LEAN * index}deg` },
                  ],
                },
              ]}
            >
              <DeckCard target={threadTarget} image={image} labelColor={tokens.mutedForeground} />
            </Pressable>
          ))}
      </View>
      <View style={[styles.caption, { marginTop: 4 }]}>
        <NativeSymbol
          ios="photo.on.rectangle"
          android="images-outline"
          size={14}
          color={tokens.mutedForeground}
        />
        <Text style={[styles.captionText, { color: tokens.mutedForeground }]}>
          {t`${plural(images.length, { one: "# image", other: "# images" })}`}
        </Text>
      </View>
    </View>
  );
}

function DeckCard({
  target,
  image,
  labelColor,
}: {
  target: MobileArtifactTarget;
  image: ImageArtifactPreviewTarget;
  labelColor: string;
}) {
  const { t } = useLingui();
  const { preview } = useImagePreview(target, image.artifactId, image.mimeType);

  if (preview.status !== "ready") {
    return (
      <View>
        <Text numberOfLines={3} style={[styles.label, { color: labelColor }]}>
          🖼 {image.name}
        </Text>
        {preview.status === "error" ? null : (
          <ActivityIndicator color={labelColor} accessibilityLabel={t`Loading image…`} />
        )}
      </View>
    );
  }
  return (
    <Image
      source={{ uri: preview.uri }}
      resizeMode="cover"
      style={styles.filling}
      accessibilityIgnoresInvertColors
    />
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  card: {
    position: "absolute",
    top: 0,
    left: 0,
    borderRadius: 22,
    overflow: "hidden",
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  filling: { width: "100%", height: "100%" },
  caption: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 2 },
  captionText: { fontSize: 13 },
  label: { fontSize: 13, padding: 12 },
});
