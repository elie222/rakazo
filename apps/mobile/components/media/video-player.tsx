import { useVideoPlayer, VideoView } from "expo-video";
import { StyleSheet } from "react-native";

/** A local video file played with the system's controls, full screen included. */
export default function VideoPlayer({ uri, name }: { uri: string; name: string }) {
  const player = useVideoPlayer(uri);
  return (
    <VideoView
      accessibilityLabel={name}
      player={player}
      nativeControls
      contentFit="contain"
      style={styles.fill}
    />
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
