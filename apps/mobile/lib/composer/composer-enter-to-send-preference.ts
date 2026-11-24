import { bestEffort } from "@rakazo/logging/best-effort";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

const COMPOSER_ENTER_TO_SEND_STORAGE_KEY = "rakazo.composerEnterToSend";

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
  const raw = await bestEffort(
    "read composer Enter preference",
    SecureStore.getItemAsync(COMPOSER_ENTER_TO_SEND_STORAGE_KEY),
  );
  if (preference === null && raw != null) update(raw !== "0");
}

let writes = Promise.resolve();

export async function setComposerEnterToSendPreference(enabled: boolean): Promise<void> {
  update(enabled);
  writes = writes.then(async () => {
    await bestEffort(
      "save composer Enter preference",
      SecureStore.setItemAsync(COMPOSER_ENTER_TO_SEND_STORAGE_KEY, enabled ? "1" : "0"),
    );
  });
  await writes;
}
