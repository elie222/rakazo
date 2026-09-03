import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMobileThreadEvent,
  authHeaders,
  blockText,
  changePassword,
  currentApiBase,
  deleteAccount,
  loadApiBase,
  type MobileMessage,
  type MobileSnapshot,
  mergeMobileSnapshot,
  passwordResetCapabilities,
  prependMobileMessagePage,
  requestPasswordReset,
  resetApiBase,
  rpc,
  saveApiBase,
  selectedSpaceId,
  selectInitialSpace,
  selectSpace,
  shouldApplyMobileThreadRefresh,
  signIn,
  signOut,
  signUp,
  subscribeThread,
} from "./api.js";
import { resumeLiveNotifications } from "./live-notifications.js";
import {
  clearSessionToken,
  restoreSessionToken,
  saveSessionToken,
  snapshotSessionToken,
} from "./session.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mobile API authentication", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    vi.mocked(resumeLiveNotifications).mockClear();
    await restoreSessionToken("");
  });

  it("persists a successful sign-in token and sends the native origin", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: "session-token" }));
    vi.stubGlobal("fetch", fetchMock);

    await signIn("ada@example.com", "correct horse");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/auth/sign-in/email",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", origin: "rakazo://" },
        body: JSON.stringify({ email: "ada@example.com", password: "correct horse" }),
      }),
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "session-token");
    expect(resumeLiveNotifications).not.toHaveBeenCalled();
  });

  it("creates an account and persists its session token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: "signup-token" }));
    vi.stubGlobal("fetch", fetchMock);

    await signUp("new@example.com", "correct horse", "New User");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/auth/sign-up/email",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", origin: "rakazo://" },
        body: JSON.stringify({
          email: "new@example.com",
          password: "correct horse",
          name: "New User",
        }),
      }),
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "signup-token");
  });

  it("loads password recovery capability and requests a server-approved redirect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ passwordReset: true, resetUrl: "https://rakazo.test/reset-password" }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(passwordResetCapabilities()).resolves.toEqual({
      passwordReset: true,
      resetUrl: "https://rakazo.test/reset-password",
    });
    await requestPasswordReset("ada@example.test", "https://rakazo.test/reset-password");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3100/api/auth/request-password-reset",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "ada@example.test",
          redirectTo: "https://rakazo.test/reset-password",
        }),
      }),
    );
  });

  it("changes a password with the bearer session and revokes other sessions", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi.fn(async () => jsonResponse({ status: true }));
    vi.stubGlobal("fetch", fetchMock);

    await changePassword("old-password", "new-password");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/auth/change-password",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer session-token" }),
        body: JSON.stringify({
          currentPassword: "old-password",
          newPassword: "new-password",
          revokeOtherSessions: true,
        }),
      }),
    );
  });

  it("does not send a password or bearer token to a persisted public HTTP server", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") return "http://app.example.test";
      if (key === "rakazo.session_token") return "session-token";
      return null;
    });
    const fetchMock = vi.fn(async () => jsonResponse({ status: true }));
    vi.stubGlobal("fetch", fetchMock);

    await loadApiBase();
    await changePassword("old-password", "new-password");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/auth/change-password",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer session-token" }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/app\.example\.test/),
      expect.anything(),
    );
  });

  it("starts notifications only after the inbox selects the default space", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "rakazo.session_token" ? "session-token" : null,
    );

    await expect(selectInitialSpace("space-default")).resolves.toBe(true);

    expect(selectedSpaceId()).toBe("space-default");
    expect(resumeLiveNotifications).toHaveBeenCalledWith(
      "http://127.0.0.1:3100",
      "session-token",
      "space-default",
    );
  });

  it("surfaces the server message and does not persist a failed sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Invalid credentials" }, { status: 401 })),
    );

    await expect(signIn("ada@example.com", "wrong")).rejects.toThrow("Invalid credentials");
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("clears the local session even when the sign-out request fails", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );

    await expect(signOut()).resolves.toBeUndefined();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
  });

  it("unregisters push delivery before invalidating the session", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ json: null }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await signOut();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/rpc/notifications/unregisterPush",
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
  });

  it("continues sign-out when push unregistration times out", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      )
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const pending = signOut();
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/rpc/notifications/unregisterPush",
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
  });

  it("unregisters push delivery before deleting the account", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ json: null }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await deleteAccount("correct horse");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/rpc/notifications/unregisterPush",
      "http://127.0.0.1:3100/api/auth/delete-user",
    ]);
  });

  it("sends authenticated RPC input and reports structured RPC errors", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ json: { ok: true } }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Bot does not exist" } }, { status: 404 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc<{ ok: boolean }>("bots/get", { botId: "bot-1" })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3100/rpc/bots/get",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer session-token" }),
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
    );
    await expect(rpc("bots/get", { botId: "missing" })).rejects.toThrow("Bot does not exist");
  });

  it("shares the selected space with direct API requests", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    await selectSpace("space-support");

    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
  });

  it("does not switch spaces when the selection cannot be persisted", async () => {
    await expect(selectSpace("space-support")).resolves.toBe(true);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    await selectSpace("");
  });

  it("does not switch spaces when stale recovery cannot be cleared", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith("rakazo.space_id", "space-social");
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await selectSpace("");
  });

  it("refuses sign-in when a previous space cannot be cleared", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: "new-session-token" })),
    );

    await expect(signIn("ada@example.com", "correct horse")).rejects.toThrow(
      "Could not clear the previous space",
    );
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.session_token",
      "new-session-token",
    );
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await selectSpace("");
  });

  it("clears server-specific session and space state when the API endpoint changes", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockClear();

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.space_id");
    await resetApiBase();
  });

  it("refuses to switch endpoints when SecureStore cannot clear credentials", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.api_base",
      "https://second-server.example",
    );
  });

  it("restores notifications to the selected space when endpoint rollback succeeds", async () => {
    const previousApiBase = currentApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "session-token";
      return null;
    });
    await selectSpace("space-social");
    await selectSpace("space-support");
    vi.mocked(resumeLiveNotifications).mockClear();
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" || (key === "rakazo.space_id" && value === "")) {
        throw new Error("device locked");
      }
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.api_base",
      "https://second-server.example",
    );
    expect(resumeLiveNotifications).toHaveBeenCalledWith(
      previousApiBase,
      "session-token",
      "space-support",
    );
  });

  it("restores credentials when the new endpoint cannot be persisted", async () => {
    const previous = currentApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "session-token";
      return null;
    });
    await selectSpace("space-support");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
  });

  it("restores a persisted space when its initial load failed", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await loadApiBase();
    const previous = currentApiBase();
    let spaceReads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key !== "rakazo.space_id") return null;
      spaceReads += 1;
      if (spaceReads === 1) throw new Error("device locked");
      return "space-support";
    });
    await loadApiBase();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(authHeaders()).resolves.toEqual({
      "x-rakazo-space-id": "space-support",
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.space_id", "space-support");
  });

  it("refuses an endpoint switch when the active space cannot be snapshotted", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await loadApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
      return null;
    });
    await loadApiBase();
    vi.mocked(SecureStore.deleteItemAsync).mockClear();

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("preserves credentials when the active session cannot be snapshotted", async () => {
    await saveSessionToken("session-token");
    await selectSpace("space-support");
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.deleteItemAsync).mockClear();
    const previous = currentApiBase();
    const next =
      previous === "https://second-server.example"
        ? "https://third-server.example"
        : "https://second-server.example";

    await expect(saveApiBase(next)).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    expect(currentApiBase()).toBe(previous);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();

    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "rakazo.session_token" ? "session-token" : null,
    );
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
  });

  it("keeps an invalidated empty session fail closed during credential rollback", async () => {
    await saveSessionToken("session-token");
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" && value === "") throw new Error("device locked");
    });
    await expect(clearSessionToken()).resolves.toBe(false);
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("stale-session-token");
    const previous = currentApiBase();
    const next =
      previous === "https://second-server.example"
        ? "https://third-server.example"
        : "https://second-server.example";

    await expect(saveApiBase(next)).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(snapshotSessionToken()).resolves.toEqual({ ok: true, value: "" });

    await saveSessionToken("session-token");
  });

  it("keeps the in-memory session across consecutive failed endpoint switches", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "session-token";
      return null;
    });
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" || (key === "rakazo.space_id" && value === "")) {
        throw new Error("device locked");
      }
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({
      ok: false,
    });
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await expect(saveApiBase("https://third-server.example")).resolves.toMatchObject({ ok: false });

    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.api_base",
      expect.stringMatching(/second-server|third-server/),
    );
  });

  it("restores credentials when resetting the endpoint cannot be persisted", async () => {
    await saveApiBase("https://second-server.example");
    const previous = currentApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "session-token";
      return null;
    });
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
    });

    await expect(resetApiBase()).resolves.toEqual({
      ok: false,
      error: "Could not clear the custom server URL",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });

    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await resetApiBase();
  });

  it("recovers the active space after rollback persistence fails", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await loadApiBase();
    await selectSpace("space-support");

    const storage = new Map<string, string>();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base" || (key === "rakazo.space_id" && value === "space-support")) {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    await expect(authHeaders()).resolves.toEqual({
      "x-rakazo-space-id": "space-support",
    });
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-support" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();

    expect(restartedApi.selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("does not recover a space on a different endpoint", async () => {
    const storage = new Map([
      ["rakazo.api_base", "https://second-server.example"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-support" }),
      ],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");

    await expect(restartedApi.loadApiBase()).resolves.toBe("https://second-server.example");
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("removes a malformed space rollback record", async () => {
    const storage = new Map([["rakazo.space_rollback", "null"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");

    await restartedApi.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });
});

describe("mobile thread subscription", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("");
  });

  it("parses fragmented SSE frames and ignores malformed data and completion markers", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.pro'));
        controller.enqueue(
          encoder.encode(
            'gress","seq":4,"payload":{"delta":"Hi"}}}\n\ndata: not-json\n\ndata: [DONE]\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"json":{"type":"thread.message.created",\n' +
              'data: "seq":5,"payload":{"messageId":"m1"}}}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, 3, onEvent, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/rpc/threads/subscribe",
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "text/event-stream" }),
        body: JSON.stringify({ json: { botId: "bot-1", cursor: 3 } }),
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "thread.progress", seq: 4 }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "thread.message.created", seq: 5 }),
    );
  });

  it("rejects responses that are unsuccessful or have no stream body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (503)");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (200)");
  });
});

