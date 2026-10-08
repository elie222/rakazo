import { tokensForAppearance } from "@rakazo/ui-tokens";
import { useMemo, useSyncExternalStore } from "react";
import type { ColorValue } from "react-native";
import { AccessibilityInfo, Platform, PlatformColor } from "react-native";
import type { ResolvedAppearance } from "./appearance";
import {
  getCachedAppearancePreference,
  mobileTokens,
  resolveMobileAppearance,
  subscribeAppearance,
} from "./appearance";

let darkerSystemColors = false;
let watchingDarkerSystemColors = false;
const darkerSystemColorsListeners = new Set<() => void>();

function setDarkerSystemColors(enabled: boolean) {
  if (enabled === darkerSystemColors) return;
  darkerSystemColors = enabled;
  for (const listener of darkerSystemColorsListeners) listener();
}

function subscribeDarkerSystemColors(listener: () => void): () => void {
  darkerSystemColorsListeners.add(listener);
  if (Platform.OS === "ios" && !watchingDarkerSystemColors) {
    watchingDarkerSystemColors = true;
    // The initial read can resolve after a change event; the event is newer, so it wins.
    let changed = false;
    AccessibilityInfo.addEventListener("darkerSystemColorsChanged", (enabled) => {
      changed = true;
      setDarkerSystemColors(enabled);
    });
    void AccessibilityInfo.isDarkerSystemColorsEnabled()
      .then((enabled) => {
        if (!changed) setDarkerSystemColors(enabled);
      })
      .catch(() => undefined);
  }
  return () => {
    darkerSystemColorsListeners.delete(listener);
  };
}

function systemColor(iosName: string, fallback: string): ColorValue {
  // PlatformColor follows the OS scheme, not an explicit app Light/Dark choice.
  if (Platform.OS === "ios" && getCachedAppearancePreference() === "system") {
    return PlatformColor(iosName);
  }
  return fallback;
}

/** Theme-aware native colors backed by shared tokens (+ iOS platform colors in System). */
export const native = {
  get page() {
    return mobileTokens().background;
  },
  get fill() {
    return systemColor("tertiarySystemFill", mobileTokens().muted);
  },
  get fillPressed() {
    return systemColor("secondarySystemFill", mobileTokens().accent);
  },
  get separator() {
    // The page color reads as a gap between rows on a fill in either palette.
    return systemColor("separator", mobileTokens().background);
  },
  get label() {
    return systemColor("label", mobileTokens().foreground);
  },
  get secondaryLabel() {
    return systemColor("secondaryLabel", mobileTokens().mutedForeground);
  },
  get tertiaryLabel() {
    return systemColor("tertiaryLabel", mobileTokens().mutedForeground);
  },
  get groupedPage() {
    const tokens = mobileTokens();
    // Dark `muted` is the card colour, so the dark page falls back to `background`.
    return systemColor(
      "systemGroupedBackground",
      resolveMobileAppearance() === "dark" ? tokens.background : tokens.muted,
    );
  },
  get groupedCell() {
    // Increase Contrast lightens the dark iOS cell until destructive text drops below 4.5:1.
    if (darkerSystemColors && resolveMobileAppearance() === "dark") return mobileTokens().card;
    return systemColor("secondarySystemGroupedBackground", mobileTokens().card);
  },
} as const;

function appearanceSnapshot(): string {
  return `${getCachedAppearancePreference()}:${resolveMobileAppearance()}`;
}

export function useResolvedAppearance(): ResolvedAppearance {
  // Include the preference: System -> Light must replace iOS PlatformColor
  // objects even when both currently resolve to light.
  useSyncExternalStore(subscribeAppearance, appearanceSnapshot, () => "system:dark");
  return resolveMobileAppearance();
}

/** Rebuild styles for palette changes and switches to/from iOS system colors. */
export function useThemedStyles<T>(factory: () => T): T {
  const resolved = useResolvedAppearance();
  const preference = getCachedAppearancePreference();
  const darker = useSyncExternalStore(
    subscribeDarkerSystemColors,
    () => darkerSystemColors,
    () => false,
  );
  return useMemo(factory, [resolved, preference, darker]);
}

/** Subscribe custom surfaces to the same appearance as native navigation. */
export function useMobileTokens() {
  return tokensForAppearance(useResolvedAppearance());
}
