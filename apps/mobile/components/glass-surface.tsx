import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";
import { useMobileTokens } from "../lib/native";

export type GlassSurfaceProps = {
  shape?: "capsule" | "circle" | "roundedRectangle";
  /** Corner radius for `roundedRectangle`. */
  cornerRadius?: number;
  /** Fill for a selected or primary control. */
  tint?: string;
  style?: StyleProp<ViewStyle>;
  /** Overrides for the flat fill, e.g. a different background. */
  fallbackStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/**
 * The raised control surface on every platform: a flat fill with a hairline border, fully
 * rounded unless `roundedRectangle`.
 */
export function GlassSurface({
  shape = "capsule",
  cornerRadius = 22,
  tint,
  style,
  fallbackStyle,
  children,
}: GlassSurfaceProps) {
  const tokens = useMobileTokens();
  return (
    <View
      style={[
        {
          backgroundColor: tint ?? tokens.glassFill,
          borderWidth: 1,
          borderColor: tokens.glassStroke,
          borderRadius: shape === "roundedRectangle" ? cornerRadius : 999,
        },
        style,
        fallbackStyle,
      ]}
    >
      {children}
    </View>
  );
}
