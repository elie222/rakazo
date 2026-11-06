import { requireOptionalNativeModule } from "expo";
import { lazy, Suspense } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

// Loaded only when the build has the player: an over-the-air update can reach a build made
// before it, where importing the player would fail.
const playerAvailable = Boolean(requireOptionalNativeModule("ExpoVideo"));
const VideoPlayer = lazy(() => import("./video-player"));

/** A local video file played in the app, so watching one never needs another app. */
export function VideoPreview({ uri, name }: { uri: string; name: string }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  if (!playerAvailable) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{t("No preview for this file type.")}</Text>
      </View>
    );
  }
  return (
    <Suspense fallback={null}>
      <VideoPlayer uri={uri} name={name} />
    </Suspense>
  );
}

function createStyles() {
  return StyleSheet.create({
    centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    error: { color: native.secondaryLabel, fontSize: 14, textAlign: "center" },
  });
}
