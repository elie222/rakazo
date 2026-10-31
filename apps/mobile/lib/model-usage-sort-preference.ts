import type { ModelUsageSort, ModelUsageSortInverted } from "@rakazo/core";
import {
  LEGACY_MODEL_USAGE_SORT_DIRECTION_KEY,
  MODEL_USAGE_SORT_INVERTED_KEY,
  MODEL_USAGE_SORT_KEY,
  normalizeModelUsageSort,
  normalizeModelUsageSortInverted,
} from "@rakazo/core";
import * as SecureStore from "expo-secure-store";

export async function loadModelUsageSort(): Promise<ModelUsageSort> {
  try {
    return normalizeModelUsageSort(await SecureStore.getItemAsync(MODEL_USAGE_SORT_KEY));
  } catch {
    return "quota";
  }
}

export async function loadModelUsageSortInverted(): Promise<ModelUsageSortInverted> {
  try {
    const storedInverted = await SecureStore.getItemAsync(MODEL_USAGE_SORT_INVERTED_KEY);
    const legacyDirection = await SecureStore.getItemAsync(LEGACY_MODEL_USAGE_SORT_DIRECTION_KEY);
    const legacyOrder = await SecureStore.getItemAsync(MODEL_USAGE_SORT_KEY);
    return normalizeModelUsageSortInverted(storedInverted ?? legacyDirection ?? legacyOrder);
  } catch {
    return false;
  }
}

export async function saveModelUsageSort(value: ModelUsageSort): Promise<ModelUsageSort> {
  const normalized = normalizeModelUsageSort(value);
  try {
    await SecureStore.setItemAsync(MODEL_USAGE_SORT_KEY, normalized);
  } catch {
    // Keep the current screen's choice if secure storage is unavailable.
  }
  return normalized;
}

export async function saveModelUsageSortInverted(
  value: ModelUsageSortInverted,
): Promise<ModelUsageSortInverted> {
  try {
    await SecureStore.setItemAsync(MODEL_USAGE_SORT_INVERTED_KEY, String(value));
  } catch {
    // Keep the current screen's choice if secure storage is unavailable.
  }
  return value;
}
