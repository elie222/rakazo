import * as SecureStore from "expo-secure-store";
import { beforeEach, expect, it, vi } from "vitest";
import {
  loadAccountSummaries,
  refreshAccountSummaries,
  selectNextSavedAccount,
  selectNotificationAccount,
  selectSavedAccount,
  signOutAllAccounts,
} from "./account-sessions";
import { pendingSessionTokens } from "./pending-session-revocations";
import {
  forgetSavedToken,
  loadSavedAccounts,
  rememberSavedAccount,
  savedAccountRevocationSnapshot,
} from "./saved-accounts";

const state = vi.hoisted(() => ({
  token: "family-token",
  generation: 0,
  apiBase: "https://app.example.test",
  disk: new Map<string, string>(),
  save: vi.fn(),
  signOut: vi.fn(),
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
vi.mock("./api", () => ({
  currentApiBase: () => state.apiBase,
  loadSessionToken: async () => state.token,
  clearSpace: async () => true,
  signOut: state.signOut,
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  saveSessionToken: state.save,
}));
vi.mock("./live-notifications", () => ({ stopLiveNotifications: vi.fn(async () => undefined) }));
vi.mock("./server-headers", () => ({
  fetchServer: (...args: Parameters<typeof fetch>) => fetch(...args),
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
const apiBase = "https://app.example.test";
const account = (userId: string, token: string) => ({
  userId,
  token,
  name: userId,
  email: `${userId}@example.test`,
  image: null,
  unread: 0,
});
beforeEach(async () => {
  state.disk.clear();
  state.token = "family-token";
  state.generation = 0;
  state.apiBase = apiBase;
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
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const token = (init.headers as Record<string, string>).authorization;
      const id = token === "Bearer family-token" ? "family" : "work";
      return Response.json({ user: { id, name: id, email: `${id}@example.test`, image: null } });
    }),
  );
  await rememberSavedAccount(apiBase, account("family", "family-token"));
  await rememberSavedAccount(apiBase, account("work", "work-token"));
});
it("returns local recovery identities without credentials or notification settings", async () => {
  const summaries = await loadAccountSummaries();
  expect(summaries.map((row) => row.userId)).toEqual(["family", "work"]);
  expect(summaries).toEqual(
    expect.arrayContaining([expect.objectContaining({ email: "work@example.test" })]),
  );
  for (const summary of summaries) {
    expect(summary).not.toHaveProperty("token");
    expect(summary).not.toHaveProperty("notifications");
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("validates and selects the notification owner while preserving the other login", async () => {
  expect(await selectNotificationAccount("work")).toBe(true);
  expect(state.token).toBe("work-token");
  expect(await loadSavedAccounts(apiBase)).toHaveLength(2);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/auth/get-session"),
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer work-token" }),
    }),
    apiBase,
  );
});
it("does not open legacy identity-less notifications with multiple saved accounts", async () => {
  expect(await selectNotificationAccount()).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
});
it("refuses revoked or removed accounts without selecting the displayed identity", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(null));
  expect(await selectSavedAccount("work")).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
  expect((await loadSavedAccounts(apiBase)).map((row) => row.userId)).toEqual(["family"]);
  expect(await selectNotificationAccount("missing")).toBe(false);
});
it("refuses a bearer that authenticates a different user", async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ user: { id: "family", email: "family@example.test" } }),
  );
  expect(await selectSavedAccount("work")).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
});
it("a sign-out during validation cannot resurrect the selected bearer", async () => {
  vi.mocked(fetch).mockImplementation(async () => {
    state.generation++;
    return Response.json({ user: { id: "work", email: "work@example.test" } });
  });
  expect(await selectSavedAccount("work")).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
});

it("late unread refresh cannot restore an account removed while the request was waiting", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const isWork = new Headers(init?.headers).get("authorization") === "Bearer work-token";
    if (isWork) await waiting;
    return Response.json({ accounts: [{ userId: isWork ? "work" : "family", unread: 3 }] });
  });
  const refreshing = refreshAccountSummaries();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await forgetSavedToken(apiBase, "work-token");
  release();
  await refreshing;
  expect((await loadSavedAccounts(apiBase)).map((row) => row.userId)).toEqual(["family"]);
});
it("a late revoked response cannot delete a replacement bearer for the same account", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const isWork = new Headers(init?.headers).get("authorization") === "Bearer work-token";
    if (isWork) {
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

it("refuses another server's notification even if its user ID is cloned", async () => {
  expect(await selectNotificationAccount("work", "https://other.example.test")).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  await rememberSavedAccount("https://other.example.test", account("work", "other-work-token"));
  expect(await selectNotificationAccount("work")).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
});

it("sign-out-all revokes each saved bearer and removes all local logins", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ success: true }));
  await signOutAllAccounts();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/auth/sign-out"),
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      headers: expect.objectContaining({ authorization: "Bearer family-token" }),
    }),
    apiBase,
  );
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/auth/sign-out"),
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer work-token" }),
    }),
    apiBase,
  );
  expect(await loadSavedAccounts(apiBase)).toEqual([]);
  expect(state.signOut).toHaveBeenCalledOnce();
});
it("sign-out-all clears local logins even when remote revocation is offline", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  await expect(signOutAllAccounts()).rejects.toThrow("Some server sessions could not be revoked");
  expect(await loadSavedAccounts(apiBase)).toEqual([]);
  expect(state.signOut).toHaveBeenCalledOnce();
});

