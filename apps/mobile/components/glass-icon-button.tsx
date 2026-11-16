import type { ComponentProps } from "react";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import { Platform, Pressable } from "react-native";
import { useMobileTokens } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { androidRipple, withAlpha } from "../lib/ripple";
import { GlassSurface } from "./glass-surface";
import { NativeSymbol } from "./native-symbol";

/**
 * Round icon button on Liquid Glass (iOS 26); `fallbackStyle` draws it elsewhere. The icon
 * defaults to full contrast on glass and muted on the flat fallback; a selected toggle fills
 * with the primary token.
 */
export function GlassIconButton({
  testID,
  accessibilityLabel,
  onPress,
  ios,
  android,
  size = 40,
  iconSize = 17,
  color,
  tint,
  selected,
  disabled,
  fallbackStyle,
}: {
  testID?: string;
  accessibilityLabel: string;
  onPress: () => void;
  ios: string;
  android: ComponentProps<typeof NativeSymbol>["android"];
  size?: number;
  iconSize?: number;
  color?: ColorValue;
  tint?: string;
  selected?: boolean;
  disabled?: boolean;
  fallbackStyle?: StyleProp<ViewStyle>;
}) {
  const tokens = useMobileTokens();
  const iconColor = selected
    ? tokens.primaryForeground
    : (color ?? (iosAtLeast(26) ? tokens.foreground : tokens.mutedForeground));
  return (
    <GlassSurface
      shape="circle"
      tint={selected ? tokens.primary : tint}
      style={{ width: size, height: size }}
      fallbackStyle={[
        { borderRadius: size / 2 },
        fallbackStyle,
        selected && { backgroundColor: tokens.primary },
      ]}
    >
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={
          selected === undefined && disabled === undefined ? undefined : { selected, disabled }
        }
        disabled={disabled}
        // A small button still gets the 44-point tap target platforms recommend.
        hitSlop={Math.max(4, (44 - size) / 2)}
        android_ripple={androidRipple(withAlpha(iconColor, 0.14))}
        onPress={onPress}
        style={({ pressed }) => ({
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          ...(Platform.OS === "android" ? { borderRadius: size / 2, overflow: "hidden" } : null),
          opacity: disabled ? 0.45 : pressed && Platform.OS !== "android" ? 0.6 : 1,
        })}
      >
        <NativeSymbol ios={ios} android={android} size={iconSize} color={iconColor} />
      </Pressable>
    </GlassSurface>
  );
}
