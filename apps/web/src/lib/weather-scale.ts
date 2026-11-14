import type { WeatherScale } from "@rakazo/core";
import { defaultWeatherScale } from "@rakazo/core";
import { useSyncExternalStore } from "react";

const KEY = "rakazo.weatherScale";
const listeners = new Set<() => void>();

function stored(): WeatherScale | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "celsius" || value === "fahrenheit" ? value : null;
  } catch {
    return null;
  }
}

/** The unit the user picked on any weather card, which every card follows. */
export function setWeatherScale(scale: WeatherScale) {
  try {
    localStorage.setItem(KEY, scale);
  } catch {
    // A card still follows the pick this session through the listeners.
    picked = scale;
  }
  for (const listener of listeners) listener();
}

let picked: WeatherScale | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The picked unit, or °F/°C from the browser's own locale (en-GB, en-US) until one is picked. */
export function useWeatherScale(): WeatherScale {
  const pick = useSyncExternalStore(
    subscribe,
    () => stored() ?? picked,
    () => null,
  );
  return pick ?? defaultWeatherScale(navigator.language);
}
