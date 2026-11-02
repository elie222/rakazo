import type { NotificationResponse } from "expo-notifications";
import { beforeEach, expect, it, vi } from "vitest";
import {
  loadAccountSummaries,
  refreshAccountSummaries,
  refreshAppBadge,
  rememberCurrentAccount,
  selectNotificationAccount,
  selectSavedAccount,
  signOutAllAccounts,
} from "./account-sessions";
import { forgetAppBadge } from "./app-badge";
import { openNotificationResponse } from "./open-notification";
import { pendingSessionTokens } from "./pending-session-revocations";
import { loadSavedAccounts, rememberSavedAccount } from "./saved-accounts";

const state = vi.hoisted(() => ({
  token: "family-token",
  generation: 0,
  apiBase: "https://app.example.test",
  disk: new Map<string, string>(),
  save: vi.fn(),
  signOut: vi.fn(),
  badge: vi.fn(),
  notifications: vi.fn(),
  push: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(async (key: string) => {
    state.disk.delete(key);
  }),
  getItemAsync: vi.fn(async (key: string) => state.disk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    state.disk.set(key, value);
  }),
}));
vi.mock("expo-notifications", () => ({
  setBadgeCountAsync: state.badge,
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  getLastNotificationResponse: () => null,
}));
vi.mock("expo-router", () => ({
  router: { push: state.push, dismissTo: vi.fn(), replace: vi.fn() },
}));
vi.mock("react-native", () => ({ Alert: { alert: state.alert } }));
vi.mock("./settings-sheet", () => ({ closeSettingsSheet: vi.fn() }));
vi.mock("./api", () => ({
  currentApiBase: () => state.apiBase,
  loadSessionToken: async () => state.token,
  clearSpace: async () => true,
  signOut: state.signOut,
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  loadSessionToken: async () => state.token,
  saveSessionToken: state.save,
}));
vi.mock("./live-notifications", () => ({
  stopLiveNotifications: vi.fn(async () => undefined),
  getLiveNotificationSettings: state.notifications,
}));
vi.mock("./server-headers", () => ({
  fetchServer: (...args: Parameters<typeof fetch>) => fetch(...args),
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
const apiBase = "https://app.example.test";
const account = (userId: string, token: string) => ({
  userId,
  token,
  email: `${userId}@example.test`,
});
const bearer = (init?: RequestInit) => new Headers(init?.headers).get("authorization");
const userFor = (init?: RequestInit) =>
  bearer(init) === "Bearer family-token" ? "family" : "work";

beforeEach(async () => {
  state.disk.clear();
  state.token = "family-token";
  state.generation = 0;
  state.apiBase = apiBase;
  state.badge.mockReset().mockResolvedValue(true);
  state.notifications.mockReset().mockResolvedValue({
    liveConnection: true,
    messages: false,
    scheduledTasks: false,
    needsAttention: true,
  });
  state.push.mockReset();
  state.alert.mockReset();
  state.signOut.mockReset().mockImplementation(async () => {
    state.token = "";
    state.generation++;
  });
  state.save.mockReset().mockImplementation(async (token: string) => {
    state.token = token;
    state.generation++;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const id = userFor(init);
      if (String(url).endsWith("/api/accounts"))
        return Response.json({
          serverOrigin: apiBase,
          accounts: [{ userId: id, unread: id === "family" ? 2 : 3 }],
        });
      return Response.json({ user: { id, email: `${id}@example.test` } });
    }),
  );
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  await rememberSavedAccount(apiBase, account("work", "work-token"));
});

it("returns local recovery identities without credentials", async () => {
  const summaries = await loadAccountSummaries();
  expect(summaries).toEqual([
    { userId: "family", email: "family@example.test", unread: 0 },
    { userId: "work", email: "work@example.test", unread: 0 },
  ]);
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves the first legacy login's notification preferences without copying them to another account", async () => {
  state.disk.clear();
  await rememberCurrentAccount();
  expect((await loadSavedAccounts(apiBase))[0]).toMatchObject({
    userId: "family",
    notifications: {
      liveConnection: true,
      messages: false,
      scheduledTasks: false,
      needsAttention: true,
    },
  });
  state.token = "work-token";
  state.generation++;
  await rememberCurrentAccount();
  const work = (await loadSavedAccounts(apiBase)).find((row) => row.userId === "work");
  expect(work?.notifications).toBeUndefined();
  expect(state.notifications).toHaveBeenCalledTimes(1);
});

it("does not adopt a legacy login after its session changes while reading preferences", async () => {
  state.disk.clear();
  state.notifications.mockImplementation(async () => {
    state.generation++;
    return { liveConnection: false, messages: true, scheduledTasks: true, needsAttention: true };
  });
  await rememberCurrentAccount();
  expect(await loadSavedAccounts(apiBase)).toEqual([]);
});

it("only selects and opens the newest notification when an older account verifies first", async () => {
  const pending = new Map<string, (response: Response) => void>();
  vi.mocked(fetch).mockImplementation(
    async (_url, init) => new Promise<Response>((resolve) => pending.set(userFor(init), resolve)),
  );
  const tap = (userId: string): NotificationResponse => ({
    actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
    notification: {
      date: Date.UTC(2026, 10, 3),
      request: {
        identifier: `overlapping-${userId}`,
        trigger: { type: "push" },
        content: {
          title: null,
          subtitle: null,
          body: null,
          categoryIdentifier: null,
          sound: null,
          launchImageName: null,
          badge: null,
          attachments: [],
          threadIdentifier: null,
          data: { userId, botId: `${userId}-bot` },
        },
      },
    },
  });
  const older = openNotificationResponse(tap("work"));
  await vi.waitFor(() => expect(pending.has("work")).toBe(true));
  const newer = openNotificationResponse(tap("family"));
  await vi.waitFor(() => expect(pending.has("family")).toBe(true));
  pending.get("work")!(Response.json({ user: { id: "work", email: "work@example.test" } }));
  expect(await older).toBe(false);
  const tokenAfterOlder = state.token;
  pending.get("family")!(Response.json({ user: { id: "family", email: "family@example.test" } }));
  expect(await newer).toBe(true);
  expect(tokenAfterOlder).toBe("family-token");
  expect(state.save).not.toHaveBeenCalled();
  expect(state.push).toHaveBeenCalledExactlyOnceWith(
    { pathname: "/thread", params: { userId: "family", botId: "family-bot" } },
    expect.any(Object),
  );
  expect(state.alert).not.toHaveBeenCalled();
});

it("validates and selects the notification owner while preserving the other login", async () => {
  expect(await selectNotificationAccount("work", apiBase)).toBe("selected");
  expect(state.token).toBe("work-token");
  expect(await loadSavedAccounts(apiBase)).toHaveLength(2);
  expect(fetch).toHaveBeenCalledWith(
    `${apiBase}/api/auth/get-session`,
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer work-token" }),
    }),
    apiBase,
  );
});

