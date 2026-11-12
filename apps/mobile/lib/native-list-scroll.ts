import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

const nativeScroll =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<{ scrollToRow(viewTag: number, row: number): Promise<boolean> }>(
        "RakazoListScroll",
      )
    : null;

/** Optional so an updated bundle also runs on binaries built before it: they offer no jumps. */
export const canScrollNativeList = nativeScroll !== null;

/** Scrolls the native list inside the view with this tag so its row sits mid-screen. */
export function scrollNativeListToRow(viewTag: number | null, row: number) {
  if (!nativeScroll || viewTag === null) return Promise.resolve(false);
  return nativeScroll.scrollToRow(viewTag, row);
}
