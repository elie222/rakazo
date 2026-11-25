import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
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
import { imageArtifactPreview } from "../../lib/artifacts/artifact-open";
import { NativeSymbol } from "../native/native-symbol";
import type { ImageArtifactPreviewTarget } from "./image-artifact-viewer";

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
}: {
  threadTarget: MobileArtifactTarget;
  images: readonly ImageArtifactPreviewTarget[];
  onOpen: (image: ImageArtifactPreviewTarget, images: ImageArtifactPreviewTarget[]) => void;
  actionProps?: Record<string, unknown>;
}) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  const { width: windowWidth } = useWindowDimensions();
  const width = Math.min(Math.round(windowWidth * 0.62), 320);
  const height = Math.round(width * 1.5);
  const gallery = images.map(({ artifactId, name, mimeType }) => ({ artifactId, name, mimeType }));
  const shown = gallery.slice(0, MAX_CARDS);
  const behind = shown.length - 1;

  return (
    <View style={styles.group}>
      <View style={{ width: width + PEEK * behind + 24, height: height + PEEK * behind + 24 }}>
        {shown
          .map((image, index) => ({ image, index }))
          .reverse()
          .map(({ image, index }) => (
            <Pressable
              key={`${image.artifactId}-${index}`}
              accessibilityRole="imagebutton"
              accessibilityLabel={t`Open photo ${index + 1} of ${images.length}`}
              onPress={() => onOpen(image, gallery)}
              {...(actionProps ?? {})}
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
  const [state, setState] = useState<{ uri: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const targetBotId = "botId" in target ? target.botId : undefined;
  const targetGroupId = "groupId" in target ? target.groupId : undefined;

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setFailed(false);
    const request: MobileArtifactTarget =
      targetBotId !== undefined ? { botId: targetBotId } : { groupId: targetGroupId! };
    imageArtifactPreview(request, image.artifactId, image.mimeType)
      .then(({ uri }) => {
        if (!cancelled) setState({ uri });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [targetBotId, targetGroupId, image.artifactId, image.mimeType]);

  if (!state) {
    return (
      <View>
        <Text numberOfLines={3} style={[styles.label, { color: labelColor }]}>
          🖼 {image.name}
        </Text>
        {failed ? null : (
          <ActivityIndicator color={labelColor} accessibilityLabel={t`Loading image…`} />
        )}
      </View>
    );
  }
  return (
    <Image
      source={{ uri: state.uri }}
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
