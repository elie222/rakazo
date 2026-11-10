import { Pressable, StyleSheet } from "react-native";
import { native, useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

export type ScrollToBottomButtonProps = {
  accessibilityLabel: string;
  onPress: () => void;
};

export function ScrollToBottomButtonFallback({
  accessibilityLabel,
  onPress,
}: ScrollToBottomButtonProps) {
  const tokens = useMobileTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      android_ripple={{ color: native.fillPressed, borderless: true, radius: 22 }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: native.fill,
          borderColor: native.fillPressed,
          shadowColor: tokens.foreground,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      <NativeSymbol ios="chevron.down" android="chevron-down" size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 2,
  },
});