it("blocks saved-account selection during sign-out-all and clears an already selected revoked bearer", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(fetch).mockImplementation(async () => {
    await waiting;
    return Response.json({ success: true });
  });
  const signingOut = signOutAllAccounts();
  const duplicate = signOutAllAccounts();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await duplicate;
  expect(await selectSavedAccount("work")).toBe(false);
  // A selection already in progress can have installed a snapshotted token before the fence.
  state.token = "work-token";
  state.generation++;
  release();
  await signingOut;
  expect(state.signOut).toHaveBeenCalledOnce();
  expect(state.token).toBe("");
});

it("keeps an unrelated new login installed during remote sign-out-all", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(fetch).mockImplementation(async () => {
    await waiting;
    return Response.json({ success: true });
  });
  const signingOut = signOutAllAccounts();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  state.token = "new-login-token";
  state.generation++;
  release();
  await signingOut;
  expect(state.signOut).not.toHaveBeenCalled();
  expect(state.token).toBe("new-login-token");
});

it("sign-out-all revokes and removes every server's saved login at its own origin", async () => {
  const other = "https://other.example.test";
  await rememberSavedAccount(other, account("family", "other-family-token"));
  await rememberSavedAccount(other, account("work", "other-work-token"));
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const bearer = new Headers(init?.headers).get("authorization");
    const expectedServer = bearer?.includes("other-") ? other : apiBase;
    expect(url).toBe(`${expectedServer}/api/auth/sign-out`);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    return Response.json({ success: true });
  });
  await signOutAllAccounts();
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(await loadSavedAccounts(apiBase)).toEqual([]);
  expect(await loadSavedAccounts(other)).toEqual([]);
  expect(await pendingSessionTokens(other)).toEqual(new Set());
  expect(state.signOut).toHaveBeenCalledWith(
    expect.arrayContaining(["family-token", "work-token"]),
    apiBase,
  );
});

it("removes an offline other-server login and keeps only its revocation tombstone", async () => {
  const other = "https://other.example.test";
  await rememberSavedAccount(other, account("work", "other-work-token"));
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (String(url).startsWith(other)) throw new Error("offline");
    return Response.json({ success: true });
  });
  await expect(signOutAllAccounts()).rejects.toThrow("Some server sessions could not be revoked");
  expect(await loadSavedAccounts(apiBase)).toEqual([]);
  expect(await loadSavedAccounts(other)).toEqual([]);
  expect(await pendingSessionTokens(other)).toEqual(new Set(["other-work-token"]));
});

it("does not clear a new other-server login whose token matches an old server's token", async () => {
  const other = "https://other.example.test";
  await rememberSavedAccount(other, account("work", "other-work-token"));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(fetch).mockImplementation(async () => {
    await waiting;
    return Response.json({ success: true });
  });
  const signingOut = signOutAllAccounts();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  state.apiBase = other;
  state.token = "family-token";
  state.generation++;
  await rememberSavedAccount(other, account("work", "family-token"));
  release();
  await signingOut;
  expect(state.signOut).not.toHaveBeenCalled();
  expect((await loadSavedAccounts(other)).map((row) => row.token)).toEqual(["family-token"]);
});

it("skips a revoked fallback and selects the next valid saved account", async () => {
  state.token = "";
  vi.mocked(fetch).mockImplementation(async (_url, init) =>
    new Headers(init?.headers).get("authorization") === "Bearer family-token"
      ? Response.json(null, { status: 401 })
      : Response.json({ user: { id: "work", email: "work@example.test" } }),
  );
  expect(await selectNextSavedAccount()).toBe("selected");
  expect(state.token).toBe("work-token");
  expect((await loadSavedAccounts(apiBase)).map((row) => row.userId)).toEqual(["work"]);
});

it("revokes and removes every saved credential even when the pending store is malformed", async () => {
  state.disk.set("rakazo.pending_session_revocations", "malformed-json");
  vi.mocked(fetch).mockImplementation(async () => Response.json({ success: true }));
  await signOutAllAccounts();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await savedAccountRevocationSnapshot()).toEqual([]);
  expect(state.token).toBe("");
  expect(state.signOut).toHaveBeenCalledOnce();
  await expect(loadSavedAccounts(apiBase)).rejects.toThrow();
});

it("does not let revocation-queue write failure skip remote or local sign-out-all", async () => {
  const original = vi.mocked(SecureStore.setItemAsync).getMockImplementation()!;
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    if (key.startsWith("rakazo.pending_session_revocations")) throw new Error("Storage locked");
    return original(key, value);
  });
  try {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ success: true }));
    await signOutAllAccounts();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await loadSavedAccounts(apiBase)).toEqual([]);
    expect(state.token).toBe("");
  } finally {
    vi.mocked(SecureStore.setItemAsync).mockImplementation(original);
  }
});

it("reports remote failure after local sign-out-all when no retry credential can be saved", async () => {
  state.disk.set("rakazo.pending_session_revocations", "malformed-json");
  vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  await expect(signOutAllAccounts()).rejects.toThrow("Some server sessions could not be revoked");
  expect(await savedAccountRevocationSnapshot()).toEqual([]);
  expect(state.token).toBe("");
  expect(state.signOut).toHaveBeenCalledOnce();
});

it("reports no fallback only after every saved account is revoked", async () => {
  state.token = "";
  vi.mocked(fetch).mockImplementation(async () => Response.json(null, { status: 401 }));
  expect(await selectNextSavedAccount()).toBe("unavailable");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(state.save).not.toHaveBeenCalled();
});

it.each(["session", "server"])(
  "stops fallback selection when another %s operation wins",
  async (change) => {
    state.token = "";
    vi.mocked(fetch).mockImplementation(async () => {
      if (change === "session") {
        state.token = "new-session";
        state.generation++;
      } else state.apiBase = "https://other.example.test";
      return Response.json(null, { status: 401 });
    });
    expect(await selectNextSavedAccount()).toBe("changed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.save).not.toHaveBeenCalled();
  },
);
