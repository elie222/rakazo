import { CALL_AUTO_LANGUAGE_KEY } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";

export async function loadCallAutoLanguage(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CALL_AUTO_LANGUAGE_KEY)) === "1";
}

export async function saveCallAutoLanguage(enabled: boolean): Promise<void> {
  if (enabled) await SecureStore.setItemAsync(CALL_AUTO_LANGUAGE_KEY, "1");
  else await SecureStore.deleteItemAsync(CALL_AUTO_LANGUAGE_KEY);
}
