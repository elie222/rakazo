import { Platform } from "react-native";
import { THREAD_COLUMN_GUTTER } from "./message-presentation";

// Inversion can spread a side edge's tint across the entire message list.
export const threadScrollEdgeEffects = {
  top: "hidden",
  bottom: "hidden",
  left: "hidden",
  right: "hidden",
} as const;

export type ThreadColumnPadding = { paddingStart: number; paddingEnd: number };

/**
 * Column padding for messages and the composer. Insets are physical (a cutout's side);
 * start and end are logical, so in RTL the start edge takes the right inset.
 */
export function threadColumnPadding(
  columnInsets: { left: number; right: number },
  rtl: boolean,
): ThreadColumnPadding {
  return {
    paddingStart: THREAD_COLUMN_GUTTER + (rtl ? columnInsets.right : columnInsets.left),
    paddingEnd: THREAD_COLUMN_GUTTER + (rtl ? columnInsets.left : columnInsets.right),
  };
}

export function threadHeaderFloats() {
  return Platform.OS === "ios";
}

export function threadEdgeOptions() {
  const floatingHeader = threadHeaderFloats();
  return {
    headerTransparent: floatingHeader,
    ...(floatingHeader
      ? { headerStyle: { backgroundColor: "transparent" }, headerShadowVisible: false }
      : {}),
    scrollEdgeEffects: threadScrollEdgeEffects,
  };
}
