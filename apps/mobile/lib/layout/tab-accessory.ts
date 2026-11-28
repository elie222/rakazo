import { useSegments } from "expo-router";
import { Platform } from "react-native";
import { iosAtLeast } from "../native/native-controls";

/** iOS 26's tab bar can hold a bar of its own (the bottom accessory), like a music player. */
export function tabAccessorySupported(): boolean {
  return Platform.OS === "ios" && iosAtLeast(26);
}

/**
 * Whether the tab bar is on screen and holds the app's bottom bars (the voice player, a minimized
 * call). Then the root layout leaves them out, so they never stack under the tab bar.
 */
export function useTabBarHoldsBottomBars(): boolean {
  const segments = useSegments();
  return tabAccessorySupported() && segments[0] === "(tabs)";
}
