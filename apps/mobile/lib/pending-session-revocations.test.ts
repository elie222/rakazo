import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  pendingSessionTokens,
  queueSessionRevocation,
  retryPendingSessionRevocations,
} from "./pending-session-revocations";

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
vi.mock("./server-headers", () => ({
  fetchServer: (...args: Parameters<typeof fetch>) => fetch(...args),
}));

const apiBase = "https://app.example.test";
beforeEach(() => {
  disk.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true })),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("retains failed remote sign-outs for a later bounded bearer-only retry", async () => {
  await queueSessionRevocation(apiBase, "family-token");
  vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
  await retryPendingSessionRevocations(apiBase);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["family-token"]));
  await retryPendingSessionRevocations(apiBase);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set());
  expect(fetch).toHaveBeenLastCalledWith(
    `${apiBase}/api/auth/sign-out`,
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      body: "{}",
      headers: expect.objectContaining({ authorization: "Bearer family-token" }),
      signal: expect.any(AbortSignal),
    }),
    apiBase,
  );
});

it("keeps each queued sign-out under its own key and drops an unreadable queue", async () => {
  await queueSessionRevocation(apiBase, "family-token");
  await queueSessionRevocation(apiBase, "work-token");
  await queueSessionRevocation(apiBase, "work-token");
  expect([...disk.keys()].filter((key) => key.startsWith("rakazo.revocation."))).toHaveLength(2);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["family-token", "work-token"]));
  const workKey = [...disk.keys()].find((key) => disk.get(key) === "work-token")!;
  disk.delete(workKey);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["family-token"]));
  disk.set("rakazo.revocations", "{not json");
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set());
  await queueSessionRevocation(apiBase, "family-token");
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["family-token"]));
});

it("retries only the configured server and keeps HTTP failures queued", async () => {
  await Promise.all([
    queueSessionRevocation(apiBase, "family-token"),
    queueSessionRevocation("https://other.example.test", "work-token"),
  ]);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 500 }));
  await retryPendingSessionRevocations(apiBase);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["family-token"]));
  expect(await pendingSessionTokens("https://other.example.test")).toEqual(new Set(["work-token"]));
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 401 }));
  await retryPendingSessionRevocations(apiBase);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["family-token"]));
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true }));
  await retryPendingSessionRevocations(apiBase);
  expect(await pendingSessionTokens(apiBase)).toEqual(new Set());
});

it("aborts a stalled retry and retains its revocation credential", async () => {
  vi.useFakeTimers();
  try {
    await queueSessionRevocation(apiBase, "family-token");
    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const retry = retryPendingSessionRevocations(apiBase);
    await vi.advanceTimersByTimeAsync(8_000);
    await retry;
    expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["family-token"]));
  } finally {
    vi.useRealTimers();
  }
});
