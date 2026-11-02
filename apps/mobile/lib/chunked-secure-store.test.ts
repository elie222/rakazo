import * as SecureStore from "expo-secure-store";
import { beforeEach, expect, it, vi } from "vitest";
import { readChunkedSecureValue, writeChunkedSecureValue } from "./chunked-secure-store";
import {
  completeSessionRevocation,
  pendingSessionTokens,
  queueSessionRevocation,
} from "./pending-session-revocations";
import { loadSavedAccounts, rememberSavedAccount } from "./saved-accounts";

const native = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  failWrite: null as ((key: string) => boolean) | null,
  failDeletes: false,
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => native.disk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (Buffer.byteLength(value, "utf8") > 2_048) throw new Error("native value too large");
    if (native.failWrite?.(key)) throw new Error("native write failed");
    native.disk.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (native.failDeletes) throw new Error("native delete failed");
    native.disk.delete(key);
  }),
}));

const apiBase = "https://app.example.test";
const key = "rakazo.test_secure_value";
const token = (index: number) => `fixture-${index}.${"a".repeat(1_100)}.${"b".repeat(44)}`;
const account = (index: number) => ({
  userId: `account-${index}`,
  token: token(index),
  name: `家族 🐕 ${index}`,
  email: `account-${index}@example.test`,
  image: null,
  unread: index,
});

beforeEach(() => {
  native.disk.clear();
  native.failWrite = null;
  native.failDeletes = false;
});

it("stores five long-token accounts below the native limit and reads them after a cold start", async () => {
  for (let index = 0; index < 5; index++) await rememberSavedAccount(apiBase, account(index));
  expect(
    [...native.disk.values()].every((value) => Buffer.byteLength(value, "utf8") <= 2_048),
  ).toBe(true);
  vi.resetModules();
  const fresh = await import("./saved-accounts");
  expect(await fresh.loadSavedAccounts(apiBase)).toEqual(
    Array.from({ length: 5 }, (_, index) => account(index)),
  );
  const oldChunks = [...native.disk.keys()].filter((storedKey) => storedKey.includes(".chunks."));
  await fresh.forgetSavedToken(apiBase, token(0));
  expect(oldChunks.every((storedKey) => !native.disk.has(storedKey))).toBe(true);
  expect(await fresh.loadSavedAccounts(apiBase)).toHaveLength(4);
  expect([...native.disk.values()].join("")).not.toContain(token(0));
});

it("bounds pending revocations too and removes superseded credential chunks", async () => {
  for (let index = 0; index < 5; index++) await queueSessionRevocation(apiBase, token(index));
  vi.resetModules();
  const fresh = await import("./pending-session-revocations");
  expect(await fresh.pendingSessionTokens(apiBase)).toEqual(
    new Set(Array.from({ length: 5 }, (_, index) => token(index))),
  );
  await fresh.completeSessionRevocation(apiBase, token(0));
  expect((await fresh.pendingSessionTokens(apiBase)).size).toBe(4);
  expect([...native.disk.values()].join("")).not.toContain(token(0));
});

it("adopts legacy JSON without changing its data", async () => {
  native.disk.set("rakazo.saved_accounts", JSON.stringify({ [apiBase]: [account(0)] }));
  native.disk.set(
    "rakazo.pending_session_revocations",
    JSON.stringify([{ apiBase, token: token(1) }]),
  );
  expect(await loadSavedAccounts(apiBase)).toEqual([account(0)]);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set([token(1)]));
  await rememberSavedAccount(apiBase, account(2));
  await completeSessionRevocation(apiBase, token(1));
  expect(await loadSavedAccounts(apiBase)).toEqual([account(0), account(2)]);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set());
});

it("keeps the saved account set intact when its replacement cannot be committed", async () => {
  await rememberSavedAccount(apiBase, account(0));
  native.failWrite = (storedKey) => storedKey === "rakazo.saved_accounts";
  await expect(rememberSavedAccount(apiBase, account(1))).rejects.toThrow("native write failed");
  native.failWrite = null;
  expect(await loadSavedAccounts(apiBase)).toEqual([account(0)]);
});

it("does not rewrite unchanged account summaries or revocation entries", async () => {
  await rememberSavedAccount(apiBase, account(0));
  await queueSessionRevocation(apiBase, token(1));
  const writes = vi.mocked(SecureStore.setItemAsync).mock.calls.length;
  await rememberSavedAccount(apiBase, account(0));
  await queueSessionRevocation(apiBase, token(1));
  await completeSessionRevocation(apiBase, "missing-token");
  expect(vi.mocked(SecureStore.setItemAsync).mock.calls).toHaveLength(writes);
});

it.each(["chunk", "manifest"])(
  "preserves the last committed value after a rejected %s write",
  async (failure) => {
    await writeChunkedSecureValue(key, "previous value");
    native.failWrite = (storedKey) =>
      failure === "manifest" ? storedKey === key : storedKey.endsWith(".1");
    await expect(writeChunkedSecureValue(key, "new value ".repeat(600))).rejects.toThrow(
      "native write failed",
    );
    native.failWrite = null;
    expect(await readChunkedSecureValue(key)).toBe("previous value");
    expect(native.disk.has(`${key}.journal`)).toBe(false);
  },
);

it("recovers interrupted staging on a cold read and erases its credential chunks", async () => {
  await writeChunkedSecureValue(key, "previous value");
  const oldKeys = [...native.disk.keys()];
  native.failWrite = (storedKey) => storedKey === key;
  native.failDeletes = true;
  await expect(writeChunkedSecureValue(key, "staged secret ".repeat(400))).rejects.toThrow();
  expect(native.disk.has(`${key}.journal`)).toBe(true);
  native.failWrite = null;
  native.failDeletes = false;
  vi.resetModules();
  const fresh = await import("./chunked-secure-store");
  expect(await fresh.readChunkedSecureValue(key)).toBe("previous value");
  expect([...native.disk.keys()].sort()).toEqual(oldKeys.sort());
});

it("finishes interrupted cleanup after a committed write without restoring removed credentials", async () => {
  await writeChunkedSecureValue(key, "removed credential");
  const oldChunks = [...native.disk.keys()].filter((storedKey) => storedKey.includes(".chunks."));
  native.failDeletes = true;
  await writeChunkedSecureValue(key, "remaining credential");
  native.failDeletes = false;
  vi.resetModules();
  const fresh = await import("./chunked-secure-store");
  expect(await fresh.readChunkedSecureValue(key)).toBe("remaining credential");
  expect(oldChunks.every((storedKey) => !native.disk.has(storedKey))).toBe(true);
  expect(native.disk.has(`${key}.journal`)).toBe(false);
});

it("keeps multibyte text intact and rejects incomplete committed data", async () => {
  const value = "家族🐕é".repeat(1_000);
  await writeChunkedSecureValue(key, value);
  expect(await readChunkedSecureValue(key)).toBe(value);
  const missing = [...native.disk.keys()].find((storedKey) => storedKey.includes(".chunks."))!;
  native.disk.delete(missing);
  await expect(readChunkedSecureValue(key)).rejects.toThrow("Could not read secure storage");
});
