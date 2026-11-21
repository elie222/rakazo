import { t } from "@lingui/core/macro";
import { CALL_AUTO_LANGUAGE_KEY } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";

export async function loadCallAutoLanguage(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CALL_AUTO_LANGUAGE_KEY)) === "1";
}

export async function saveCallAutoLanguage(enabled: boolean): Promise<void> {
  if (enabled) await SecureStore.setItemAsync(CALL_AUTO_LANGUAGE_KEY, "1");
  else await SecureStore.deleteItemAsync(CALL_AUTO_LANGUAGE_KEY);
}

export function autoLanguageNeedsTranscription(): string {
  return t`Connect a voice provider that transcribes, or turn off automatic language detection in Voice settings.`;
}