it("verifies the active login before opening its notification without replacing the bearer", async () => {
  expect(await selectNotificationAccount("family", `${apiBase}/`)).toBe("selected");
  expect(fetch).toHaveBeenCalledWith(
    `${apiBase}/api/auth/get-session`,
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer family-token" }),
    }),
    apiBase,
  );
  expect(state.save).not.toHaveBeenCalled();
});

it.each([200, 401])(
  "requires sign-in when the active notification account has expired or been revoked (%s)",
  async (status) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(null, { status }));
    expect(await selectNotificationAccount("family", apiBase)).toBe("signed-out");
    expect(state.save).not.toHaveBeenCalled();
    expect((await loadSavedAccounts(apiBase)).map((row) => row.userId)).toEqual(["work"]);
  },
);

it("does not open legacy identity-less notifications with multiple saved accounts", async () => {
  expect(await selectNotificationAccount()).toBe("signed-out");
  expect(state.save).not.toHaveBeenCalled();
});

it("forgets a revoked login or one that authenticates a different user", async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ user: { id: "family", email: "family@example.test" } }),
  );
  expect(await selectSavedAccount("work")).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
  expect((await loadSavedAccounts(apiBase)).map((row) => row.userId)).toEqual(["family"]);
  expect(await selectNotificationAccount("work")).toBe("signed-out");
});

it("a sign-out during validation cannot resurrect the selected bearer", async () => {
  vi.mocked(fetch).mockImplementation(async () => {
    state.generation++;
    return Response.json({ user: { id: "work", email: "work@example.test" } });
  });
  expect(await selectSavedAccount("work")).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
});

it("opens a notification named by the origin the server reports for itself", async () => {
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    expect(String(url).startsWith(apiBase)).toBe(true);
    return String(url).endsWith("/api/accounts")
      ? Response.json({ serverOrigin: "https://web.example.test", accounts: [] })
      : Response.json({ user: { id: userFor(init), email: "work@example.test" } });
  });
  expect(await selectNotificationAccount("work", "https://web.example.test")).toBe("selected");
  expect(state.token).toBe("work-token");
});

it("does not offer sign-in for another server's notification", async () => {
  expect(await selectNotificationAccount("work", "https://other.example.test")).toBe(
    "other-server",
  );
  expect(state.save).not.toHaveBeenCalled();
});

it("refreshes every login's unread count and the icon badge", async () => {
  await refreshAppBadge();
  expect(state.badge).toHaveBeenLastCalledWith(5);
  expect(await loadAccountSummaries()).toEqual([
    { userId: "family", email: "family@example.test", unread: 2 },
    { userId: "work", email: "work@example.test", unread: 3 },
  ]);
});

it("does not overwrite the icon with counts fetched before the app returned to the foreground", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(fetch).mockImplementation(async () => {
    await waiting;
    return Response.json({ accounts: [] });
  });
  const refreshing = refreshAppBadge();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  forgetAppBadge();
  release();
  await refreshing;
  expect(state.badge).not.toHaveBeenCalled();
});

it("a late revoked response cannot delete a replacement bearer for the same account", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    if (bearer(init) === "Bearer work-token") {
      await waiting;
      return Response.json({}, { status: 401 });
    }
    return Response.json({ accounts: [{ userId: "family", unread: 1 }] });
  });
  const refreshing = refreshAccountSummaries();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await rememberSavedAccount(apiBase, account("work", "replacement-work-token"));
  release();
  await refreshing;
  expect((await loadSavedAccounts(apiBase)).find((row) => row.userId === "work")?.token).toBe(
    "replacement-work-token",
  );
});

it("sign-out-all revokes each other saved bearer and signs the active one out", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ success: true }));
  await signOutAllAccounts();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    `${apiBase}/api/auth/sign-out`,
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      headers: expect.objectContaining({ authorization: "Bearer work-token" }),
    }),
    apiBase,
  );
  expect(state.signOut).toHaveBeenCalledWith(["family-token"], apiBase);
  expect((await loadSavedAccounts(apiBase)).map((row) => row.userId)).toEqual(["family"]);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set());
});

it("sign-out-all clears local logins even when remote revocation is offline", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  await expect(signOutAllAccounts()).rejects.toThrow("Could not sign out of every account");
  expect((await loadSavedAccounts(apiBase)).map((row) => row.userId)).toEqual(["family"]);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["work-token"]));
  expect(state.signOut).toHaveBeenCalledOnce();
});
