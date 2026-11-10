import type { WebdavBackupAccount } from "./webdav-backup";

/**
 * The WebDAV account, in SecureStore under one key per user id. The backup
 * password is never stored here — only the WebDAV account password lives on
 * the device, and only for the signed-in account.
 */
export function webdavBackupAccountKey(userId: string): string {
  return `rakazo.webdav-backup.${userId}`;
}

function webdavBackupSyncKey(userId: string): string {
  return `rakazo.webdav-backup.${userId}.sync`;
}

function isAccount(value: unknown): value is WebdavBackupAccount {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.serverUrl === "string" &&
    typeof item.username === "string" &&
    typeof item.password === "string" &&
    typeof item.directory === "string"
  );
}

export async function loadWebdavBackupAccount(userId: string): Promise<WebdavBackupAccount | null> {
  try {
    const SecureStore = await import("expo-secure-store");
    const stored = await SecureStore.getItemAsync(webdavBackupAccountKey(userId));
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return isAccount(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveWebdavBackupAccount(
  userId: string,
  account: WebdavBackupAccount,
): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  await SecureStore.setItemAsync(webdavBackupAccountKey(userId), JSON.stringify(account));
}

/** Clears the signed-out account's WebDAV record; call on sign-out / account switch. */
export async function clearWebdavBackupAccount(userId: string): Promise<void> {
  try {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.deleteItemAsync(webdavBackupAccountKey(userId));
    await SecureStore.deleteItemAsync(webdavBackupSyncKey(userId));
  } catch {
    // A store that cannot clear still signs out; the record stays until the
    // next sign-in overwrites it for that account.
  }
}

export type WebdavBackupSyncState = {
  /** When the last upload or download completed. */
  lastSyncedAt: string;
  /** SHA-256 of the zip as of that sync, for the conflict check. */
  sha256: string | null;
};

export async function loadWebdavBackupSyncState(
  userId: string,
): Promise<WebdavBackupSyncState | null> {
  try {
    const SecureStore = await import("expo-secure-store");
    const stored = await SecureStore.getItemAsync(webdavBackupSyncKey(userId));
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return null;
    const item = parsed as Record<string, unknown>;
    if (typeof item.lastSyncedAt !== "string" || Number.isNaN(Date.parse(item.lastSyncedAt))) {
      return null;
    }
    if (item.sha256 !== null && typeof item.sha256 !== "string") return null;
    return { lastSyncedAt: item.lastSyncedAt, sha256: item.sha256 as string | null };
  } catch {
    return null;
  }
}

export async function saveWebdavBackupSyncState(
  userId: string,
  state: WebdavBackupSyncState,
): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  await SecureStore.setItemAsync(webdavBackupSyncKey(userId), JSON.stringify(state));
}
