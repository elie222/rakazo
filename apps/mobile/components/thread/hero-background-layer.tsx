import { useVideoPlayer, VideoView } from "expo-video";
import { Image, StyleSheet, View } from "react-native";
import { useHeroBackground } from "../../lib/hero-background";

/**
 * The title hero's background, painted behind the avatar and name only: the
 * hero wrapper keeps its solid theme background underneath, so the picture
 * blends over it at the background's opacity and the scrolling conversation
 * can never show through. A video background plays muted on a loop. No
 * background set means nothing renders and the hero is exactly as before.
 */
export function HeroBackgroundLayer({ threadKey }: { threadKey: string | undefined }) {
  const background = useHeroBackground(threadKey);
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
