import { Pressable, Text, View } from "react-native";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { NativeSegmentedControlProps } from "../lib/native-controls";

/** The pre-native segmented control, kept for Android and for an empty selection. */
export function SegmentedPills<T extends string>({
  accessibilityLabel,
  value,
  onChange,
  options,
  disabled = false,
}: NativeSegmentedControlProps<T>) {
  const tokens = useMobileTokens();
  // The selected segment sits lighter than the track in both palettes.
  const selectedFill = useResolvedAppearance() === "light" ? tokens.card : tokens.chatUser;
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={{ flexDirection: "row", padding: 2, borderRadius: 10, backgroundColor: tokens.accent }}
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              alignItems: "center",
              backgroundColor: selected ? selectedFill : "transparent",
              borderRadius: 8,
              paddingVertical: 8,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <Text style={{ color: selected ? tokens.foreground : tokens.mutedForeground }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
