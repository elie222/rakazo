import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
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
    <View style={styles.bar}>
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
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Shows progress in place of the label, keeping the button's width. */
  busy?: boolean;
}) {
  const tokens = mobileTokens();
  // While busy it keeps the primary fill, so the spinner shows even when the draft it saves
  // has already been cleared.
  const dimmed = disabled && !busy;
  return (
    <GlassSurface
      tint={dimmed ? undefined : tokens.primary}
      style={styles.confirm}
      fallbackStyle={{ backgroundColor: dimmed ? tokens.muted : tokens.primary }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={disabled || busy ? { disabled: true, busy } : undefined}
        disabled={disabled || busy}
        onPress={onPress}
        style={({ pressed }) => [styles.confirmPress, pressed && styles.pressed]}
      >
        <Text
          style={[
            styles.confirmLabel,
            { color: dimmed ? tokens.mutedForeground : tokens.primaryForeground },
            busy && styles.hidden,
          ]}
        >
          {label}
        </Text>
        {busy ? (
          <ActivityIndicator color={tokens.primaryForeground} style={styles.spinner} />
        ) : null}
      </Pressable>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  confirm: { height: 44, borderRadius: 22, justifyContent: "center" },
  confirmPress: { height: 44, paddingHorizontal: 18, justifyContent: "center" },
  confirmLabel: { ...typeScale.body, fontWeight: fontWeight.semibold },
  pressed: { opacity: 0.6 },
  hidden: { opacity: 0 },
  spinner: { position: "absolute", start: 0, end: 0 },
});
