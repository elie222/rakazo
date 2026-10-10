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

it("fails closed when namespace metadata cannot be persisted", async () => {
  const cache = await load();
  vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
  await expect(cache.artifactCacheSession("fake-a")).rejects.toThrow("locked");
  expect(disk.size).toBe(0);
});

it("keeps an invalidated namespace when both wipe attempts fail", async () => {
  const cache = await load();
  const namespace = await cache.artifactCacheSession("fake-a");
  vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error("locked"));
  vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
  await cache.invalidateArtifactCacheSession();
  expect(await cache.artifactCacheSession("fake-a")).not.toBe(namespace);
});
