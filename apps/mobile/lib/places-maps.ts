import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type ExpoMaps = typeof import("expo-maps");

let maps: ExpoMaps | null | undefined;

/**
 * Apple Maps from expo-maps, or null where it cannot draw: Android, web, and iOS builds made
 * before the module shipped. The card then shows its list alone.
 */
export function loadPlacesMaps(): ExpoMaps | null {
  if (maps !== undefined) return maps;
  maps = null;
  if (Platform.OS !== "ios") return maps;
  try {
    if (requireOptionalNativeModule("ExpoMaps")) maps = require("expo-maps") as ExpoMaps;
  } catch {
    // An older binary may not be able to load the package.
  }
  return maps;
}
