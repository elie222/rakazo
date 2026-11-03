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

// The pill bottoms sit 10pt above the native header bottom; content rests 14pt below them.
export const THREAD_HEADER_PILL_BOTTOM_INSET = 10;
const THREAD_HEADER_CONTENT_GAP = 14;

export function threadHeaderClearance(headerHeight: number) {
  if (headerHeight <= 0) return { padding: 8, anchor: 24, minHeight: 0 };
  const padding = headerHeight - THREAD_HEADER_PILL_BOTTOM_INSET + THREAD_HEADER_CONTENT_GAP;
  return { padding, anchor: padding + 20, minHeight: padding };
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
