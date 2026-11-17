import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";

export type GlassSurfaceProps = {
  shape?: "capsule" | "circle" | "roundedRectangle";
  /** Corner radius for `roundedRectangle`. */
  cornerRadius?: number;
  /** Glass tint, e.g. for a selected or primary control. */
  tint?: string;
  style?: StyleProp<ViewStyle>;
  /** Applied where Liquid Glass is unavailable (Android, iOS before 26). */
  fallbackStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/** Android and older iOS draw the fallback fill; iOS 26 renders Liquid Glass. */
export function GlassSurface({ style, fallbackStyle, children }: GlassSurfaceProps) {
  return <View style={[style, fallbackStyle]}>{children}</View>;
}
