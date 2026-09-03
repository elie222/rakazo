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
    return mobileTokens().page;
  },
  get fill() {
    return systemColor("tertiarySystemFill", mobileTokens().surface2, "#1C1C1E");
  },
  get fillPressed() {
    return systemColor("secondarySystemFill", mobileTokens().elevated, "#2C2C2E");
  },
  get label() {
    return systemColor("label", mobileTokens().ink, "#FFFFFF");
  },
  get secondaryLabel() {
    return systemColor("secondaryLabel", mobileTokens().muted, "#8E8E93");
  },
  get tertiaryLabel() {
    return systemColor("tertiaryLabel", mobileTokens().muted2, "#6C6C70");
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