describe("mobile thread refresh targeting", () => {
  it("drops a deferred group A refresh after navigation to group B", async () => {
    let activeGroupId: string | undefined = "group-a";
    let currentEpoch = 1;
    let resolveRequest!: (snapshot: MobileSnapshot) => void;
    const request = new Promise<MobileSnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    let applied: MobileSnapshot | null = null;
    const refresh = request.then((snapshot) => {
      if (
        shouldApplyMobileThreadRefresh({
          requestEpoch: 1,
          currentEpoch,
          targetBotId: undefined,
          targetGroupId: "group-a",
          activeBotId: undefined,
          activeGroupId,
        })
      ) {
        applied = snapshot;
      }
    });

    activeGroupId = "group-b";
    currentEpoch += 1;
    resolveRequest({
      groupId: "group-a",
      threadId: "thread-a",
      messages: [],
      olderCursor: null,
      run: null,
    });
    await refresh;

    expect(applied).toBeNull();
  });
});

describe("mobile thread event reduction", () => {
  it("applies a persisted thumbs-up event to its message", () => {
    const initial = snapshot([mobileMessage("message-1", [{ kind: "text", text: "Done" }])]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.reaction",
      seq: 4,
      payload: { messageId: "message-1", thumbsUp: true },
    });

    expect(next?.messages[0]?.thumbsUp).toBe(true);
    expect(next?.cursor).toBe(4);
  });

  it("prepends ordered history pages without duplicating the boundary message", () => {
    const initial = snapshot([mobileMessage("m-2", [], 2), mobileMessage("m-3", [], 3)], 2);

    const next = prependMobileMessagePage(initial, {
      threadId: "thread-1",
      messages: [
        mobileMessage("m-0", [], 0),
        mobileMessage("m-1", [], 1),
        mobileMessage("m-2", [], 2),
      ],
      olderCursor: null,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
    expect(next?.olderCursor).toBeNull();
  });

  it("retains loaded history across refresh while dropping stale progress", () => {
    const initial = snapshot(
      [
        mobileMessage("m-0", [], 0),
        mobileMessage("m-1", [], 1),
        mobileMessage("progress:run-1", [{ kind: "progress", text: "draft" }], 8),
      ],
      null,
    );
    const refreshed = snapshot([mobileMessage("m-1", [], 1), mobileMessage("m-2", [], 2)], 1);

    const next = mergeMobileSnapshot(initial, refreshed, true);

    expect(next.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(next.olderCursor).toBeNull();
  });

  it("accumulates progress deltas for the same run", () => {
    const first = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "Hel" },
    });
    const second = applyMobileThreadEvent(first, {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "lo" },
    });

    expect(second?.messages).toEqual([
      {
        id: "progress:run-1",
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "progress", text: "Hello" }],
      },
    ]);
  });

  it("preserves progress from a legacy run-only snapshot", () => {
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-legacy", [{ kind: "progress", text: "Still working" }]),
          runId: "run-legacy",
        },
      ]),
      run: { id: "run-legacy", status: "running" },
      activeRuns: undefined,
    };

    const next = applyMobileThreadEvent(initial, {
      type: "thread.progress",
      runId: "run-new",
      payload: { text: "New work" },
    });

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-legacy",
      "progress:run-new",
    ]);
  });

  it("preserves concurrent progress when active-run metadata lags", () => {
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-concurrent", [
            { kind: "progress", text: "Concurrent work" },
          ]),
          runId: "run-concurrent",
        },
      ]),
      run: { id: "run-current", status: "running" },
      activeRuns: [{ id: "run-current", status: "running" }],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "thread.progress",
      runId: "run-current",
      payload: { text: "Current work" },
    });

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-concurrent",
      "progress:run-current",
    ]);
  });

  it("holds live tool steps until mobile narration reaches a sentence boundary", () => {
    const narration = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      runId: "run-1",
      payload: { text: "Let me check " },
    });
    const pending = applyMobileThreadEvent(narration, {
      type: "agent.tool.called",
      runId: "run-1",
      payload: { name: "SLACK_FIND_CHANNELS" },
    });
    const completed = applyMobileThreadEvent(pending, {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "now." },
    });

    expect(pending?.messages[0]?.blocks).toEqual([
      {
        kind: "progress",
        text: "Let me check ",
        pendingToolNames: ["SLACK_FIND_CHANNELS"],
      },
    ]);
    expect(completed?.messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check now." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
    expect(blockText(completed?.messages[0] as MobileMessage)).toBe(
      "Let me check now.\nSlack find channels",
    );
  });

  it("formats channel messages with their platform attribution", () => {
    expect(
      blockText(
        mobileMessage("channel-1", [
          {
            kind: "channel_message",
            provider: "sendblue",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alex",
            text: "Hello from the group",
          },
        ]),
      ),
    ).toBe("iMessage · Alex: Hello from the group");
    expect(
      blockText(
        mobileMessage("channel-2", [
          {
            kind: "channel_message",
            provider: "slack",
            channelId: "ch-2",
            fromAddress: "U123456",
            fromLabel: "Alex",
            text: "Hello from the group",
          },
        ]),
      ),
    ).toBe("Slack · Alex: Hello from the group");
  });

  it("deduplicates durable messages and replaces matching transient subagent state", () => {
    const initial = snapshot([
      mobileMessage("message-1", [{ kind: "text", text: "old" }]),
      mobileMessage("subagent:research", [
        {
          kind: "subagent",
          agentId: "research",
          name: "Research",
          task: "Search",
          status: "running",
        },
      ]),
      mobileMessage("subagent:other", [
        { kind: "subagent", agentId: "other", name: "Other", task: "Wait", status: "running" },
      ]),
      {
        ...mobileMessage("progress:run-1", [{ kind: "progress", text: "draft" }]),
        runId: "run-1",
      },
    ]);
    const completed = {
      kind: "subagent" as const,
      agentId: "research",
      name: "Research",
      task: "Search",
      status: "completed" as const,
      result: "Done",
    };

    const next = applyMobileThreadEvent(initial, {
      id: "event-1",
      type: "thread.message.created",
      seq: 9,
      runId: "run-1",
      payload: { messageId: "message-1", role: "bot", blocks: [completed] },
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["message-1", "subagent:other"]);
    expect(next?.messages[0]?.blocks).toEqual([completed]);
  });

  it("keeps a replayed bot-to-bot marker in its durable transcript position", () => {
    const peerBlock = {
      kind: "bot_message_received" as const,
      fromBotId: "bot-peer",
      fromBotName: "Peer",
      text: "Please check this.",
    };
    const initial = snapshot([
      mobileMessage("peer-message", [peerBlock], 1),
      mobileMessage("newer-message", [{ kind: "text", text: "Working on it." }], 2),
    ]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.created",
      seq: 9,
      payload: { messageId: "peer-message", role: "user", blocks: [peerBlock] },
    });

    expect(next?.messages.map((message) => message.id)).toEqual(["peer-message", "newer-message"]);
  });

  it("clears loaded history and active state when another client clears the thread", () => {
    const initial = snapshot([mobileMessage("message-1", [{ kind: "text", text: "old" }])], 1);
    initial.run = { id: "run-1", status: "running" };

    const next = applyMobileThreadEvent(initial, { type: "thread.cleared", seq: 12 });

    expect(next).toMatchObject({ cursor: 12, messages: [], olderCursor: null, run: null });
  });

  it("applies the durable waiting-input run transition", () => {
    const initial: MobileSnapshot = { ...snapshot(), run: { id: "run-1", status: "running" } };
    const waiting = applyMobileThreadEvent(initial, {
      type: "run.waiting_input",
      runId: "run-1",
      seq: 8,
    });

    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.cursor).toBe(8);
    const repeated = applyMobileThreadEvent(waiting, {
      type: "run.waiting_input",
      runId: "run-1",
      seq: 9,
    });
    expect(repeated?.cursor).toBe(9);
    expect(repeated?.run).toBe(waiting?.run);
  });

  it("advances the cursor for durable message events", () => {
    const next = applyMobileThreadEvent(snapshot(), {
      type: "thread.message.created",
      seq: 11,
      payload: { messageId: "message-1", role: "bot", blocks: [{ kind: "text", text: "Done" }] },
    });

    expect(next?.cursor).toBe(11);
  });

  it("preserves ask actions and runId on created messages", () => {
    const initial = snapshot();
    const askBlock = {
      kind: "ask",
      text: "Review before writing",
      detail: "title: Result",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.created",
      runId: "run-1",
      payload: { messageId: "message-ask", role: "bot", blocks: [askBlock] },
    });

    expect(next?.messages.at(-1)).toMatchObject({
      id: "message-ask",
      runId: "run-1",
      blocks: [askBlock],
    });
  });

  it("updates a waiting group run without replacing the newer active run", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      run: { id: "run-newer", status: "running" },
      activeRuns: [
        { id: "run-newer", status: "running" },
        { id: "run-waiting", status: "running" },
      ],
    };

    const waiting = applyMobileThreadEvent(initial, {
      type: "run.waiting_input",
      runId: "run-waiting",
    });

    expect(waiting?.run).toEqual({ id: "run-newer", status: "running" });
    expect(waiting?.activeRuns).toEqual([
      { id: "run-newer", status: "running" },
      { id: "run-waiting", status: "waiting_input" },
    ]);
  });

  it("clears only the terminal run's live progress", () => {
    const runA = { id: "run-a", status: "running" };
    const runB = { id: "run-b", status: "running" };
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-a", [{ kind: "progress", text: "A" }]),
          runId: runA.id,
        },
        {
          ...mobileMessage("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.cancelled",
      seq: 10,
      runId: runA.id,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b"]);
    expect(next?.run).toEqual(runB);
    expect(next?.activeRuns).toEqual([runB]);
    expect(next?.cursor).toBe(10);
  });

  it("keeps a failed member run's error while another member run is still active", () => {
    const runA = { id: "run-a", status: "running" };
    const runB = { id: "run-b", status: "running" };
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.failed",
      seq: 11,
      runId: runB.id,
      payload: { error: "member exploded" },
    });

    expect(next?.activeRuns).toEqual([runA]);
    expect(next?.run).toEqual({ id: runB.id, status: "failed", error: "member exploded" });
    expect(next?.messages).toEqual([]);
  });

  it("leaves the snapshot unchanged for unrelated events", () => {
    const initial = snapshot();
    expect(applyMobileThreadEvent(initial, { type: "run.started" })).toBe(initial);
    expect(applyMobileThreadEvent(null, { type: "thread.progress" })).toBeNull();
  });
});

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function snapshot(
  messages: MobileMessage[] = [],
  olderCursor: number | null = null,
): MobileSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor,
    run: null,
    computer: {
      state: "running",
      controlHolder: "bot",
      screenAvailable: true,
      mode: "team",
      busyBotName: null,
    },
  };
}

function mobileMessage(id: string, blocks: MobileMessage["blocks"], seq?: number): MobileMessage {
  return { id, threadId: "thread-1", seq, role: "bot", blocks };
}
