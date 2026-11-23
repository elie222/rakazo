import { useState } from "react";
import type { PressableProps, ViewStyle } from "react-native";
import { Pressable } from "react-native";
import { useMobileTokens } from "../../lib/native/native";

export function ComposerPickerRow({
  selected,
  style,
  ...props
}: Omit<PressableProps, "style" | "onHoverIn" | "onHoverOut" | "accessibilityState"> & {
  selected: boolean;
  style: ViewStyle;
}) {
  const tokens = useMobileTokens();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        style,
        { backgroundColor: selected ? tokens.muted : hovered ? tokens.accent : undefined },
      ]}
    />
  );
}
