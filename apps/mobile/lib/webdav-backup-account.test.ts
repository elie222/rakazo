import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemAsync: vi.fn(async (key: string) => store.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.values.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.values.delete(key);
  }),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: store.getItemAsync,
  setItemAsync: store.setItemAsync,
  deleteItemAsync: store.deleteItemAsync,
}));

import {
  clearWebdavBackupAccount,
  loadWebdavBackupAccount,
  loadWebdavBackupSyncState,
  saveWebdavBackupAccount,
  saveWebdavBackupSyncState,
  webdavBackupAccountKey,
} from "./webdav-backup-account";

const account = {
  serverUrl: "https://dav.example.com",
  username: "alice",
  password: "s3cret-pass",
  directory: "rakazo-backup",
};

beforeEach(() => {
  store.values.clear();
  store.getItemAsync.mockClear();
  store.setItemAsync.mockClear();
  store.deleteItemAsync.mockClear();
});

describe("webdav backup account store", () => {
  it("keys the record per user id", () => {
    expect(webdavBackupAccountKey("user-1")).toBe("rakazo.webdav-backup.user-1");
    expect(webdavBackupAccountKey("user-2")).toBe("rakazo.webdav-backup.user-2");
  });

  it("round-trips an account and keeps accounts apart", async () => {
    await saveWebdavBackupAccount("user-1", account);
    await expect(loadWebdavBackupAccount("user-1")).resolves.toEqual(account);
    await expect(loadWebdavBackupAccount("user-2")).resolves.toBeNull();
  });

  it("returns null for a corrupt record", async () => {
    store.values.set("rakazo.webdav-backup.user-1", "{not json");
    await expect(loadWebdavBackupAccount("user-1")).resolves.toBeNull();
    store.values.set("rakazo.webdav-backup.user-1", JSON.stringify({ serverUrl: "x" }));
    await expect(loadWebdavBackupAccount("user-1")).resolves.toBeNull();
  });

  it("clears the account and its sync state on sign-out", async () => {
    await saveWebdavBackupAccount("user-1", account);
    await saveWebdavBackupSyncState("user-1", {
      lastSyncedAt: "2026-11-10T10:00:00.000Z",
      sha256: "a".repeat(64),
    });
    await clearWebdavBackupAccount("user-1");
    await expect(loadWebdavBackupAccount("user-1")).resolves.toBeNull();
    await expect(loadWebdavBackupSyncState("user-1")).resolves.toBeNull();
  });

  it("round-trips sync state and rejects a bad timestamp", async () => {
    await saveWebdavBackupSyncState("user-1", {
      lastSyncedAt: "2026-11-10T10:00:00.000Z",
      sha256: null,
    });
    await expect(loadWebdavBackupSyncState("user-1")).resolves.toEqual({
      lastSyncedAt: "2026-11-10T10:00:00.000Z",
      sha256: null,
    });
    store.values.set(
      "rakazo.webdav-backup.user-1.sync",
      JSON.stringify({ lastSyncedAt: "not a date", sha256: null }),
    );
    await expect(loadWebdavBackupSyncState("user-1")).resolves.toBeNull();
  });
});
