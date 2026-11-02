import { beforeEach, expect, it, vi } from "vitest";
import {
  refreshAccountSummaries,
  selectNotificationAccount,
  selectSavedAccount,
  signOutAllAccounts,
} from "./account-sessions";
import { forgetSavedToken, loadSavedAccounts, rememberSavedAccount } from "./saved-accounts";

const state = vi.hoisted(() => ({
  token: "family-token",
  generation: 0,
  disk: new Map<string, string>(),
  save: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => state.disk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    state.disk.set(key, value);
  }),
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
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
