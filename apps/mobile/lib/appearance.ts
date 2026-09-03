import {
  type AppearancePreference,
  normalizeAppearancePreference,
  type ResolvedAppearance,
  resolveAppearance,
  tokensForAppearance,
  UI_APPEARANCE_STORAGE_KEY,
} from "@rakazo/ui-tokens";
import * as SecureStore from "expo-secure-store";
import { Appearance, type ColorSchemeName } from "react-native";

export type { AppearancePreference, ResolvedAppearance };

let memoryPreference: AppearancePreference | null = null;
const listeners = new Set<() => void>();

function systemAppearance(scheme?: ColorSchemeName | null): ResolvedAppearance {
  return (scheme ?? Appearance.getColorScheme()) === "light" ? "light" : "dark";
}

export function getCachedAppearancePreference(): AppearancePreference {
  return memoryPreference ?? "system";
}

export async function loadAppearancePreference(): Promise<AppearancePreference> {
  try {
    const stored = await SecureStore.getItemAsync(UI_APPEARANCE_STORAGE_KEY);
    memoryPreference = normalizeAppearancePreference(stored);
  } catch {
    memoryPreference = memoryPreference ?? "system";
  }
  return memoryPreference;
}

export async function setAppearancePreference(
  preference: AppearancePreference,
): Promise<AppearancePreference> {
  memoryPreference = preference;
  try {
    await SecureStore.setItemAsync(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Keep the in-memory preference when SecureStore is unavailable.
  }
  notify();
  return preference;
}

export function resolveMobileAppearance(
  preference: AppearancePreference = getCachedAppearancePreference(),
  scheme?: ColorSchemeName | null,
): ResolvedAppearance {
  return resolveAppearance(preference, systemAppearance(scheme));
}

export function mobileTokens(
  preference: AppearancePreference = getCachedAppearancePreference(),
  scheme?: ColorSchemeName | null,
) {
  return tokensForAppearance(resolveMobileAppearance(preference, scheme));
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of listeners) listener();
}

Appearance.addChangeListener(() => {
  if (getCachedAppearancePreference() === "system") notify();
});
