import type { ModelUsageSort, ModelUsageSortInverted } from "@rakazo/core";
import {
  LEGACY_MODEL_USAGE_SORT_DIRECTION_KEY,
  MODEL_USAGE_SORT_INVERTED_KEY,
  MODEL_USAGE_SORT_KEY,
  normalizeModelUsageSort,
  normalizeModelUsageSortInverted,
} from "@rakazo/core";

let preference: ModelUsageSort | null = null;
let invertedPreference: ModelUsageSortInverted | null = null;
const listeners = new Set<() => void>();

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function getModelUsageSort(): ModelUsageSort {
  if (preference) return preference;
  try {
    preference = normalizeModelUsageSort(storage()?.getItem(MODEL_USAGE_SORT_KEY));
  } catch {
    preference = "quota";
  }
  return preference;
}

export function getModelUsageSortInverted(): ModelUsageSortInverted {
  if (invertedPreference !== null) return invertedPreference;
  try {
    const storedInverted = storage()?.getItem(MODEL_USAGE_SORT_INVERTED_KEY);
    const legacyDirection = storage()?.getItem(LEGACY_MODEL_USAGE_SORT_DIRECTION_KEY);
    const legacyOrder = storage()?.getItem(MODEL_USAGE_SORT_KEY);
    invertedPreference = normalizeModelUsageSortInverted(
      storedInverted ?? legacyDirection ?? legacyOrder,
    );
  } catch {
    invertedPreference = false;
  }
  return invertedPreference;
}

export function setModelUsageSort(value: ModelUsageSort): void {
  preference = normalizeModelUsageSort(value);
  try {
    storage()?.setItem(MODEL_USAGE_SORT_KEY, preference);
  } catch {
    // Keep the in-memory choice if browser storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function setModelUsageSortInverted(value: ModelUsageSortInverted): void {
  invertedPreference = value;
  try {
    storage()?.setItem(MODEL_USAGE_SORT_INVERTED_KEY, String(invertedPreference));
  } catch {
    // Keep the in-memory choice if browser storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function subscribeModelUsageSort(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
