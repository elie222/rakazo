import { bestEffort } from "@rakazo/logging/best-effort";
import * as SecureStore from "expo-secure-store";

export function createDeviceBooleanPreference(key: string, defaultValue: boolean) {
  let value = defaultValue;
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();

  function update(next: boolean) {
    value = next;
    for (const listener of listeners) listener();
  }

  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load() {
      const pending = writes;
      const stored = await bestEffort(`read preference ${key}`, SecureStore.getItemAsync(key));
      // A toggle made while storage was loading takes precedence.
      if (writes === pending && stored !== undefined) {
        const flag = stored?.trim().toLowerCase();
        update(flag === "on" || (flag !== "off" && defaultValue));
      }
      return value;
    },
    async set(next: boolean) {
      // Store quick toggles in order and update the visible value before I/O completes.
      writes = writes.then(async () => {
        await bestEffort(
          `save preference ${key}`,
          SecureStore.setItemAsync(key, next ? "on" : "off"),
        );
      });
      update(next);
      await writes;
      return next;
    },
  };
}
