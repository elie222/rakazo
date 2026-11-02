import * as SecureStore from "expo-secure-store";
import { beforeEach, expect, it, vi } from "vitest";
import {
  forgetSavedToken,
  loadSavedAccounts,
  rememberSavedAccount,
  savedAccountRevocationSnapshot,
} from "./saved-accounts";

const disk = vi.hoisted(() => new Map<string, string>());
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
  vi.clearAllMocks();
});
const account = (userId: string, token: string) => ({
  userId,
  token,
  name: userId,
  email: `${userId}@example.test`,
  image: null,
  unread: 0,
});
const apiBase = "https://app.example.test";
it("retains both signed-in accounts and replaces only the same account's bearer", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  await rememberSavedAccount(apiBase, account("work", "work-token"));
  await rememberSavedAccount(apiBase, account("family", "new-family-token"));
  expect(await loadSavedAccounts(apiBase)).toEqual([
    account("family", "new-family-token"),
    account("work", "work-token"),
  ]);
});
it("keeps servers separate and removes only the requested local login", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  await rememberSavedAccount(apiBase, account("work", "work-token"));
  await rememberSavedAccount("https://other.example.test", account("family", "other-token"));
  await forgetSavedToken(apiBase, "family-token");
  expect(await loadSavedAccounts(apiBase)).toEqual([account("work", "work-token")]);
  expect(await loadSavedAccounts("https://other.example.test")).toEqual([
    account("family", "other-token"),
  ]);
});
it("does not erase unrelated saved accounts when encrypted storage is unreadable", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("locked"));
  await expect(rememberSavedAccount(apiBase, account("work", "work-token"))).rejects.toThrow(
    "locked",
  );
  expect(await loadSavedAccounts(apiBase)).toEqual([account("family", "family-token")]);
});
it("serializes concurrent additions without losing either account", async () => {
  await Promise.all([
    rememberSavedAccount(apiBase, account("family", "family-token")),
    rememberSavedAccount(apiBase, account("work", "work-token")),
  ]);
  expect(await loadSavedAccounts(apiBase)).toHaveLength(2);
});

it("keeps existing account preferences when a fresh authenticated bearer supplies defaults", async () => {
  const preferences = {
    liveConnection: false,
    messages: false,
    scheduledTasks: false,
    needsAttention: false,
  };
  const defaults = {
    liveConnection: false,
    messages: true,
    scheduledTasks: true,
    needsAttention: true,
  };
  await rememberSavedAccount(apiBase, {
    ...account("family", "family-token"),
    notifications: preferences,
  });
  await rememberSavedAccount(apiBase, {
    ...account("family", "new-family-token"),
    notifications: defaults,
  });
  expect((await loadSavedAccounts(apiBase))[0]).toMatchObject({
    token: "new-family-token",
    notifications: preferences,
  });
  await forgetSavedToken(apiBase, "new-family-token");
  await rememberSavedAccount(apiBase, {
    ...account("work", "work-token"),
    notifications: defaults,
  });
  expect((await loadSavedAccounts(apiBase))[0]).toMatchObject({
    userId: "work",
    notifications: defaults,
  });
});

it("allows only the revocation snapshot to read credentials when pending sign-outs are unreadable", async () => {
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  await rememberSavedAccount(apiBase, account("work", "work-token"));
  disk.set("rakazo.pending_session_revocations", "malformed-json");
  await expect(loadSavedAccounts(apiBase)).rejects.toThrow();
  expect(await savedAccountRevocationSnapshot()).toEqual([
    { apiBase, token: "family-token" },
    { apiBase, token: "work-token" },
  ]);
});
