import { readBoundedJsonResponse } from "@rakazo/core";
import { clearSpace, currentApiBase, loadSessionToken, signOut } from "./api";
import { appBadgeGeneration, syncAppBadge } from "./app-badge";
import { t } from "./i18n";
import { stopLiveNotifications } from "./live-notifications";
import {
  completeSessionRevocation,
  pendingSessionTokens,
  queueSessionRevocation,
} from "./pending-session-revocations";
import type { SavedAccount } from "./saved-accounts";
import {
  forgetSavedToken,
  isSavedServer,
  loadSavedAccounts,
  rememberSavedAccount,
  rememberServerOrigin,
  savedTokens,
} from "./saved-accounts";
import { fetchServer } from "./server-headers";
import { currentSessionGeneration, saveSessionToken } from "./session";

export type AccountSummary = { userId: string; email: string; unread: number };
const unreadCounts = new Map<string, number>();

function summary(apiBase: string, { userId, email }: SavedAccount): AccountSummary {
  return { userId, email, unread: unreadCounts.get(`${apiBase} ${userId}`) ?? 0 };
}

/** Recovery menus can show saved identities before the network is reachable. */
export async function loadAccountSummaries(): Promise<AccountSummary[]> {
  const apiBase = currentApiBase();
  return (await loadSavedAccounts(apiBase)).map((account) => summary(apiBase, account));
}

async function accountJson(apiBase: string, token: string, path: string, method = "GET") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchServer(
      `${apiBase}${path}`,
      {
        method,
        credentials: "omit",
        redirect: "error",
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
  const user = (body as { user?: { id?: unknown; email?: unknown } } | null)?.user;
  if (typeof user?.id !== "string" || typeof user.email !== "string") return null;
  return { userId: user.id, token, email: user.email };
}

/** Adopt a legacy single bearer only after the server proves which user owns it. */
export async function rememberCurrentAccount(): Promise<void> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const token = await loadSessionToken();
  if (!token || (await pendingSessionTokens(apiBase)).has(token)) return;
  if ((await loadSavedAccounts(apiBase)).some((row) => row.token === token)) return;
  const verified = await verifiedAccount(apiBase, token);
  if (!verified) return;
  await rememberSavedAccount(
    apiBase,
    verified,
    () => generation === currentSessionGeneration() && apiBase === currentApiBase(),
  );
}

/** Every request keeps its account's bearer; polling never changes the active account. */
export async function refreshAccountSummaries(): Promise<AccountSummary[]> {
  const apiBase = currentApiBase();
  await rememberCurrentAccount().catch(() => undefined);
  const rows = await loadSavedAccounts(apiBase);
  const summaries = await Promise.all(
    rows.map(async (account) => {
      try {
        const { response, body } = await accountJson(apiBase, account.token, "/api/accounts");
        if (response.status === 401) {
          await forgetSavedToken(apiBase, account.token);
          return null;
        }
        const data = body as {
          serverOrigin?: unknown;
          accounts?: Array<{ userId?: unknown; unread?: unknown }>;
        } | null;
        if (response.ok && typeof data?.serverOrigin === "string")
          await rememberServerOrigin(apiBase, data.serverOrigin);
        const unread = data?.accounts?.find((row) => row.userId === account.userId)?.unread;
        if (response.ok && typeof unread === "number" && Number.isInteger(unread) && unread >= 0)
          unreadCounts.set(`${apiBase} ${account.userId}`, unread);
      } catch {
        // A network failure does not revoke a saved login.
      }
      return summary(apiBase, account);
    }),
  );
  return summaries.filter((row) => row !== null);
}

/** The app icon counts unread chats across every saved login. */
export async function refreshAppBadge(): Promise<void> {
  const generation = appBadgeGeneration();
  const accounts = await refreshAccountSummaries();
  if (!accounts.length && (await loadSessionToken())) return;
  if (generation === appBadgeGeneration())
    await syncAppBadge(accounts.reduce((sum, row) => sum + row.unread, 0));
}

/** Validate ownership before changing the active bearer or any private screen. */
export async function selectSavedAccount(userId: string): Promise<boolean> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const account = (await loadSavedAccounts(apiBase)).find((row) => row.userId === userId);
  if (!account) return false;
  const verified = await verifiedAccount(apiBase, account.token);
  if (verified?.userId !== userId) {
    await forgetSavedToken(apiBase, account.token);
    return false;
  }
  const current = () => generation === currentSessionGeneration() && apiBase === currentApiBase();
  if (!current()) return false;
  if ((await loadSessionToken()) === account.token) return current();
  if (!(await clearSpace())) throw new Error(t("Could not clear the local session"));
  if (!current()) return false;
  await stopLiveNotifications(false).catch(() => undefined);
  if (!current()) return false;
  await saveSessionToken(account.token);
  return generation + 1 === currentSessionGeneration() && apiBase === currentApiBase();
}

/** "other-server" targets cannot open here: signing in again would not reach their server. */
export async function selectNotificationAccount(
  userId?: string,
  apiBase?: string,
): Promise<"selected" | "signed-out" | "other-server"> {
  const server = currentApiBase();
  if (apiBase !== undefined && !(await isSavedServer(server, apiBase))) {
    // The server's own name for itself is learned from its account summary.
    await refreshAccountSummaries();
    if (!(await isSavedServer(server, apiBase))) return "other-server";
  }
  await rememberCurrentAccount().catch(() => undefined);
  const rows = await loadSavedAccounts(server);
  if (!userId && !rows.length) return (await loadSessionToken()) ? "selected" : "signed-out";
  // Older deliveries have no account. They are safe only with one saved login.
  const target = userId ?? (rows.length === 1 ? rows[0]?.userId : undefined);
  return target && (await selectSavedAccount(target)) ? "selected" : "signed-out";
}

/** Removes every saved login locally; remote failures are reported after that. */
export async function signOutAllAccounts(): Promise<void> {
  const apiBase = currentApiBase();
  const activeToken = await loadSessionToken();
  let failed = false;
  let localFailed = false;
  const others = (await savedTokens(apiBase)).filter((token) => token !== activeToken);
  await Promise.all(
    others.map(async (token) => {
      // A lost retry record must not block direct revocation or local removal.
      await queueSessionRevocation(apiBase, token).catch(() => undefined);
      try {
        const { response, body } = await accountJson(apiBase, token, "/api/auth/sign-out", "POST");
        if (response.ok && (body as { success?: unknown } | null)?.success === true)
          await completeSessionRevocation(apiBase, token).catch(() => undefined);
        else failed = true;
      } catch {
        failed = true;
      }
      await forgetSavedToken(apiBase, token).catch(() => {
        localFailed = true;
      });
    }),
  );
  if (activeToken) await signOut([activeToken], apiBase);
  if (localFailed) throw new Error(t("Could not clear the local session"));
  if (failed) throw new Error(t("Could not sign out of every account"));
}
