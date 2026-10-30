import { Platform } from "react-native";

// Inversion can spread a side edge's tint across the entire message list.
export const threadScrollEdgeEffects = {
  top: "hidden",
  bottom: "hidden",
  left: "hidden",
  right: "hidden",
} as const;

/**
 * Gap between the screen edge and the chat column, before cutouts and the extra
 * space that centres a wide window. Messages use it as padding; the scroll view does not,
 * so the vertical scroll indicator stays on the screen edge.
 */
export const THREAD_COLUMN_GUTTER = 20;

/** Column padding for messages and the composer. Left and right follow the physical edges. */
export function threadColumnPadding(columnInsets: { left: number; right: number }) {
  return {
    paddingLeft: THREAD_COLUMN_GUTTER + columnInsets.left,
    paddingRight: THREAD_COLUMN_GUTTER + columnInsets.right,
  };
}

/** How far the jump button sits in from the trailing screen edge to meet the column. */
export function threadColumnTrailingInset(
  padding: { paddingLeft: number; paddingRight: number },
  rtl: boolean,
) {
  return rtl ? padding.paddingLeft : padding.paddingRight;
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
