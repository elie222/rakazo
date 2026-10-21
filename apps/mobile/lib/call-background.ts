import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type RakazoCallNative = {
  startCall(title: string): Promise<boolean>;
  stopCall(): Promise<void>;
};

const nativeCall =
  Platform.OS === "android"
    ? requireOptionalNativeModule<RakazoCallNative>("RakazoNotifications")
    : null;

/** Keep the microphone call alive while the screen is off. */
export async function startCallBackground(title: string): Promise<boolean> {
  if (!nativeCall) return false;
  try {
    return await nativeCall.startCall(title);
  } catch {
    return false;
  }
}

export async function stopCallBackground(): Promise<void> {
  await nativeCall?.stopCall().catch(() => undefined);
}
