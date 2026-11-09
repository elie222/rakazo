import { useVideoPlayer, VideoView } from "expo-video";
import { Image, StyleSheet, View } from "react-native";
import { useChatBackground } from "../../lib/chat-background";

/**
 * The thread's chat background, painted behind the message list only: the
 * header and the composer dock keep their own opaque backgrounds, so the
 * picture never reaches them. A video background plays muted on a loop.
 */
export function ChatBackgroundLayer({ threadKey }: { threadKey: string | undefined }) {
  const background = useChatBackground(threadKey);
  const player = useVideoPlayer(background?.kind === "video" ? background.uri : null, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  if (!background) return null;
  return (
    <View style={styles.layer} pointerEvents="none">
      {background.kind === "video" ? (
        <VideoView
          player={player}
          style={[styles.media, { opacity: background.opacity / 100 }]}
          contentFit="cover"
          nativeControls={false}
        />
      ) : (
        <Image
          source={{ uri: background.uri }}
          style={[styles.media, { opacity: background.opacity / 100 }]}
          resizeMode="cover"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFill,
  },
  media: {
    width: "100%",
    height: "100%",
  },
});
