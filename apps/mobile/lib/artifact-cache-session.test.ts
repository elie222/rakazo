import * as SecureStore from "expo-secure-store";
import { beforeEach, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => disk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    disk.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    disk.delete(key);
  }),
}));
const load = () => import("./artifact-cache-session");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  disk.clear();
});

it("restores only the exact authenticated session after restart", async () => {
  let cache = await load();
  const namespace = await cache.artifactCacheSession("fake-a");
  vi.resetModules();
  cache = await load();
  expect(await cache.artifactCacheSession("fake-a")).toBe(namespace);
  expect(await cache.artifactCacheSession("fake-b")).not.toBe(namespace);
  await expect(cache.artifactCacheSession("")).rejects.toThrow("Artifact session changed");
});

it("rotates metadata on sign-out even when the same token is restored", async () => {
  const cache = await load();
  const namespace = await cache.artifactCacheSession("fake-a");
  await cache.invalidateArtifactCacheSession();
  vi.resetModules();
  expect(await (await load()).artifactCacheSession("fake-a")).not.toBe(namespace);
});

it("does not restore a late metadata read after invalidation", async () => {
  const cache = await load();
  let finish!: (value: string) => void;
  vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = cache.artifactCacheSession("fake-a");
  await vi.waitFor(() => expect(finish).toBeDefined());
  const clearing = cache.invalidateArtifactCacheSession();
  finish(JSON.stringify({ token: "fake-a", namespace: "old-namespace" }));
  await expect(pending).rejects.toThrow("Artifact session changed");
  await clearing;
  expect(await cache.artifactCacheSession("fake-a")).not.toBe("old-namespace");
});

it("uses a fresh namespace when metadata writes fail, retaining it only in memory", async () => {
  let cache = await load();
  const stored = await cache.artifactCacheSession("fake-a");
  vi.resetModules();
  cache = await load();
  const failWrite = () =>
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
  failWrite();
  const fallback = await cache.artifactCacheSession("fake-a");
  expect(fallback).not.toBe(stored);
  failWrite();
  expect(await cache.artifactCacheSession("fake-a")).toBe(fallback);
  vi.resetModules();
  cache = await load();
  failWrite();
  const restarted = await cache.artifactCacheSession("fake-a");
  expect(restarted).not.toBe(stored);
  expect(restarted).not.toBe(fallback);
  // Once persistence recovers, the fresh namespace can safely survive a restart.
  expect(await cache.artifactCacheSession("fake-a")).toBe(restarted);
  vi.resetModules();
  expect(await (await load()).artifactCacheSession("fake-a")).toBe(restarted);
});

it("allows a cold cache when metadata cannot be read or written", async () => {
  const cache = await load();
  vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("locked"));
  vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
  expect(await cache.artifactCacheSession("fake-a")).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  expect(disk.size).toBe(0);
});

it("rejects a failed metadata write that completes after invalidation", async () => {
  const cache = await load();
  let fail!: (error: Error) => void;
  vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const pending = cache.artifactCacheSession("fake-a");
  await vi.waitFor(() => expect(fail).toBeDefined());
  const clearing = cache.invalidateArtifactCacheSession();
  fail(new Error("locked"));
  await expect(pending).rejects.toThrow("Artifact session changed");
  await clearing;
});

it("keeps an invalidated namespace when both wipe attempts fail", async () => {
  const cache = await load();
  const namespace = await cache.artifactCacheSession("fake-a");
  vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error("locked"));
  vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
  await cache.invalidateArtifactCacheSession();
  expect(await cache.artifactCacheSession("fake-a")).not.toBe(namespace);
});
