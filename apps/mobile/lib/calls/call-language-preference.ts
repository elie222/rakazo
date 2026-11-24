import { t } from "@lingui/core/macro";
import { callAutoLanguagePreference } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";

export async function loadCallAutoLanguage(): Promise<boolean> {
  const { key, parse } = callAutoLanguagePreference;
  return parse(await SecureStore.getItemAsync(key));
}

export async function saveCallAutoLanguage(enabled: boolean): Promise<void> {
  const { key, serialize } = callAutoLanguagePreference;
  const value = serialize(enabled);
  if (value !== null) await SecureStore.setItemAsync(key, value);
  else await SecureStore.deleteItemAsync(key);
}

export function autoLanguageNeedsTranscription(): string {
  return t`Connect a voice provider that transcribes, or turn off automatic language detection in Voice settings.`;
}
