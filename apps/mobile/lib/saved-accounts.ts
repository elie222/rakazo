import * as SecureStore from "expo-secure-store";
import { normalizeApiBase } from "./endpoint";
import type { LiveNotificationSettings } from "./live-notifications";
import { pendingSessionTokens } from "./pending-session-revocations";
import { loadSessionToken } from "./session";

const INDEX_KEY = "rakazo.accounts";
export type SavedAccount = {
  userId: string;
  token: string;
  email: string;
  notifications?: LiveNotificationSettings;
};
/** Logins are saved for one server: `origin` is how that server names itself in pushes. */
type Index = { apiBase: string; origin?: string; userIds: string[] };
let writes: Promise<unknown> = Promise.resolve();

// SecureStore keys allow only [A-Za-z0-9._-].
function accountKey(userId: string): string {
  return `rakazo.account.${Array.from(userId, (c) => c.codePointAt(0)!.toString(16)).join("-")}`;
}

function parse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readIndex(): Promise<Index | null> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY);
  const data = parse(raw) as Partial<Index> | null;
  if (
    typeof data?.apiBase === "string" &&
    (data.origin === undefined || typeof data.origin === "string") &&
    Array.isArray(data.userIds) &&
    data.userIds.every((id) => typeof id === "string" && id)
  )
    return data as Index;
  // An unreadable index cannot be repaired; dropping it only asks for sign-in again.
  if (raw) await SecureStore.deleteItemAsync(INDEX_KEY).catch(() => undefined);
  return null;
}

async function writeIndex(index: Index): Promise<void> {
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(index));
}

async function readAccount(userId: string): Promise<SavedAccount | null> {
  const data = parse(
    await SecureStore.getItemAsync(accountKey(userId)),
  ) as Partial<SavedAccount> | null;
  if (typeof data?.token !== "string" || !data.token || typeof data.email !== "string") return null;
  return {
    userId,
    token: data.token,
    email: data.email,
    ...(data.notifications && typeof data.notifications === "object"
      ? { notifications: data.notifications }
      : {}),
  };
}

async function writeAccount({ userId, ...account }: SavedAccount): Promise<void> {
  await SecureStore.setItemAsync(accountKey(userId), JSON.stringify(account));
}

async function read(): Promise<{ index: Index | null; accounts: SavedAccount[] }> {
  const index = await readIndex();
  if (!index) return { index, accounts: [] };
  const rows = await Promise.all(index.userIds.map(readAccount));
  const accounts = rows.filter((row): row is SavedAccount => row !== null);
  if (accounts.length !== index.userIds.length) {
    const lost = index.userIds.filter((id) => !accounts.some((row) => row.userId === id));
    index.userIds = accounts.map((row) => row.userId);
    await writeIndex(index);
    await Promise.all(lost.map((id) => SecureStore.deleteItemAsync(accountKey(id)))).catch(
      () => undefined,
    );
  }
  return { index, accounts };
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = writes.catch(() => undefined).then(task);
  writes = next;
  return next;
}

async function settled(): Promise<{ index: Index | null; accounts: SavedAccount[] }> {
  await writes.catch(() => undefined);
  return read();
}

/** Logins saved for `apiBase`, without any waiting to be signed out. */
export async function loadSavedAccounts(apiBase: string): Promise<SavedAccount[]> {
  const { index, accounts } = await settled();
  if (index?.apiBase !== apiBase) return [];
  const pending = await pendingSessionTokens(apiBase);
  return accounts.filter((row) => !pending.has(row.token));
}

/** Every saved bearer for `apiBase`, including ones already queued for revocation. */
export async function savedTokens(apiBase: string): Promise<string[]> {
  const { index, accounts } = await settled();
  return index?.apiBase === apiBase ? accounts.map((row) => row.token) : [];
}

export type ActiveSavedAccount = SavedAccount & {
  apiBase: string;
  origin?: string;
  /** Logins saved on this device. */
  count: number;
};

