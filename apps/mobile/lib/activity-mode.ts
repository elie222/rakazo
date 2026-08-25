import * as SecureStore from "expo-secure-store";

/** Persisted Codex-style recency mode for home Now/Recent. Default off. */
export const ACTIVITY_MODE_KEY = "rakazo.activity-mode";

export async function loadActivityMode(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(ACTIVITY_MODE_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function saveActivityMode(on: boolean): Promise<void> {
  try {
    if (on) await SecureStore.setItemAsync(ACTIVITY_MODE_KEY, "1");
    else await SecureStore.deleteItemAsync(ACTIVITY_MODE_KEY);
  } catch {
    // SecureStore unavailable in some test / web hosts.
  }
}
