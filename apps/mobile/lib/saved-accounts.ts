import * as SecureStore from "expo-secure-store";
import type { LiveNotificationSettings } from "./live-notifications";
import { pendingSessionTokens } from "./pending-session-revocations";

const ACCOUNTS_KEY = "rakazo.saved_accounts";
export type SavedAccount = {
  userId: string;
  token: string;
  name: string;
  email: string;
  image: string | null;
  unread: number;
  notifications?: LiveNotificationSettings;
};
type AccountStore = Record<string, SavedAccount[]>;
let writes: Promise<unknown> = Promise.resolve();
const cache = new Map<string, SavedAccount[]>();
let selected: { apiBase: string; userId: string } | null = null;

export function selectedSavedAccount(): { apiBase: string; userId: string } | null {
  return selected;
}
export function setSelectedSavedAccount(value: { apiBase: string; userId: string } | null): void {
  if (selected?.apiBase === value?.apiBase && selected?.userId === value?.userId) return;
  selected = value;
}
export function cachedSavedAccounts(apiBase: string): readonly SavedAccount[] {
  return cache.get(apiBase) ?? [];
}

async function read(): Promise<AccountStore> {
  const raw = await SecureStore.getItemAsync(ACCOUNTS_KEY);
  if (!raw) return {};
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Could not read saved accounts");
  const valid: AccountStore = {};
  for (const [apiBase, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) throw new Error("Could not read saved accounts");
    valid[apiBase] = rows.filter((row): row is SavedAccount =>
      Boolean(
        row &&
          typeof row.userId === "string" &&
          row.userId &&
          typeof row.token === "string" &&
          row.token &&
          typeof row.email === "string" &&
          typeof row.name === "string" &&
          (row.image === null || typeof row.image === "string") &&
          Number.isInteger(row.unread) &&
          row.unread >= 0,
      ),
    );
  }
  return valid;
}

export async function loadSavedAccounts(apiBase: string): Promise<SavedAccount[]> {
  await writes.catch(() => undefined);
  const pending = await pendingSessionTokens(apiBase);
  const rows = ((await read())[apiBase] ?? []).filter((row) => !pending.has(row.token));
  cache.set(apiBase, rows);
  return rows;
}

function update(
  apiBase: string,
  change: (rows: SavedAccount[]) => SavedAccount[],
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  const next = writes
    .catch(() => undefined)
    .then(async () => {
      const store = await read();
      if (!stillCurrent()) return;
      const rows = change(store[apiBase] ?? []);
      store[apiBase] = rows;
      await SecureStore.setItemAsync(ACCOUNTS_KEY, JSON.stringify(store));
      cache.set(apiBase, rows);
    });
  writes = next;
  return next;
}

/** Call only with identity verified by the authenticated API response. */
export function rememberSavedAccount(
  apiBase: string,
  account: SavedAccount,
  stillCurrent?: () => boolean,
): Promise<void> {
  return update(
    apiBase,
    (rows) => {
      const previous = rows.find((row) => row.userId === account.userId);
      const next = { ...previous, ...account };
      return previous
        ? rows.map((row) => (row.userId === account.userId ? next : row))
        : [...rows, next];
    },
    stillCurrent,
  );
}

export function forgetSavedToken(apiBase: string, token: string): Promise<void> {
  return update(apiBase, (rows) => rows.filter((row) => row.token !== token));
}

export function replaceSavedToken(apiBase: string, previous: string, token: string): Promise<void> {
  return update(apiBase, (rows) =>
    rows.map((row) => (row.token === previous ? { ...row, token } : row)),
  );
}

/** A late summary or settings save must never restore a removed or rotated bearer. */
export async function updateSavedAccountIfCurrent(
  apiBase: string,
  token: string,
  change: (account: SavedAccount) => SavedAccount,
): Promise<boolean> {
  let updated = false;
  await update(apiBase, (rows) =>
    rows.map((row) => {
      if (row.token !== token) return row;
      updated = true;
      return change(row);
    }),
  );
  return updated;
}

export async function savedAccountServers(): Promise<string[]> {
  await writes.catch(() => undefined);
  return Object.entries(await read())
    .filter(([, rows]) => rows.length > 0)
    .map(([apiBase]) => apiBase);
}
