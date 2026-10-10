import * as SecureStore from "expo-secure-store";

const KEY = "rakazo.artifact-cache-session";
let revision = 0;
let writes: Promise<unknown> = Promise.resolve();
let active: { token: string; namespace: string; persisted: boolean } | undefined;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writes.then(task, task);
  writes = next.catch(() => undefined);
  return next;
}

/** Rotate the disk namespace even when sign-out cannot wipe persistent storage. */
export function invalidateArtifactCacheSession(): Promise<void> {
  revision += 1;
  const cleared = { token: "", namespace: newNamespace() };
  active = { ...cleared, persisted: false };
  return enqueue(async () => {
    try {
      await SecureStore.deleteItemAsync(KEY);
    } catch {
      try {
        await SecureStore.setItemAsync(KEY, JSON.stringify(cleared));
      } catch {
        // The next session read uses a fresh namespace even if persistence stays unavailable.
      }
    }
  });
}

function newNamespace(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Tokens remain in SecureStore; disk paths contain only an opaque namespace. */
export function artifactCacheSession(token: string): Promise<string> {
  const version = revision;
  return enqueue(async () => {
    if (!token || version !== revision) throw new Error("Artifact session changed");
    let entry = active;
    if (!entry) {
      try {
        const stored = JSON.parse((await SecureStore.getItemAsync(KEY)) || "null");
        if (
          stored?.token === token &&
          typeof stored.namespace === "string" &&
          /^[a-z0-9]+-[a-z0-9]+$/.test(stored.namespace)
        )
          entry = { token, namespace: stored.namespace, persisted: true };
      } catch {
        // Missing or invalid metadata is a cold cache.
      }
    }
    if (version !== revision) throw new Error("Artifact session changed");
    if (!entry || entry.token !== token)
      entry = { token, namespace: newNamespace(), persisted: false };
    try {
      await SecureStore.setItemAsync(
        KEY,
        JSON.stringify({ token: entry.token, namespace: entry.namespace }),
      );
      entry.persisted = true;
    } catch {
      // Failed persistence must not authorize files from a previous process.
      if (entry.persisted) entry = { token, namespace: newNamespace(), persisted: false };
    }
    if (version !== revision) throw new Error("Artifact session changed");
    active = entry;
    return entry.namespace;
  });
}
