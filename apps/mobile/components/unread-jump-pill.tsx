import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { Pressable, StyleSheet, Text } from "react-native";
import { useMobileTokens } from "../lib/native";
import type { JumpDirection } from "../lib/offscreen-unreads";
import { GlassSurface } from "./glass-surface";
import { NativeSymbol } from "./native-symbol";

export const UNREAD_JUMP_PILL_HEIGHT = 38;

/** An unread-blue glass capsule with a directional chevron and label. */
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
          backgroundColor: tokens.unread,
          boxShadow: "0 2px 6px rgba(0, 0, 0, 0.22)",
        }}
      >
        <NativeSymbol
          ios={direction === "above" ? "chevron.up" : "chevron.down"}
          android={direction === "above" ? "chevron-up" : "chevron-down"}
          size={16}
          weight="semibold"
          color={onFill}
        />
        <Text style={[styles.label, { color: onFill }]}>{label}</Text>
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
    paddingStart: 12,
    paddingEnd: 14,
  },
  label: {
    ...typeScale.secondary,
    fontWeight: fontWeight.medium,
  },
});
