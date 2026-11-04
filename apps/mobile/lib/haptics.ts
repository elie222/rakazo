import * as Haptics from "expo-haptics";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

const STORAGE_KEY = "rakazo.haptics";
let enabled = true;
let loaded = false;
let changedLocally = false;
let loadTask: Promise<void> | undefined;
let writeTask = Promise.resolve();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getHapticsEnabled(): boolean {
  return enabled;
}

export function subscribeHaptics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function loadHapticsPreference(): Promise<void> {
  if (loadTask) return loadTask;
  // Cache the task before storage runs, including adapters that can throw synchronously.
  loadTask = Promise.resolve().then(async () => {
    try {
      const stored = await SecureStore.getItemAsync(STORAGE_KEY);
      if (!changedLocally) enabled = stored !== "false";
      loaded = true;
    } catch {
      // Allow a later retry without enabling feedback or undoing an explicit choice.
      loadTask = undefined;
    } finally {
      notify();
    }
  });
  return loadTask;
}

export function setHapticsEnabled(value: boolean): Promise<void> {
  enabled = value;
  changedLocally = true;
  loaded = true;
  notify();
  // Keep rapid toggles in order on disk without delaying the switch or feedback gate.
  const writing = writeTask.then(() => SecureStore.setItemAsync(STORAGE_KEY, String(value)));
  // Report this save's failure to the caller while allowing the next save to run.
  writeTask = writing.catch(() => undefined);
  return writing;
}

function perform(effect: () => Promise<void>): void {
  if (AppState.currentState !== "active" || (Platform.OS !== "ios" && Platform.OS !== "android")) {
    return;
  }
  if (!loaded) {
    void loadHapticsPreference();
    return;
  }
  if (!enabled) return;
  try {
    void effect().catch(() => undefined);
  } catch {
    // Older native binaries and devices without haptics must keep the action usable.
  }
}

// Android's view feedback honors the system touch settings and supplies native effects.
export function hapticSelection(): void {
  perform(() =>
    Platform.OS === "android"
      ? Haptics.performAndroidHapticsAsync(
          Platform.Version >= 34
            ? Haptics.AndroidHaptics.Segment_Tick
            : Haptics.AndroidHaptics.Clock_Tick,
        )
      : Haptics.selectionAsync(),
  );
}

export function hapticImpact(): void {
  perform(() =>
    Platform.OS === "android"
      ? Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Context_Click)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  );
}

export function hapticSuccess(): void {
  perform(() =>
    Platform.OS === "android"
      ? Haptics.performAndroidHapticsAsync(
          Platform.Version >= 30
            ? Haptics.AndroidHaptics.Confirm
            : Haptics.AndroidHaptics.Context_Click,
        )
      : Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  );
}
