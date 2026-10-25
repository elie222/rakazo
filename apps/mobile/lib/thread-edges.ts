import { Platform } from "react-native";

// Inversion can spread a side edge's tint across the entire message list.
export const threadScrollEdgeEffects = {
  top: "hidden",
  bottom: "hidden",
  left: "hidden",
  right: "hidden",
} as const;

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
