import type { WeatherScale } from "@rakazo/core";
import { defaultWeatherScale } from "@rakazo/core";
import { useEffect, useSyncExternalStore } from "react";
import { deviceLanguage } from "./i18n";

const STORAGE_KEY = "rakazo.weatherScale";
const listeners = new Set<() => void>();
let picked: WeatherScale | null = null;
let fallback: WeatherScale = "celsius";
let loaded = false;

function emit() {
  for (const listener of listeners) listener();
}

/** Reads the saved pick and the device's own unit once; cards render with Celsius until then. */
async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const localization = await import("expo-localization");
    const unit = localization.getLocales()[0]?.temperatureUnit;
    if (unit === "celsius" || unit === "fahrenheit") fallback = unit;
    else fallback = defaultWeatherScale((await deviceLanguage()) ?? undefined);
  } catch {
    fallback = defaultWeatherScale((await deviceLanguage()) ?? undefined);
  }
  try {
    const SecureStore = await import("expo-secure-store");
    const value = await SecureStore.getItemAsync(STORAGE_KEY);
    if (value === "celsius" || value === "fahrenheit") picked = value;
  } catch {
    // Keep the device's unit.
  }
  emit();
}

/** The unit picked on any weather card, which every card follows. */
export function setWeatherScale(scale: WeatherScale) {
  picked = scale;
  emit();
  void import("expo-secure-store")
    .then((SecureStore) => SecureStore.setItemAsync(STORAGE_KEY, scale))
    .catch(() => {
      // The pick still applies until the app restarts.
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => picked ?? fallback;

/** The picked unit, or the device's own until one is picked. */
export function useWeatherScale(): WeatherScale {
  useEffect(() => {
    void load();
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function resetWeatherScaleForTests() {
  picked = null;
  fallback = "celsius";
  loaded = false;
}
