import { Platform } from "react-native";

// Inversion can spread a side edge's tint across the entire message list.
export const threadScrollEdgeEffects = {
  top: "hidden",
  bottom: "hidden",
  left: "hidden",
  right: "hidden",
} as const;

// The pill bottoms sit 10pt above the native header bottom.
export const THREAD_HEADER_PILL_BOTTOM_INSET = 10;
export const THREAD_HEADER_FADE_SOLID = 14;
export const THREAD_HEADER_FADE_GRADIENT = 12;

export function threadHeaderClearance(headerHeight: number) {
  if (headerHeight <= 0) return { opaqueHeight: 0, padding: 8, anchor: 24, minHeight: 0 };
  const pillBottom = headerHeight - THREAD_HEADER_PILL_BOTTOM_INSET;
  const opaqueHeight = pillBottom + THREAD_HEADER_FADE_SOLID;
  return {
    opaqueHeight,
    padding: opaqueHeight,
    anchor: opaqueHeight + THREAD_HEADER_FADE_GRADIENT + 8,
    minHeight: opaqueHeight,
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
