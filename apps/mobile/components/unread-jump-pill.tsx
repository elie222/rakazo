import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { Pressable, StyleSheet, Text } from "react-native";
import { useMobileTokens } from "../lib/native";
import type { JumpDirection } from "../lib/offscreen-unreads";
import { GlassSurface } from "./glass-surface";
import { NativeSymbol } from "./native-symbol";

export const UNREAD_JUMP_PILL_HEIGHT = 44;

/** An unread-blue capsule with its label and a directional chevron. */
export function UnreadJumpPill({
  direction,
  label,
  accessibilityLabel,
  onPress,
}: {
  direction: JumpDirection;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const tokens = useMobileTokens();
  // White on the tinted glass in both themes, like the user bubble's text.
  const onFill = tokens.chatUserForeground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <GlassSurface
        tint={tokens.unread}
        style={styles.pill}
        fallbackStyle={{
          borderWidth: 0,
          boxShadow: "0 6px 20px rgba(0, 0, 0, 0.5)",
        }}
      >
        <Text style={[styles.label, { color: onFill }]}>{label}</Text>
        <NativeSymbol
          ios={direction === "above" ? "chevron.up" : "chevron.down"}
          android={direction === "above" ? "chevron-up" : "chevron-down"}
          size={20}
          color={onFill}
        />
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: UNREAD_JUMP_PILL_HEIGHT,
    borderRadius: UNREAD_JUMP_PILL_HEIGHT / 2,
    paddingStart: 20,
    paddingEnd: 16,
  },
  label: {
    ...typeScale.body,
    lineHeight: 22,
    fontWeight: fontWeight.medium,
  },
});
