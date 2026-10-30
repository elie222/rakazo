import * as SecureStore from "expo-secure-store";

const KEY = "rakazo.artifact-cache-session";
let revision = 0;
let writes: Promise<unknown> = Promise.resolve();
type Entry = {
  token: string;
  namespace: string;
  persisted: boolean;
  /** A rotation not yet saved: disk still names the previous token, so reads must not save it. */
  unsaved?: boolean;
  /**
   * The token a rotation replaced; a late read with it must not start a new namespace. Saved as
   * `previous`, so a restart that still finds it as the session token adopts `token` instead.
   */
  retired?: string;
};
let active: Entry | undefined;

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

/** The saved entry, for `token` only when one is given. */
async function storedEntry(token?: string): Promise<Entry | undefined> {
  try {
    return parseEntry(await SecureStore.getItemAsync(KEY), token);
  } catch {
    // Missing or invalid metadata is a cold cache.
    return undefined;
  }
}

function parseEntry(raw: string | null, token?: string): Entry | undefined {
  try {
    const stored = JSON.parse(raw || "null");
    if (
      typeof stored?.token === "string" &&
      stored.token &&
      (token === undefined || stored.token === token) &&
      typeof stored.namespace === "string" &&
      /^[a-z0-9]+-[a-z0-9]+$/.test(stored.namespace)
    )
      return {
        token: stored.token,
        namespace: stored.namespace,
        persisted: true,
        retired: typeof stored.previous === "string" ? stored.previous : undefined,
      };
  } catch {
    // Invalid metadata is no entry.
  }
  return undefined;
}

function record(entry: Entry): string {
  return JSON.stringify({
    token: entry.token,
    namespace: entry.namespace,
    previous: entry.retired,
  });
}

/**
 * The token a password change saved here when `stored` is the token it replaced. Rejects when the
 * record cannot be read, so the caller can tell an unread record from a missing one.
 */
export async function rotatedArtifactCacheToken(stored: string): Promise<string | undefined> {
  const entry = parseEntry(await SecureStore.getItemAsync(KEY));
  return entry?.retired === stored ? entry.token : undefined;
}

/**
 * Moves the namespace to a new token of the same account, so files saved under it stay usable.
 * Rejects when the namespace could not be saved; until a later call saves it, reads return it
 * without saving, so disk never pairs the namespace with a token the session has not saved.
 * Pass the same token twice to retry the save.
 */
export function rotateArtifactCacheSession(previous: string, token: string): Promise<void> {
  if (previous !== token) revision += 1;
  const version = revision;
  return enqueue(async () => {
    let entry = active ?? (await storedEntry(previous));
    if (version !== revision) throw new Error("Artifact session changed");
    if (entry?.token !== previous) entry = undefined;
    const next: Entry = {
      token,
      namespace: entry?.namespace ?? newNamespace(),
      persisted: false,
      unsaved: true,
      retired: previous === token ? entry?.retired : previous,
    };
    active = next;
    await SecureStore.setItemAsync(KEY, record(next));
    next.persisted = true;
    next.unsaved = false;
  });
}

/** Tokens remain in SecureStore; disk paths contain only an opaque namespace. */
export function artifactCacheSession(token: string): Promise<string> {
  const version = revision;
  return enqueue(async () => {
    if (!token || version !== revision) throw new Error("Artifact session changed");
    let entry = active ?? (await storedEntry(token));
    if (version !== revision || entry?.retired === token)
      throw new Error("Artifact session changed");
    if (entry?.token === token && entry.unsaved) return entry.namespace;
    if (!entry || entry.token !== token)
      entry = { token, namespace: newNamespace(), persisted: false };
    try {
      await SecureStore.setItemAsync(KEY, record(entry));
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
