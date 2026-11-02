import { readBoundedJsonResponse } from "@rakazo/core";
import { clearSpace, currentApiBase, loadSessionToken, signOut } from "./api";
import { normalizeApiBase } from "./endpoint";
import { t } from "./i18n";
import { stopLiveNotifications } from "./live-notifications";
import type { SavedAccount } from "./saved-accounts";
import {
  forgetSavedToken,
  loadSavedAccounts,
  rememberSavedAccount,
  savedAccountServers,
  setSelectedSavedAccount,
  updateSavedAccountIfCurrent,
} from "./saved-accounts";
import { fetchServer } from "./server-headers";
import { currentSessionGeneration, saveSessionToken } from "./session";

export type AccountSummary = Omit<SavedAccount, "token" | "notifications">;
let selectionRequest = 0;

async function accountJson(apiBase: string, token: string, path: string, method = "GET") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchServer(
      `${apiBase}${path}`,
      {
        method,
        credentials: "omit",
        headers: {
          origin: "rakazo://",
          authorization: `Bearer ${token}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
        signal: controller.signal,
      },
      apiBase,
    );
    return {
      response,
      body: await readBoundedJsonResponse<unknown>(response, 256 * 1024, controller.signal),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function verifiedAccount(apiBase: string, token: string): Promise<SavedAccount | null> {
  const { response, body } = await accountJson(apiBase, token, "/api/auth/get-session");
  if (response.status === 401 || (response.ok && body === null)) return null;
  if (!response.ok) throw new Error(t("Could not continue"));
  const user = (
    body as { user?: { id?: unknown; name?: unknown; email?: unknown; image?: unknown } } | null
  )?.user;
  if (!user || typeof user.id !== "string" || typeof user.email !== "string") return null;
  return {
    userId: user.id,
    token,
    email: user.email,
    name: typeof user.name === "string" ? user.name : "",
    image: typeof user.image === "string" ? user.image : null,
    unread: 0,
  };
}

/** Adopt a legacy single bearer only after the server proves which user owns it. */
export async function rememberCurrentAccount(): Promise<void> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const token = await loadSessionToken();
  if (!token) return;
  const rows = await loadSavedAccounts(apiBase);
  const existing = rows.find((row) => row.token === token);
  if (existing) {
    if (generation === currentSessionGeneration() && apiBase === currentApiBase())
      setSelectedSavedAccount({ apiBase, userId: existing.userId });
    return;
  }
  const verified = await verifiedAccount(apiBase, token);
  if (!verified || generation !== currentSessionGeneration() || apiBase !== currentApiBase())
    return;
  await rememberSavedAccount(
    apiBase,
    verified,
    () => generation === currentSessionGeneration() && apiBase === currentApiBase(),
  );
  if (generation === currentSessionGeneration() && apiBase === currentApiBase())
    setSelectedSavedAccount({ apiBase, userId: verified.userId });
}

/** Every request retains its account bearer; polling never changes the displayed account. */
export async function refreshAccountSummaries(): Promise<AccountSummary[]> {
  const apiBase = currentApiBase();
  await rememberCurrentAccount();
  const rows = await loadSavedAccounts(apiBase);
  const summaries = await Promise.all(
    rows.map(async (account): Promise<AccountSummary | null> => {
      try {
        const { response, body } = await accountJson(apiBase, account.token, "/api/accounts");
        if (response.status === 401) {
          await forgetSavedToken(apiBase, account.token);
          return null;
        }
        if (response.ok) {
          const data = body as { accounts?: Array<{ userId: string; unread?: number }> };
          const own = data.accounts?.find((row) => row.userId === account.userId);
          if (!own) return null;
          const unread =
            typeof own.unread === "number" && Number.isInteger(own.unread) && own.unread >= 0
              ? own.unread
              : account.unread;
          const next = { ...account, unread };
          if (
            !(await updateSavedAccountIfCurrent(apiBase, account.token, (current) => ({
              ...current,
              unread,
            })))
          )
            return null;
          const { token: _token, notifications: _notifications, ...summary } = next;
          return summary;
        }
      } catch {
        // A network failure does not revoke a saved login.
      }
      const { token: _token, notifications: _notifications, ...summary } = account;
      return summary;
    }),
  );
  return summaries.filter((row): row is AccountSummary => row !== null);
}

/** Validate ownership before changing the active bearer or any private screen. */
export async function selectSavedAccount(userId: string): Promise<boolean> {
  const request = ++selectionRequest;
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const account = (await loadSavedAccounts(apiBase)).find((row) => row.userId === userId);
  if (!account) return false;
  const verified = await verifiedAccount(apiBase, account.token);
  if (!verified || verified.userId !== userId) {
    await forgetSavedToken(apiBase, account.token);
    return false;
  }
  if (
    request !== selectionRequest ||
    generation !== currentSessionGeneration() ||
    apiBase !== currentApiBase()
  )
    return false;
  if (
    !(await loadSavedAccounts(apiBase)).some(
      (row) => row.userId === userId && row.token === account.token,
    )
  )
    return false;
  if ((await loadSessionToken()) !== account.token) {
    if (!(await clearSpace())) throw new Error(t("Could not clear the local session"));
    if (
      request !== selectionRequest ||
      generation !== currentSessionGeneration() ||
      apiBase !== currentApiBase()
    )
      return false;
    await stopLiveNotifications(false).catch(() => undefined);
    if (
      request !== selectionRequest ||
      generation !== currentSessionGeneration() ||
      apiBase !== currentApiBase()
    )
      return false;
    await saveSessionToken(account.token);
    if (
      request !== selectionRequest ||
      generation + 1 !== currentSessionGeneration() ||
      apiBase !== currentApiBase()
    )
      return false;
  }
  setSelectedSavedAccount({ apiBase, userId });
  return true;
}

export async function selectNotificationAccount(
  userId?: string,
  apiBase?: string,
): Promise<boolean> {
  if (apiBase !== undefined) {
    const parsed = normalizeApiBase(apiBase);
    if (!parsed.ok || parsed.url !== currentApiBase()) return false;
  } else if ((await savedAccountServers()).length > 1) return false;
  await rememberCurrentAccount();
  const rows = await loadSavedAccounts(currentApiBase());
  // Older deliveries have no account. They are safe only with one verified saved login.
  const target = userId ?? (rows.length === 1 ? rows[0]?.userId : undefined);
  return target ? selectSavedAccount(target) : false;
}

/** Revokes each locally saved credential; remote failures are reported after local removal. */
export async function signOutAllAccounts(): Promise<void> {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  await rememberCurrentAccount();
  const accounts = await loadSavedAccounts(apiBase);
  let failed = false;
  await Promise.all(
    accounts.map(async (account) => {
      try {
        const { response } = await accountJson(
          apiBase,
          account.token,
          "/api/auth/sign-out",
          "POST",
        );
        if (!response.ok) failed = true;
      } catch {
        failed = true;
      }
      await forgetSavedToken(apiBase, account.token);
    }),
  );
  if (generation !== currentSessionGeneration() || apiBase !== currentApiBase()) return;
  await signOut();
  if (failed)
    throw new Error(t("Signed out on this device. Some server sessions could not be revoked."));
}
