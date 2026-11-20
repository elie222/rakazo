import { AppState, Platform } from "react-native";

let deviceKey: string | undefined;

/** The per-launch proof is kept in memory and never shared with other signed-in devices. */
export function nativeCalendarDeviceKey() {
  const expo = globalThis.expo;
  if (
    !expo?.modules?.CalendarNext ||
    (Platform.OS !== "android" && !(Platform.OS === "ios" && expo.modules.RakazoCalendar)) ||
    typeof expo.uuidv4 !== "function"
  )
    return undefined;
  deviceKey ??= expo.uuidv4();
  return deviceKey;
}

export function foregroundCalendarDeviceKey() {
  const key = nativeCalendarDeviceKey();
  return key && AppState.currentState === "active" ? key : undefined;
}