/** The saved login whose bearer is the active session. */
export async function activeSavedAccount(): Promise<ActiveSavedAccount | undefined> {
  const token = await loadSessionToken();
  const { index, accounts } = await settled();
  const account = token ? accounts.find((row) => row.token === token) : undefined;
  if (!account || !index) return undefined;
  return { ...account, apiBase: index.apiBase, origin: index.origin, count: accounts.length };
}

/** Whether `value` names this server, by its configured URL or the origin it reports. */
export function servesAs(server: { apiBase: string; origin?: string }, value: string): boolean {
  const parsed = normalizeApiBase(value);
  return parsed.ok && (parsed.url === server.apiBase || parsed.url === server.origin);
}

export async function isSavedServer(apiBase: string, value: string): Promise<boolean> {
  const { index } = await settled();
  return servesAs(index?.apiBase === apiBase ? index : { apiBase }, value);
}

/** Logins still signed in on this device. */
export async function signedInUserIds(): Promise<string[]> {
  const { index, accounts } = await settled();
  if (!index) return [];
  const pending = await pendingSessionTokens(index.apiBase);
  return accounts.filter((row) => !pending.has(row.token)).map((row) => row.userId);
}

export function rememberServerOrigin(apiBase: string, origin: string): Promise<void> {
  const parsed = normalizeApiBase(origin);
  if (!parsed.ok) return Promise.resolve();
  return serialized(async () => {
    const index = await readIndex();
    if (index?.apiBase !== apiBase || index.origin === parsed.url) return;
    await writeIndex({ ...index, origin: parsed.url });
  });
}

/** Call only with identity verified by the authenticated API response. Another server's logins are dropped. */
export function rememberSavedAccount(
  apiBase: string,
  account: SavedAccount,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  return serialized(async () => {
    const { index, accounts } = await read();
    if (!stillCurrent()) return;
    const sameServer = index?.apiBase === apiBase;
    const previous = sameServer ? accounts.find((row) => row.userId === account.userId) : undefined;
    const next = { ...account, notifications: previous?.notifications ?? account.notifications };
    if (!next.notifications) delete next.notifications;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (!sameServer)
      await Promise.all(
        accounts.map((row) => SecureStore.deleteItemAsync(accountKey(row.userId))),
      ).catch(() => undefined);
    await writeAccount(next);
    if (!previous)
      await writeIndex({
        apiBase,
        ...(sameServer && index?.origin ? { origin: index.origin } : {}),
        userIds: [...(sameServer ? (index?.userIds ?? []) : []), account.userId],
      });
  });
}

function changeAccount(
  apiBase: string,
  token: string,
  change: (account: SavedAccount) => SavedAccount | null,
): Promise<boolean> {
  return serialized(async () => {
    const { index, accounts } = await read();
    const account = accounts.find((row) => row.token === token);
    if (!index || index.apiBase !== apiBase || !account) return false;
    const next = change(account);
    if (next) {
      await writeAccount(next);
      return true;
    }
    await writeIndex({ ...index, userIds: index.userIds.filter((id) => id !== account.userId) });
    await SecureStore.deleteItemAsync(accountKey(account.userId)).catch(() => undefined);
    return true;
  });
}

export async function forgetSavedToken(apiBase: string, token: string): Promise<void> {
  await changeAccount(apiBase, token, () => null);
}

export async function replaceSavedToken(
  apiBase: string,
  previous: string,
  token: string,
): Promise<void> {
  await changeAccount(apiBase, previous, (row) => ({ ...row, token }));
}

/** A late save must never restore a removed or rotated bearer. */
export function saveAccountNotifications(
  apiBase: string,
  token: string,
  notifications: LiveNotificationSettings,
): Promise<boolean> {
  return changeAccount(apiBase, token, (row) => ({ ...row, notifications }));
}

/** Changing servers signs this device out of the previous server's logins. */
export function clearSavedAccounts(): Promise<void> {
  return serialized(async () => {
    const index = await readIndex();
    if (!index) return;
    await SecureStore.deleteItemAsync(INDEX_KEY);
    await Promise.all(index.userIds.map((id) => SecureStore.deleteItemAsync(accountKey(id)))).catch(
      () => undefined,
    );
  });
}
