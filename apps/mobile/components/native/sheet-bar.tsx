import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import { GlassIconButton } from "./glass-icon-button";
import { GlassSurface } from "./glass-surface";

/**
 * The top bar of a modal sheet drawn in React Native, laid out like a native sheet's bar: a round
 * glass close on the leading edge and the sheet's action on the trailing edge. Route sheets use
 * native header items instead; this is for sheets opened in place over a screen, which hold that
 * screen's state (a text selection, an unsaved draft) and have no navigation header.
 */
export function SheetBar({ leading, trailing }: { leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 8,
      }}
    >
      {leading ?? <View />}
      {trailing}
    </View>
  );
}

/** Closes or cancels the sheet. */
export function SheetBarClose({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <GlassIconButton
      accessibilityLabel={label}
      ios="xmark"
      android="close"
      size={44}
      fallbackStyle={{ backgroundColor: mobileTokens().muted }}
      disabled={disabled}
      onPress={onPress}
    />
  );
}

/** Returns to the sheet's previous page. */
export function SheetBarBack({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <GlassIconButton
      accessibilityLabel={label}
      ios="chevron.left"
      android="chevron-back"
      size={44}
      fallbackStyle={{ backgroundColor: mobileTokens().muted }}
      onPress={onPress}
    />
  );
}

/**
 * Commits the sheet with its verb (Save, Quote) on a filled capsule, like the native bar's
 * prominent item: a specific action reads more clearly as a word than as a checkmark.
 */
export function SheetBarConfirm({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const tokens = mobileTokens();
  return (
    <GlassSurface
      tint={disabled ? undefined : tokens.primary}
      style={{ height: 44, borderRadius: 22, justifyContent: "center" }}
      fallbackStyle={{ backgroundColor: disabled ? tokens.muted : tokens.primary }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={disabled ? { disabled: true } : undefined}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => ({
          height: 44,
          paddingHorizontal: 18,
          justifyContent: "center",
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text
          style={{
            fontSize: 17,
            fontWeight: "600",
            color: disabled ? tokens.mutedForeground : tokens.primaryForeground,
          }}
        >
          {label}
        </Text>
      </Pressable>
    </GlassSurface>
  );
}
