import * as SecureStore from "expo-secure-store";
import {
  invalidateArtifactCacheSession,
  rotateArtifactCacheSession,
  rotatedArtifactCacheToken,
} from "./artifact-cache-session";
import { stopLiveNotifications } from "./live-notifications";
import { clearNetworkCache } from "./network-cache";
import { clearFailedSends } from "./thread-feedback";

const SESSION_KEY = "rakazo.session_token";
const INTEGRATIONS_SCOPE_KEY = "rakazo.integrations-scope";

export type VerifiedIntegrationsScope = {
  apiBase: string;
  userId: string;
  spaceId: string;
  selectionId: string | null;
};
let scopeInvalidated = false;
let scopeWrites: Promise<void> = Promise.resolve();

function enqueueScopeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = scopeWrites.then(task, task);
  scopeWrites = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const sessionDiskCaches = new Set<() => void>();

/** Registers a disk cache that every session change (sign-in, sign-out, server switch) deletes. */
export function registerSessionDiskCache(clear: () => void): void {
  sessionDiskCaches.add(clear);
}

/** `keepUnsent` is for a new token of the same account and server; its unsent messages stay. */
function invalidateSessionCaches(keepUnsent = false): Promise<void> {
  scopeInvalidated = true;
  if (!keepUnsent) clearFailedSends();
  clearNetworkCache();
  for (const clear of sessionDiskCaches) {
    try {
      clear();
    } catch {
      // A failed disk wipe must not block the session change or the other wipes.
    }
  }
  const clearingArtifacts = keepUnsent ? undefined : invalidateArtifactCacheSession();
  return enqueueScopeWrite(async () => {
    await clearingArtifacts;
    try {
      await SecureStore.deleteItemAsync(INTEGRATIONS_SCOPE_KEY);
    } catch {
      try {
        await SecureStore.setItemAsync(INTEGRATIONS_SCOPE_KEY, "");
      } catch {
        // A failed wipe remains invalid in memory; token matching gates future reads.
      }
    }
  });
}

export async function loadVerifiedIntegrationsScope(): Promise<VerifiedIntegrationsScope | null> {
  const generation = sessionGeneration;
  if (scopeInvalidated) return null;
  try {
    const token = await snapshotSessionToken();
    const stored = await SecureStore.getItemAsync(INTEGRATIONS_SCOPE_KEY);
    if (
      !token.ok ||
      !token.value ||
      !stored ||
      generation !== sessionGeneration ||
      scopeInvalidated
    )
      return null;
    const data = JSON.parse(stored);
    if (
      data.token !== token.value ||
      typeof data.apiBase !== "string" ||
      !data.apiBase ||
      typeof data.userId !== "string" ||
      !data.userId ||
      typeof data.spaceId !== "string" ||
      !data.spaceId ||
      !(data.selectionId === null || typeof data.selectionId === "string")
    )
      return null;
    return {
      apiBase: data.apiBase,
      userId: data.userId,
      spaceId: data.spaceId,
      selectionId: data.selectionId,
    };
  } catch {
    return null;
  }
}

export async function saveVerifiedIntegrationsScope(
  generation: number,
  scope: VerifiedIntegrationsScope,
): Promise<void> {
  // The launch's first token read queues its recovery write, so it cannot run inside the queue.
  if (!(await snapshotSessionToken()).ok) return;
  return enqueueScopeWrite(async () => {
    if (generation !== sessionGeneration) return;
    const token = await snapshotSessionToken();
    if (!token.ok || !token.value || generation !== sessionGeneration) return;
    try {
      await SecureStore.setItemAsync(
        INTEGRATIONS_SCOPE_KEY,
        JSON.stringify({ ...scope, token: token.value }),
      );
      if (generation === sessionGeneration) scopeInvalidated = false;
    } catch {
      // Verified scope persistence is optional.
    }
  });
}

/** In-memory gate so a failed SecureStore wipe cannot keep sending the old bearer. */
let sessionInvalidated = false;
let sessionFallback: string | undefined;
/** Bumped by every session change, so a late response can tell it no longer owns the session. */
let sessionGeneration = 0;

