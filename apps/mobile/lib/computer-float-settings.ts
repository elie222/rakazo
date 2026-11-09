import { useSyncExternalStore } from "react";

const COMPUTER_FLOAT_ENABLED_KEY = "rakazo.computer-float-enabled";

type EnabledMap = Record<string, boolean>;
let enabled: EnabledMap = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

async function loadEnabled(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        // Deferred so importing this module never pulls the native store into tests.
        const SecureStore = await import("expo-secure-store");
        const stored = JSON.parse(
          (await SecureStore.getItemAsync(COMPUTER_FLOAT_ENABLED_KEY)) ?? "null",
        ) as EnabledMap | null;
        if (stored && typeof stored === "object") enabled = stored;
      } catch {
        // Unreadable storage keeps every bot's float on, the default.
      }
      loaded = true;
      notify();
    })();
  }
  await loading;
}

let saving: Promise<void> = Promise.resolve();

/** Whether this bot's computer float may open. On unless the bot was switched off. */
export function computerFloatEnabledFor(botId: string | undefined): boolean {
  if (!botId) return true;
  return enabled[botId] ?? true;
}

export function useComputerFloatEnabled(botId: string | undefined): boolean {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      void loadEnabled();
      return () => {
        listeners.delete(listener);
      };
    },
    () => computerFloatEnabledFor(botId),
  );
  return computerFloatEnabledFor(botId);
}

/** Switches a bot's computer float; the change is local to this device. */
export function setComputerFloatEnabled(botId: string, value: boolean): void {
  enabled = { ...enabled, [botId]: value };
  notify();
  const snapshot = JSON.stringify(enabled);
  saving = saving
    .then(async () => {
      const SecureStore = await import("expo-secure-store");
      await SecureStore.setItemAsync(COMPUTER_FLOAT_ENABLED_KEY, snapshot);
    })
    .catch(() => undefined);
}
