import { useMemo, useSyncExternalStore } from "react";
import { type ColorValue, Platform, PlatformColor } from "react-native";
import {
  getCachedAppearancePreference,
  mobileTokens,
  type ResolvedAppearance,
  resolveMobileAppearance,
  subscribeAppearance,
} from "./appearance";

function systemColor(iosName: string, lightFallback: string, darkFallback: string): ColorValue {
  // PlatformColor follows the OS scheme, not an explicit app Light/Dark choice.
  if (Platform.OS === "ios" && getCachedAppearancePreference() === "system") {
    return PlatformColor(iosName);
  }
  return resolveMobileAppearance() === "light" ? lightFallback : darkFallback;
}

/** Theme-aware native colors backed by shared tokens (+ iOS platform colors in System). */
export const native = {
  get page() {
    return mobileTokens().background;
  },
  get fill() {
    return systemColor("tertiarySystemFill", mobileTokens().muted, "#1C1C1E");
  },
  get fillPressed() {
    return systemColor("secondarySystemFill", mobileTokens().accent, "#2C2C2E");
  },
  get label() {
    return systemColor("label", mobileTokens().foreground, "#FFFFFF");
  },
  get secondaryLabel() {
    return systemColor("secondaryLabel", mobileTokens().mutedForeground, "#8E8E93");
  },
  get tertiaryLabel() {
    return systemColor("tertiaryLabel", mobileTokens().mutedForeground, "#6C6C70");
  },
} as const;

export function useResolvedAppearance(): ResolvedAppearance {
  // Snapshot the resolved light/dark value, not the preference. Preference stays
  // "system" across OS scheme flips, so a preference snapshot would skip rerenders.
  return useSyncExternalStore(subscribeAppearance, resolveMobileAppearance, () => "dark" as const);
}

/** Rebuild styles when the resolved appearance changes (avoids frozen StyleSheet snapshots). */
export function useThemedStyles<T>(factory: () => T): T {
  const resolved = useResolvedAppearance();
  return useMemo(factory, [resolved]);
}
