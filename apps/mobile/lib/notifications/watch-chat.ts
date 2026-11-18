import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type WatchChange = "chat" | "roster" | "space" | "sessionUnavailable" | "sessionReady";

const relay =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<{
        invalidateWatchChat?(kind: WatchChange, spaceId: string | null): void;
      }>("RakazoNotifications")
    : null;

/** Let the paired watch re-read through its own authorized request after a run signal, or clear its view when the iPhone session changes. */
export function invalidateWatchChat(kind: WatchChange = "chat", spaceId: string | null = null) {
  relay?.invalidateWatchChat?.(kind, spaceId);
}
