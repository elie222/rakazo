import * as SecureStore from "expo-secure-store";
import { beforeEach, expect, it, vi } from "vitest";
import { queueSessionRevocation } from "./pending-session-revocations";
import {
  activeSavedAccount,
  clearSavedAccounts,
  forgetSavedToken,
  isSavedServer,
  loadSavedAccounts,
  rememberSavedAccount,
  rememberServerOrigin,
  saveAccountNotifications,
  signedInUserIds,
} from "./saved-accounts";

const disk = vi.hoisted(() => new Map<string, string>());
const session = vi.hoisted(() => ({ token: "" }));
vi.mock("./session", () => ({ loadSessionToken: async () => session.token }));
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(async (key: string) => {
    disk.delete(key);
  }),
  getItemAsync: vi.fn(async (key: string) => disk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    disk.set(key, value);
  }),
}));
beforeEach(() => {
  disk.clear();
  session.token = "";
  vi.clearAllMocks();
});
const account = (userId: string, token: string) => ({
  userId,
  token,
  email: `${userId}@example.test`,
});
const apiBase = "https://app.example.test";
const preferences = {
  liveConnection: false,
  messages: false,
  scheduledTasks: false,
  needsAttention: false,
};

it("keeps each login under its own key and replaces only the same account's bearer", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  await rememberSavedAccount(apiBase, account("work", "work-token"));
  await rememberSavedAccount(apiBase, account("family", "new-family-token"));
  expect(await loadSavedAccounts(apiBase)).toEqual([
    account("family", "new-family-token"),
    account("work", "work-token"),
  ]);
  expect([...disk.keys()].filter((key) => key.startsWith("rakazo.account."))).toHaveLength(2);
  await forgetSavedToken(apiBase, "family-token");
  expect(await loadSavedAccounts(apiBase)).toHaveLength(2);
  await forgetSavedToken(apiBase, "new-family-token");
  expect(await loadSavedAccounts(apiBase)).toEqual([account("work", "work-token")]);
  expect([...disk.keys()].filter((key) => key.startsWith("rakazo.account."))).toHaveLength(1);
});

it("keeps logins for one server: another server's are dropped", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  expect(await loadSavedAccounts("https://other.example.test")).toEqual([]);
  await rememberSavedAccount("https://other.example.test", account("work", "other-token"));
  expect(await loadSavedAccounts(apiBase)).toEqual([]);
  expect(await loadSavedAccounts("https://other.example.test")).toEqual([
    account("work", "other-token"),
  ]);
  await clearSavedAccounts();
  expect(disk.size).toBe(0);
});

it("serializes concurrent additions without losing either account", async () => {
  await Promise.all([
    rememberSavedAccount(apiBase, account("family", "family-token")),
    rememberSavedAccount(apiBase, account("work", "work-token")),
  ]);
  expect(await loadSavedAccounts(apiBase)).toHaveLength(2);
});

it("keeps an account's preferences when a fresh bearer supplies defaults", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  expect(await saveAccountNotifications(apiBase, "family-token", preferences)).toBe(true);
  await rememberSavedAccount(apiBase, {
    ...account("family", "new-family-token"),
    notifications: { ...preferences, messages: true },
  });
  expect((await loadSavedAccounts(apiBase))[0]).toEqual({
    ...account("family", "new-family-token"),
    notifications: preferences,
  });
  expect(await saveAccountNotifications(apiBase, "family-token", preferences)).toBe(false);
});

it("drops an unreadable index or account record instead of failing every read", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  await rememberSavedAccount(apiBase, account("work", "work-token"));
  const familyKey = [...disk.keys()].find((key) => disk.get(key)?.includes("family-token"))!;
  disk.set(familyKey, "{not json");
  expect(await loadSavedAccounts(apiBase)).toEqual([account("work", "work-token")]);
  expect(disk.has(familyKey)).toBe(false);
  disk.set("rakazo.accounts", "{not json");
  expect(await loadSavedAccounts(apiBase)).toEqual([]);
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  expect(await loadSavedAccounts(apiBase)).toEqual([account("family", "family-token")]);
});

it("does not erase saved accounts when encrypted storage is temporarily unreadable", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("locked"));
  await expect(rememberSavedAccount(apiBase, account("work", "work-token"))).rejects.toThrow(
    "locked",
  );
  expect(await loadSavedAccounts(apiBase)).toEqual([account("family", "family-token")]);
});

it("derives the active login from the session bearer", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  await rememberSavedAccount(apiBase, account("work", "work-token"));
  expect(await activeSavedAccount()).toBeUndefined();
  session.token = "work-token";
  expect(await activeSavedAccount()).toMatchObject({ userId: "work", apiBase, count: 2 });
});

it("recognizes the server by its configured URL or the origin it reports", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  expect(await isSavedServer(apiBase, `${apiBase}/`)).toBe(true);
  expect(await isSavedServer(apiBase, "https://web.example.test")).toBe(false);
  await rememberServerOrigin(apiBase, "https://web.example.test");
  expect(await isSavedServer(apiBase, "https://web.example.test")).toBe(true);
  expect(await isSavedServer(apiBase, "https://other.example.test")).toBe(false);
});

it("lists logins still signed in, without ones queued for sign-out", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  await rememberSavedAccount(apiBase, account("work", "work-token"));
  await queueSessionRevocation(apiBase, "work-token");
  expect(await signedInUserIds()).toEqual(["family"]);
  expect(await loadSavedAccounts(apiBase)).toEqual([account("family", "family-token")]);
});
