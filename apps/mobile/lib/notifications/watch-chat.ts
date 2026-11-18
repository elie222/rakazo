import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

const relay =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<{ invalidateWatchChat?(): void }>("RakazoNotifications")
    : null;

/** Let the paired watch re-read through its own authorized request after a run signal. */
export function invalidateWatchChat() {
  relay?.invalidateWatchChat?.();
}
