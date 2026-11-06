import { useSyncExternalStore } from "react";

/** Reads a saved string. Missing, blocked, or unavailable storage reads as nothing saved. */
export function readStoredString(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Saves a string, or removes the key for `null`. Storage failures are ignored. */
export function writeStoredString(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode / quota: the in-memory value still applies.
  }
}

export type StoredPreference<T> = {
  get(): T;
  set(value: T): T;
  subscribe(listener: () => void): () => void;
  use(): T;
};

/**
 * A device-local preference: read once from storage, kept in memory, and shared with every
 * subscriber. `parse` receives `null` when nothing is saved or storage is unreadable, so it also
 * decides the default; `serialize` returning `null` removes the key.
 */
export function createStoredPreference<T>({
  key,
  parse,
  serialize,
}: {
  key: string;
  parse: (raw: string | null) => T;
  serialize: (value: T) => string | null;
}): StoredPreference<T> {
  const listeners = new Set<() => void>();
  let loaded = false;
  let current: T;

  function get(): T {
    if (!loaded) {
      current = parse(readStoredString(key));
      loaded = true;
    }
    return current;
  }

  function set(value: T): T {
    current = value;
    loaded = true;
    writeStoredString(key, serialize(value));
    for (const listener of listeners) listener();
    return value;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    get,
    set,
    subscribe,
    use: () => useSyncExternalStore(subscribe, get, get),
  };
}
