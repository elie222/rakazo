import {
  COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  parseComposerEnterToSend,
  serializeComposerEnterToSend,
} from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

let preference: boolean | null = null;
const listeners = new Set<() => void>();

function update(value: boolean | null) {
  preference = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function hardwareEnterEnabled() {
  return preference ?? true;
}

export function useComposerHardwareEnterPreference(): boolean {
  return useSyncExternalStore(subscribe, hardwareEnterEnabled, hardwareEnterEnabled);
}

export async function loadComposerEnterToSendPreference(): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(COMPOSER_ENTER_TO_SEND_STORAGE_KEY);
    if (preference === null) update(parseComposerEnterToSend(raw));
  } catch {
    // Unreadable storage keeps the hardware keyboard default.
  }
}

let writes = Promise.resolve();

export async function setComposerEnterToSendPreference(enabled: boolean): Promise<void> {
  update(enabled);
  writes = writes.then(async () => {
    try {
      await SecureStore.setItemAsync(
        COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
        serializeComposerEnterToSend(enabled),
      );
    } catch {
      // Keep the choice for the current session if storage is unavailable.
    }
  });
  await writes;
}
