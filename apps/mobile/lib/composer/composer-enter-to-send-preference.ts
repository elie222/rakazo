import { useSyncExternalStore } from "react";
import { createDeviceBooleanPreference } from "./device-boolean-preference";

const preference = createDeviceBooleanPreference("rakazo.composerEnterToSend", true);

export const { load: loadComposerEnterToSendPreference, set: setComposerEnterToSendPreference } =
  preference;

export function useComposerHardwareEnterPreference(): boolean {
  return useSyncExternalStore(preference.subscribe, preference.get, preference.get);
}
