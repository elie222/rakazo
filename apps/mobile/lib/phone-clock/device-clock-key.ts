import { AppState, Platform } from "react-native";

let deviceKey: string | undefined;

/** The per-launch clock proof stays on the device that can handle the request. */
export function nativeClockDeviceKey() {
  const expo = globalThis.expo;
  if (Platform.OS !== "android" || !expo?.modules?.RakazoClock || typeof expo.uuidv4 !== "function")
    return undefined;
  deviceKey ??= expo.uuidv4();
  return deviceKey;
}

export function foregroundClockDeviceKey() {
  return AppState.currentState === "active" ? nativeClockDeviceKey() : undefined;
}
