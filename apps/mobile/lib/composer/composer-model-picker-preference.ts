import * as SecureStore from "expo-secure-store";

export const COMPOSER_MODEL_PICKER_STORAGE_KEY = "rakazo.composerModelPicker";

let enabled = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Only a saved "on" shows the model in the message box. */
export function getCachedComposerModelPicker(): boolean {
  return enabled;
}

export async function loadComposerModelPickerPreference(): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync(COMPOSER_MODEL_PICKER_STORAGE_KEY);
    enabled = stored?.trim().toLowerCase() === "on";
  } catch {
    // Unreadable storage keeps the picker off.
  }
  notify();
  return enabled;
}

// Writes run one after another, so quick toggles store the last choice, not whichever lands last.
let writes = Promise.resolve();

export async function setComposerModelPicker(next: boolean): Promise<boolean> {
  enabled = next;
  // Paint the switch before SecureStore resolves.
  notify();
  writes = writes.then(async () => {
    try {
      await SecureStore.setItemAsync(COMPOSER_MODEL_PICKER_STORAGE_KEY, next ? "on" : "off");
    } catch {
      // Keep the in-memory choice when SecureStore is unavailable.
    }
  });
  await writes;
  return next;
}

export function subscribeComposerModelPicker(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
