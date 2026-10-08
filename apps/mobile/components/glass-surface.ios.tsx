import { Capsule, Circle, Host, RoundedRectangle } from "@expo/ui/swift-ui";
import { foregroundStyle, glassEffect } from "@expo/ui/swift-ui/modifiers";
import { StyleSheet, View } from "react-native";
import { useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import type { GlassSurfaceProps } from "./glass-surface";

/** Liquid Glass behind React Native children on iOS 26; `fallbackStyle` elsewhere. */
export function GlassSurface({
  shape = "capsule",
  cornerRadius = 22,
  tint,
  style,
  fallbackStyle,
  children,
}: GlassSurfaceProps) {
  const scheme = useResolvedAppearance();
  if (!iosAtLeast(26)) return <View style={[style, fallbackStyle]}>{children}</View>;
  const modifiers = [
    foregroundStyle("#00000000"),
    glassEffect({
      glass: { variant: "regular", ...(tint ? { tint } : {}) },
      shape,
      cornerRadius,
    }),
  ];
  return (
    <View style={style}>
      <Host colorScheme={scheme} pointerEvents="none" style={StyleSheet.absoluteFill}>
        {shape === "circle" ? (
          <Circle modifiers={modifiers} />
        ) : shape === "roundedRectangle" ? (
          <RoundedRectangle cornerRadius={cornerRadius} modifiers={modifiers} />
        ) : (
          <Capsule modifiers={modifiers} />
        )}
      </Host>
      {children}
    </View>
  );
}
