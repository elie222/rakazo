import type { ReactNode } from "react";
import { View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import { GlassIconButton } from "./glass-icon-button";

/**
 * The top bar of a modal sheet drawn in React Native, laid out like a native sheet's bar: round
 * glass buttons at either edge, so it matches the sheets that use native header items. Route
 * sheets use those header items instead; this is for sheets opened in place over a screen, which
 * hold that screen's state (a text selection, an unsaved draft) and have no navigation header.
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

/** Commits the sheet; filled, like the native bar's done item. */
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
    <GlassIconButton
      accessibilityLabel={label}
      ios="checkmark"
      android="checkmark"
      size={44}
      tint={tokens.primary}
      color={tokens.primaryForeground}
      fallbackStyle={{ backgroundColor: tokens.primary }}
      disabled={disabled}
      onPress={onPress}
    />
  );
}
