import { iosAtLeast } from "./native-controls";

// Inversion can spread a side edge's tint across the entire message list.
export const threadScrollEdgeEffects = {
  top: "hidden",
  bottom: "hidden",
  left: "hidden",
  right: "hidden",
} as const;

export function threadEdgeOptions() {
  return {
    headerTransparent: iosAtLeast(26),
    ...(iosAtLeast(26) ? { headerStyle: { backgroundColor: "transparent" } } : {}),
    scrollEdgeEffects: threadScrollEdgeEffects,
  };
}
