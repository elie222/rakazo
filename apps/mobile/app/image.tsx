import { useLocalSearchParams, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect } from "react";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import { ImageArtifactViewer } from "../components/image-artifact-viewer";
import type { MobileArtifactTarget } from "../lib/artifact-open";

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Bumped by every viewer mount so a closed viewer's delayed relock yields to a newer one. */
let viewerGeneration = 0;

/** Full-screen image viewer opened from a thread; a stack screen so the share sheet can sit on top of it. */
export default function ImageScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    artifactId?: string | string[];
    name?: string | string[];
    mimeType?: string | string[];
    botId?: string | string[];
    groupId?: string | string[];
  }>();
  const groupId = first(params.groupId);

  useEffect(() => {
    // Most attached images are landscape desktop screenshots: let this screen rotate, like the
    // full-screen computer view; the rest of the app stays portrait. The portrait lock on
    // dismissal waits for the unlock to settle, so a quick close cannot leave the thread
    // rotating because the two asynchronous calls landed out of order.
    // If another viewer has opened in the meantime, it owns the orientation: skip the relock.
    viewerGeneration += 1;
    const generation = viewerGeneration;
    const unlocked = ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.DEFAULT).catch(
      () => undefined,
    );
    return () => {
      void unlocked.then(() => {
        if (generation !== viewerGeneration) return;
        return ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
          () => undefined,
        );
      });
    };
  }, []);
  const threadTarget: MobileArtifactTarget = groupId ? { groupId } : { botId: first(params.botId) };
  // The app root mounts no SafeAreaProvider; this screen hides the native header, so it
  // provides its own, seeded with the window metrics so the first frame already has the
  // right insets (a measured SafeAreaView starts at zero inside a modal presentation).
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <ImageArtifactViewer
        threadTarget={threadTarget}
        target={{
          artifactId: first(params.artifactId),
          name: first(params.name),
          mimeType: first(params.mimeType) || "image/png",
        }}
        onClose={() => router.back()}
      />
    </SafeAreaProvider>
  );
}