let readySessionGeneration = 0;
export function currentReadySessionGeneration() {
  return readySessionGeneration;
}
const sessionListeners = new Set<() => void>();
export function subscribeSessionGeneration(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}
function publishSessionGeneration(ready = true) {
  if (ready) readySessionGeneration = sessionGeneration;
  for (const listener of sessionListeners) {
    try {
      listener();
    } catch {
      /* Observers cannot block an authentication change. */
    }
  }
}

export function currentSessionGeneration() {
  return sessionGeneration;
}

export async function loadSessionToken() {
  const snapshot = await snapshotSessionToken();
  return snapshot.ok ? snapshot.value : "";
}

export async function saveSessionToken(token: string) {
  const generation = ++sessionGeneration;
  publishSessionGeneration(false);
  sessionInvalidated = true;
  sessionFallback = undefined;
  const clearingScope = invalidateSessionCaches();
  await enqueueScopeWrite(() => SecureStore.setItemAsync(SESSION_KEY, token));
  await clearingScope;
  if (generation !== sessionGeneration) return;
  sessionInvalidated = false;
  sessionFallback = undefined;
  if (generation === sessionGeneration) publishSessionGeneration();
}

/** Clears the session. Returns false only when SecureStore could neither delete nor overwrite. */
export async function clearSessionToken(): Promise<boolean> {
  const generation = ++sessionGeneration;
  publishSessionGeneration(false);
  sessionInvalidated = true;
  sessionFallback = undefined;
  const clearingScope = invalidateSessionCaches();
  const clearingToken = clearStoredSessionToken(generation);
  await stopLiveNotifications(true).catch(() => undefined);
  const tokenCleared = await clearingToken;
  await clearingScope;
  if (generation === sessionGeneration) publishSessionGeneration();
  return tokenCleared;
}

async function clearStoredSessionToken(generation: number): Promise<boolean> {
  return enqueueScopeWrite(async () => {
    let cleared = false;
    try {
      await SecureStore.deleteItemAsync(SESSION_KEY);
      cleared = true;
    } catch {
      try {
        await SecureStore.setItemAsync(SESSION_KEY, "");
        cleared = true;
      } catch {
        // A failed wipe keeps the bearer invalid in memory.
      }
    }
    if (generation === sessionGeneration) {
      sessionInvalidated = !cleared;
      sessionFallback = undefined;
    }
    return cleared;
  });
}

/** Restores the current-server session in memory even when persistence is unavailable. */
export async function restoreSessionToken(token: string) {
  const generation = ++sessionGeneration;
  publishSessionGeneration(false);
  const clearingScope = invalidateSessionCaches();
  if (!token) {
    await clearingScope;
    if (generation !== sessionGeneration) return;
    sessionInvalidated = false;
    sessionFallback = undefined;
    if (generation === sessionGeneration) publishSessionGeneration();
    return;
  }
  try {
    await saveSessionToken(token);
  } catch {
    if (sessionGeneration === generation + 1) {
      sessionInvalidated = false;
      sessionFallback = token;
      publishSessionGeneration();
    }
  }
}

/**
 * Replaces the session only if nothing changed it since `generation` was read. The check and the
 * write start in the same tick, so a sign-out that begins later clears the replacement too.
 */
export async function replaceSessionTokenIfCurrent(
  generation: number,
  token: string,
): Promise<boolean> {
  if (generation !== sessionGeneration) return false;
  try {
    await saveSessionToken(token);
  } catch (error) {
    // The server already revoked the stored token; keep the replacement in memory unless
    // something else changed the session meanwhile, and still report that it was not saved.
    if (sessionGeneration === generation + 1) {
      sessionInvalidated = false;
      sessionFallback = token;
      publishSessionGeneration();
    }
    throw error;
  }
  return true;
}

/** A password change's token kept only in memory until it is saved with its cache namespace. */
let unsavedRotation: { generation: number; token: string } | undefined;

/**
 * Replaces the token the server reissued for the same account after a password change. Unlike
 * `replaceSessionTokenIfCurrent`, it keeps unsent messages and the cache namespace they live in.
 * The token is saved only after that namespace, which also records it as the revoked token's
 * replacement; a restart between the two saves adopts it. If a save fails, the token stays in
 * memory until `saveRotatedSessionToken`.
 */
