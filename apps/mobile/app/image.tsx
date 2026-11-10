import { useLocalSearchParams, useRouter } from "expo-router";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import { ImageArtifactViewer } from "../components/image-artifact-viewer";
import type { MobileArtifactTarget } from "../lib/artifact-open";

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

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