export async function rotateSessionTokenIfCurrent(
  generation: number,
  previous: string,
  token: string,
): Promise<boolean> {
  if (generation !== sessionGeneration) return false;
  const rotation = ++sessionGeneration;
  publishSessionGeneration(false);
  sessionInvalidated = true;
  sessionFallback = undefined;
  unsavedRotation = undefined;
  const clearingScope = invalidateSessionCaches(true);
  try {
    await rotateArtifactCacheSession(previous, token);
    await saveRotatedToken(rotation, token);
  } catch (error) {
    if (rotation === sessionGeneration) {
      sessionInvalidated = false;
      sessionFallback = token;
      unsavedRotation = { generation: rotation, token };
      publishSessionGeneration();
    }
    throw error;
  }
  await clearingScope;
  if (rotation === sessionGeneration) {
    sessionInvalidated = false;
    publishSessionGeneration();
  }
  return true;
}

/** Retries saving a password change's token kept in memory; true when it saved one. */
export async function saveRotatedSessionToken(): Promise<boolean> {
  const pending = unsavedRotation;
  if (pending?.generation !== sessionGeneration) return false;
  await rotateArtifactCacheSession(pending.token, pending.token);
  await saveRotatedToken(pending.generation, pending.token);
  if (unsavedRotation !== pending || pending.generation !== sessionGeneration) return false;
  unsavedRotation = undefined;
  sessionFallback = undefined;
  return true;
}

/** Runs before the first token read of a launch; one that could not read runs again. */
let recovery: Promise<boolean> | undefined;

/**
 * Adopts the token of a password change that stopped after its namespace was saved. False when
 * the store could not be read, so it is unknown whether the saved token was revoked.
 */
async function recoverRotatedToken(): Promise<boolean> {
  // A session change in this launch owns the store; nothing is left to recover.
  if (sessionGeneration !== 0) return true;
  const generation = sessionGeneration;
  let token: string | undefined;
  try {
    const stored = await SecureStore.getItemAsync(SESSION_KEY);
    // Only the token the change replaced is swapped; any other session ignores the record.
    token = stored ? await rotatedArtifactCacheToken(stored) : undefined;
  } catch {
    return generation !== sessionGeneration;
  }
  if (!token || generation !== sessionGeneration) return true;
  try {
    await saveRotatedToken(generation, token);
  } catch {
    if (generation !== sessionGeneration) return true;
    sessionFallback = token;
    unsavedRotation = { generation, token };
  }
  return true;
}

/** Writes the token unless another session change started; that change then owns the store. */
function saveRotatedToken(generation: number, token: string): Promise<void> {
  return enqueueScopeWrite(async () => {
    if (generation === sessionGeneration) await SecureStore.setItemAsync(SESSION_KEY, token);
  });
}

/** Snapshots the active token without treating an unreadable store as an empty session. */
export async function snapshotSessionToken(): Promise<{ ok: true; value: string } | { ok: false }> {
  recovery ??= recoverRotatedToken();
  const attempt = recovery;
  if (!(await attempt)) {
    // The saved token may be the revoked one; the next read tries again.
    if (recovery === attempt) recovery = undefined;
    return { ok: false };
  }
  if (sessionFallback !== undefined) return { ok: true, value: sessionFallback };
  if (sessionInvalidated) return { ok: true, value: "" };
  const generation = sessionGeneration;
  try {
    const value = (await SecureStore.getItemAsync(SESSION_KEY)) ?? "";
    return {
      ok: true,
      value: generation === sessionGeneration && !sessionInvalidated ? value : "",
    };
  } catch {
    return { ok: false };
  }
}

/**
 * The server only accepts a signed bearer. `set-auth-token` and the session cookie are signed on
 * every server version; the body token is signed only by servers that refuse unsigned bearers.
 */
export function tokenFromAuthResponse(res: Response, body: unknown) {
  const cookies = res.headers.get("set-cookie") ?? "";
  const encoded =
    res.headers.get("set-auth-token") ||
    cookies.match(/(?:^|,\s*)(?:__Secure-)?better-auth\.session_token=([^;,]*)/)?.[1];
  if (!encoded) return jsonToken(body);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

function jsonToken(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.token === "string" && record.token) return record.token;
  const session = record.session;
  if (
    session &&
    typeof session === "object" &&
    typeof (session as { token?: string }).token === "string"
  ) {
    return (session as { token: string }).token;
  }
  return "";
}
