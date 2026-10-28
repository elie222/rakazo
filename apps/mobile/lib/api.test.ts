vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import type { RpcInput } from "@rakazo/contracts";
import {
  dismissableAskMessageIds,
  isServerUnreachable,
  withLiveStreamingProgress,
} from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptAiConsent } from "./ai-consent";
import type { MobileMessage, MobileModelCredential, MobileSnapshot } from "./api.js";
import {
  adoptDeletedSpaceFallback,
  applyMobileThreadEvent,
  authHeaders,
  blockText,
  captureApiRequestContext,
  changePassword,
  currentApiBase,
  deleteAccount,
  fetchAccountSecurity,
  IDLE_TIMEOUT_MS,
  isServerReachable,
  loadApiBase,
  MAX_MOBILE_AUTH_RESPONSE_BYTES,
  MAX_MOBILE_RPC_RESPONSE_BYTES,
  mergeMobileSnapshot,
  mobileThreadRefreshResult,
  passwordResetCapabilities,
  prependMobileMessagePage,
  requestAccountDeletionCode,
  requestPasswordReset,
  resetApiBase,
  rpc,
  saveApiBase,
  selectedSpaceId,
  selectInitialSpace,
  selectSpace,
  sendSignInCode,
  shouldApplyMobileThreadRefresh,
  signIn,
  signInWithCode,
  signOut,
  signUp,
  spaceSelectionSeq,
  subscribeServerReachable,
  subscribeSessionRejected,
  subscribeThread,
  updateAccountName,
} from "./api.js";
import { resumeLiveNotifications } from "./live-notifications.js";
import { threadRefreshDelayMs } from "./refresh";
import {
  clearSessionToken,
  restoreSessionToken,
  saveSessionToken,
  snapshotSessionToken,
} from "./session.js";
import type { UnsentDisk } from "./thread-feedback.js";
import { configureUnsentSends } from "./thread-feedback.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mobile API authentication", () => {
  it("does not send a captured old bearer after the session changes", async () => {
    await saveSessionToken("fake-session-a");
    const context = await captureApiRequestContext();
    await saveSessionToken("fake-session-b");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(rpc("bots/list", {}, { requestContext: context })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    vi.mocked(resumeLiveNotifications).mockClear();
    await restoreSessionToken("");
  });

  describe.each([signIn, signUp])("email auth errors", (authenticate) => {
    it.each([
      [429, "", "Too many attempts. Try again in a few minutes."],
      [
        500,
        "<html>Internal Server Error</html>",
        "The server had a problem. Try again in a moment.",
      ],
      [400, "not json", "The server had a problem. Try again in a moment."],
      [200, "not json", "The server had a problem. Try again in a moment."],
      [500, "{}", "The server had a problem. Try again in a moment."],
      [503, "{}", "Could not reach the server"],
      [502, "<html>Bad gateway</html>", "Could not reach the server"],
      [504, "{}", "Could not reach the server"],
      [403, '{"code":"PASSWORD_AUTH_DISABLED"}', "Password sign-in is turned off on this server"],
      [
        400,
        '{"code":"PASSWORD_TOO_LONG","message":"Password too long"}',
        "Password must be 128 characters or fewer",
      ],
      [403, '{"message":"Registration is closed"}', "Registration is closed"],
      [
        422,
        '{"message":"User already exists. Use another email."}',
        "User already exists. Use another email.",
      ],
      [
        429,
        '{"message":"Please wait before signing in again"}',
        "Please wait before signing in again",
      ],
      [500, '{"message":"DatabaseException"}', "The server had a problem. Try again in a moment."],
      [400, "{}", "Could not continue"],
    ])("maps HTTP %s with body %s", async (status, body, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status })),
      );
      await expect(authenticate("new@example.test", "password", "New User")).rejects.toThrow(
        message,
      );
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    });

    it("maps network failures", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network request failed")));
      await expect(authenticate("new@example.test", "password", "New User")).rejects.toThrow(
        "Could not reach the server",
      );
    });

    it.each(["save", "clear"])("explains device storage failures during %s", async (step) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ token: "fake-token" })),
      );
      const failure = new Error("SecureStoreException: storage unavailable");
      if (step === "clear") vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(failure);
      vi.mocked(SecureStore.setItemAsync).mockRejectedValue(failure);
      await expect(authenticate("new@example.test", "password", "New User")).rejects.toThrow(
        "Could not save your sign-in on this device. Try again.",
      );
    });

    it("preserves human storage error messages", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ token: "fake-token" })),
      );
      vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("Device storage is full"));
      await expect(authenticate("new@example.test", "password", "New User")).rejects.toThrow(
        "Device storage is full",
      );
    });
  });

  describe.each([
    {
      name: "password reset",
      request: () => requestPasswordReset("ada@example.test", "https://rakazo.test/reset-password"),
      fallback: "Could not send reset email",
    },
    {
      name: "password change",
      request: () => changePassword("old-password", "new-password"),
      fallback: "Could not change password",
    },
    {
      name: "account deletion",
      request: () => deleteAccount("password"),
      fallback: "Could not delete account",
    },
    {
      name: "account deletion code",
      request: () => requestAccountDeletionCode(),
      fallback: "Could not continue",
    },
  ])("$name errors", ({ request, fallback }) => {
    it.each([
      [429, "", "Too many attempts. Try again in a few minutes."],
      [502, "<html>Bad gateway</html>", "Could not reach the server"],
      [503, "<html>Service unavailable</html>", "Could not reach the server"],
      [504, "<html>Gateway timeout</html>", "Could not reach the server"],
      [
        500,
        "<html>Internal Server Error</html>",
        "The server had a problem. Try again in a moment.",
      ],
      [500, "{}", "The server had a problem. Try again in a moment."],
      [400, "not json", "The server had a problem. Try again in a moment."],
      // Preserve the existing action-specific fallback for ordinary JSON errors.
      [400, "{}", fallback],
      [429, '{"message":"Please wait before trying again"}', "Please wait before trying again"],
      [403, '{"code":"REAUTHENTICATION_REQUIRED"}', "Sign in again"],
    ])("maps HTTP %s with body %s", async (status, body, message) => {
      vi.mocked(SecureStore.getItemAsync).mockResolvedValue("fake-session");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input) =>
          String(input).endsWith("/rpc/notifications/unregisterPush")
            ? jsonResponse({ json: null })
            : new Response(body, { status }),
        ),
      );

      await expect(request()).rejects.toThrow(message);

      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith("rakazo.session_token");
      expect(await authHeaders(null)).toEqual({ authorization: "Bearer fake-session" });
    });
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

  it("deletes unsent messages left on disk when a new account signs in", async () => {
    const clear = vi.fn();
    configureUnsentSends({
      request: vi.fn(),
      serverReachable: () => true,
      scope: () => null,
      disk: { clear, save: vi.fn() } as unknown as UnsentDisk,
      errorText: String,
      notDelivered: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: "session-token" })),
    );
    await signIn("ada@example.com", "correct horse");
    expect(clear).toHaveBeenCalledOnce();
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

  it("emails a sign-in code and persists the session the code returns", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ token: "code-token", user: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await sendSignInCode("ada@example.test");
    await signInWithCode("ada@example.test", "123456", "Ada");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3100/api/auth/email-otp/send-verification-otp",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", origin: "rakazo://" },
        body: JSON.stringify({ email: "ada@example.test", type: "sign-in" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3100/api/auth/sign-in/email-otp",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", origin: "rakazo://" },
        body: JSON.stringify({ email: "ada@example.test", otp: "123456", name: "Ada" }),
      }),
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "code-token");
  });

  it.each([
    ["INVALID_OTP", 400, "Invalid code"],
    ["OTP_EXPIRED", 400, "Request a new code"],
    ["TOO_MANY_ATTEMPTS", 403, "Request a new code"],
  ])("explains a rejected %s sign-in code", async (code, status, message) => {
    const fetchMock = vi.fn(async () => jsonResponse({ code, message: code }, { status }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(signInWithCode("ada@example.test", "000000")).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/auth/sign-in/email-otp",
      expect.objectContaining({
        body: JSON.stringify({ email: "ada@example.test", otp: "000000" }),
      }),
    );
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("loads password recovery capability and requests a server-approved redirect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          passwordAuth: true,
          sso: null,
          passwordReset: true,
          resetUrl: "https://rakazo.test/reset-password",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(passwordResetCapabilities()).resolves.toEqual({
      passwordAuth: true,
      sso: null,
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

  it("accepts complete pre-SSO capabilities as password-only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          passwordReset: true,
          resetUrl: "https://rakazo.test/reset-password",
          billing: false,
        }),
      ),
    );
    await expect(passwordResetCapabilities()).resolves.toEqual({
      passwordAuth: true,
      sso: null,
      passwordReset: true,
      resetUrl: "https://rakazo.test/reset-password",
      billing: false,
    });
  });

  it("updates the trimmed account name through the authenticated user endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await updateAccountName("  Alex Rivera  ");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/auth/update-user");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ origin: "rakazo://" }),
      body: JSON.stringify({ name: "Alex Rivera" }),
    });
  });

  it.each(["", "   ", "💬", "__AbCdEfGh__", "x".repeat(81)])(
    "rejects an unsupported name before making a request (%s)",
    async (name) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(updateAccountName(name)).rejects.toThrow("Could not update name");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("keeps the recovery instruction from a rejected name update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "REAUTHENTICATION_REQUIRED" }, { status: 403 })),
    );
    await expect(updateAccountName("Alex Rivera")).rejects.toThrow("Sign in again");
  });

  it("reports a failed account name update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, { status: 500 })),
    );
    await expect(updateAccountName("Alex Rivera")).rejects.toThrow();
  });

  it("uses original password change and deletion endpoints after account-security 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ status: true }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAccountSecurity()).resolves.toEqual({
      hasPassword: true,
      passwordChangeEnabled: true,
      freshOidcAuth: false,
      ssoLinked: false,
      emailDeletion: false,
      sso: null,
    });
    await changePassword("old-password", "new-password");
    await deleteAccount("new-password");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/auth/change-password");
    expect(fetchMock.mock.calls[3]?.[0]).toContain("/api/auth/delete-user");
    expect(JSON.parse(fetchMock.mock.calls[3]?.[1]?.body)).toEqual({ password: "new-password" });
  });

  it.each([401, 500])("does not fall back for account-security HTTP %s", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, { status })),
    );
    await expect(fetchAccountSecurity()).rejects.toThrow();
  });

  it("rejects malformed account-security responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ hasPassword: true })),
    );
    await expect(fetchAccountSecurity()).rejects.toThrow();
  });

  it("rejects a malformed capabilities response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );

    await expect(passwordResetCapabilities()).rejects.toThrow();
  });

  it.each([
    {},
    { passwordReset: false, resetUrl: null, sso: null },
    { passwordReset: "false", resetUrl: null },
    { passwordReset: false, resetUrl: "invalid" },
    { passwordReset: false, resetUrl: null, billing: "false" },
    { passwordAuth: "false", sso: null, passwordReset: false, resetUrl: null },
    { passwordAuth: true, passwordReset: false, resetUrl: null, sso: {} },
  ])("rejects malformed successful capability shapes", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body)),
    );
    await expect(passwordResetCapabilities()).rejects.toThrow();
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

  it("keeps the session the server issues after revoking the others", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "rakazo.session_token" ? "session-token" : null,
    );
    await selectInitialSpace("space-default");
    vi.mocked(resumeLiveNotifications).mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: "rotated-token", user: { id: "user-1" } })),
    );

    await changePassword("old-password", "new-password");

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "rotated-token");
    expect(resumeLiveNotifications).toHaveBeenCalledWith(
      "http://127.0.0.1:3100",
      "rotated-token",
      "space-default",
    );
  });

  it("drops a rotated token when sign-out clears the session before the response", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    await selectSpace("space-default");
    vi.mocked(resumeLiveNotifications).mockClear();
    const { fetchMock, resolveFetch, fetchStarted } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = changePassword("old-password", "new-password");
    await fetchStarted;
    await clearSessionToken();
    resolveFetch(jsonResponse({ token: "rotated-token", user: { id: "user-1" } }));
    await pending;

    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.session_token",
      "rotated-token",
    );
    expect(resumeLiveNotifications).not.toHaveBeenCalled();
  });

  it("keeps the rotated token when the session store is unreadable at response time", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    const { fetchMock, resolveFetch, fetchStarted } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = changePassword("old-password", "new-password");
    await fetchStarted;
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("keychain locked"));
    resolveFetch(jsonResponse({ token: "rotated-token", user: { id: "user-1" } }));
    await pending;

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "rotated-token");
  });

  it("keeps the rotated token in memory and reports a failed keychain write", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: "rotated-token", user: { id: "user-1" } })),
    );
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("keychain unavailable"));

    await expect(changePassword("old-password", "new-password")).rejects.toThrow(
      "keychain unavailable",
    );

    await expect(authHeaders()).resolves.toMatchObject({ authorization: "Bearer rotated-token" });
  });

  it("resumes live notifications with the rotated token when the keychain write fails", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    await selectSpace("space-default");
    vi.mocked(resumeLiveNotifications).mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: "rotated-token", user: { id: "user-1" } })),
    );
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("keychain unavailable"));

    await expect(changePassword("old-password", "new-password")).rejects.toThrow(
      "keychain unavailable",
    );

    expect(resumeLiveNotifications).toHaveBeenCalledWith(
      "http://127.0.0.1:3100",
      "rotated-token",
      "space-default",
    );
  });

  it("drops a rotated token when the server changes before the response", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    await selectSpace("space-default");
    vi.mocked(resumeLiveNotifications).mockClear();
    const { fetchMock, resolveFetch, fetchStarted } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = changePassword("old-password", "new-password");
    try {
      await fetchStarted;
      await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({
        ok: true,
      });
      resolveFetch(jsonResponse({ token: "rotated-token", user: { id: "user-1" } }));
      await pending;

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3100/api/auth/change-password",
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer session-token" }),
        }),
      );
      expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
        "rakazo.session_token",
        "rotated-token",
      );
      expect(resumeLiveNotifications).not.toHaveBeenCalled();
    } finally {
      await resetApiBase();
    }
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

  it("does not retain an oversized sign-in response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { token: "must-not-be-read" },
          { headers: { "content-length": String(MAX_MOBILE_AUTH_RESPONSE_BYTES + 1) } },
        ),
      ),
    );

    await expect(signIn("ada@example.com", "correct horse")).rejects.toThrow(
      new Error("Something went wrong. Try again."),
    );
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("maps a sign-up validation dump to field copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            code: "VALIDATION_ERROR",
            message:
              "[body.email] Invalid email address; [body.password] Too small: expected string to have >=1 characters",
          },
          { status: 400 },
        ),
      ),
    );

    await expect(signUp("ada", "", "Ada")).rejects.toThrow(new Error("Enter a valid email"));
  });

  it("says the server is unreachable instead of the native fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          "fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)",
        );
      }),
    );

    await expect(signIn("ada@example.com", "correct horse")).rejects.toThrow(
      new Error("Could not reach the server"),
    );
    await expect(rpc("bots/list")).rejects.toThrow(new Error("Could not reach the server"));
  });

  it("times out and cancels a stalled sign-in response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );

    const pending = signIn("ada@example.com", "correct horse");
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(8_000);

    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("reports an rpc that hit its timeout as a timeout, not as a canceled fetch", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fetch failed: FetchRequestCanceledException")),
            );
          }),
      ),
    );

    const pending = rpc("computer/status", { botId: "bot" });
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
  });

  it("reports a stalled rpc response body as a timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );

    const pending = rpc("computer/status", { botId: "bot" });
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports a caller's cancellation with the caller's reason", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fetch failed: FetchRequestCanceledException")),
            );
          }),
      ),
    );

    const external = new AbortController();
    const pending = rpc("computer/status", { botId: "bot" }, { signal: external.signal });
    const rejection = expect(pending).rejects.toThrow("screen closed");
    await vi.advanceTimersByTimeAsync(0);
    external.abort(new Error("screen closed"));
    await rejection;
  });

  it("lets a call opt into a longer timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => resolve(new Response(JSON.stringify({ json: { ok: true } }))), 20_000);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = rpc("computer/boot", { botId: "bot" }, { timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("publishes only reachability transitions and preserves transport causes", async () => {
    const changed = vi.fn();
    const unsubscribe = subscribeServerReachable(changed);
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Network request failed"))
        .mockResolvedValueOnce(rpcErrorResponse(404, "NOT_FOUND", "Bot does not exist")),
    );
    try {
      expect(isServerUnreachable(await rpc("bots/list").catch((error) => error))).toBe(true);
      expect(isServerReachable()).toBe(false);
      await expect(rpc("bots/get", { botId: "bot-1" })).rejects.toThrow("Bot does not exist");
      expect(isServerReachable()).toBe(true);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("counts an rpc timeout as unreachable and a reopened live connection as reachable again", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fetch failed: FetchRequestCanceledException")),
            );
          }),
      ),
    );
    const pending = rpc("threads/get", { botId: "bot" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(isServerUnreachable(await pending)).toBe(true);
    expect(isServerReachable()).toBe(false);

    const reachableAgain = vi.fn();
    const unsubscribe = subscribeServerReachable(reachableAgain);
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new ReadableStream({ start: (c) => c.close() }))),
      );
      await subscribeThread({ botId: "bot" }, -1, vi.fn(), new AbortController().signal);
      expect(isServerReachable()).toBe(true);
      expect(reachableAgain).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
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

  it("sends sign-out with a JSON body so the server ends the session", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ json: null }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await signOut();

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(init.body).toBe("{}");
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

  it("clears the local session when the sign-out request stalls", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ json: null }))
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    const pending = signOut();
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.space_id");
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
      .mockResolvedValueOnce(rpcErrorResponse(404, "NOT_FOUND", "Bot does not exist"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("bots/get", { botId: "bot-1" })).resolves.toEqual({
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

  it("shows the server's message instead of the procedure name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcErrorResponse(400, "BAD_REQUEST", "Connect a model to start a run.")),
    );

    await expect(rpc("bots/create", { name: "Ada" })).rejects.toThrow(
      new Error("Connect a model to start a run."),
    );
  });

  it.each([
    ["an empty", new Response(null, { status: 404 })],
    [
      "an HTML",
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    ],
  ])("reports a failure with %s body without a parser error", async (_body, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(rpc("bots/create", { name: "Ada" })).rejects.toThrow(
      new Error("Something went wrong. Try again."),
    );
  });

  it("sends model headers unchanged and reads names-only credential DTOs", async () => {
    const credential: MobileModelCredential = {
      id: "credential",
      provider: "openai-compatible",
      label: "Local",
      hasKey: false,
      isDefault: true,
      headerNames: ["x-session"],
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ json: credential }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "custom",
      headers: { "x-session": "fake-session-secret" },
    };
    expect(await rpc("models/connect", input)).toEqual(credential);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ json: input });
    fetchMock.mockResolvedValueOnce(jsonResponse({ json: [credential] }));
    const listed = await rpc("models/credentials");
    expect(listed[0]?.headerNames).toEqual(["x-session"]);
    expect(JSON.stringify(listed)).not.toContain("fake-session-secret");
    await rpc("models/connect", { ...input, headers: undefined });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).json).not.toHaveProperty(
      "headers",
    );
    await rpc("models/connect", { ...input, headers: {} });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).json.headers).toEqual({});
    await rpc("models/probeOpenAiCompatible", {
      baseUrl: input.baseUrl,
      headers: input.headers,
      credentialId: credential.id,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)).json).toEqual({
      baseUrl: input.baseUrl,
      headers: input.headers,
      credentialId: credential.id,
    });
  });

  it("keeps the Space when a non-401 failure mentions unauthorized", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await selectSpace("space-support");
    const fetchMock = vi.fn(async () =>
      rpcErrorResponse(400, "BAD_REQUEST", "Model server returned 401 Unauthorized"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      rpc("models/probeOpenAiCompatible", { baseUrl: "https://models.example.test" }),
    ).rejects.toThrow("Model server returned 401 Unauthorized");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(selectedSpaceId()).toBe("space-support");
    expect(store.get("rakazo.space_id")).toBe("space-support");
  });

  it("blocks mobile message and attachment submission when AI sharing is declined", async () => {
    vi.mocked(promptAiConsent).mockResolvedValue(false);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        json: {
          scope: "account-space",
          version: "2026-09-14",
          recipients: [
            { key: "provider", name: "Example AI", use: "model", detail: "", allowed: false },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    for (const proc of ["threads/send", "artifacts/create", "routines/create"] as const) {
      const body = { botId: "bot-1", text: "private content" } as RpcInput<typeof proc>;
      await expect(rpc(proc, body)).rejects.toThrow("AI data sharing");
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain("/rpc/aiConsent/status");
      expect(init?.body).not.toContain("private content");
    }
  });

  it.each([true, false])("explains the mobile upgrade requirement with JSON=%s", async (json) => {
    const fetchMock = vi.fn(async () =>
      json
        ? rpcErrorResponse(404, "NOT_FOUND", "Not found")
        : new Response("404 Not Found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(rpc("threads/send", { botId: "bot" })).rejects.toThrow("Update your server");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["throws", "rejects", "stalls"])(
    "reports the upgrade message when body cancellation %s",
    async (mode) => {
      const cancel = vi.fn(() => {
        if (mode === "throws") throw new Error("cancel failed");
        if (mode === "rejects") return Promise.reject(new Error("cancel failed"));
        return new Promise<void>(() => {});
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ status: 404, body: { cancel } })),
      );
      await expect(rpc("threads/send", { botId: "bot" })).rejects.toThrow("Update your server");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("records mobile consent before submitting and uses the deployment policy URL", async () => {
    vi.mocked(promptAiConsent).mockResolvedValue(true);
    const calls: string[] = [];
    const recipient = {
      key: "provider",
      name: "Example AI",
      use: "model",
      detail: "",
      allowed: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        return jsonResponse({
          json: path.endsWith("/status")
            ? {
                scope: "account-space",
                version: "2026-09-14",
                recipients: [recipient],
                privacyUrl: "https://example.com/privacy",
              }
            : { ok: true },
        });
      }),
    );
    await rpc("threads/send", { botId: "bot-1", text: "authorized content" });
    expect(calls).toEqual(["/rpc/aiConsent/status", "/rpc/aiConsent/allow", "/rpc/threads/send"]);
    expect(promptAiConsent).toHaveBeenLastCalledWith(recipient, "https://example.com/privacy");
  });

  it("coalesces concurrent mobile consent checks before sending each request once", async () => {
    vi.mocked(promptAiConsent).mockClear();
    vi.mocked(promptAiConsent).mockResolvedValue(true);
    const calls: string[] = [];
    const recipient = {
      key: "provider",
      name: "Example AI",
      use: "model",
      detail: "",
      allowed: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        if (path.endsWith("/status"))
          return jsonResponse({
            json: {
              scope: "account-space",
              version: "2026-09-14",
              recipients: [recipient],
            },
          });
        return jsonResponse({ json: { ok: true } });
      }),
    );

    await Promise.all([
      rpc("threads/send", { botId: "bot-1", text: "first" }),
      rpc("threads/send", { botId: "bot-1", text: "second" }),
    ]);

    expect(promptAiConsent).toHaveBeenCalledTimes(1);
    expect(calls.filter((path) => path.endsWith("/aiConsent/status"))).toHaveLength(2);
    expect(calls.filter((path) => path.endsWith("/aiConsent/allow"))).toHaveLength(1);
    expect(calls.filter((path) => path.endsWith("/threads/send"))).toHaveLength(2);
  });

  it("coalesces a concurrent refusal without granting or replaying the action", async () => {
    vi.mocked(promptAiConsent).mockClear();
    vi.mocked(promptAiConsent).mockResolvedValue(false);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        return jsonResponse({
          json: {
            scope: "account-space",
            version: "2026-09-14",
            recipients: [
              {
                key: "provider",
                name: "Example AI",
                use: "model",
                detail: "",
                allowed: false,
              },
            ],
          },
        });
      }),
    );

    const results = await Promise.allSettled([
      rpc("threads/send", { botId: "bot-1", text: "keep this draft" }),
      rpc("threads/send", { botId: "bot-1", text: "keep this draft" }),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(promptAiConsent).toHaveBeenCalledTimes(1);
    expect(calls.filter((path) => path.endsWith("/aiConsent/allow"))).toHaveLength(0);
    expect(calls.filter((path) => path.endsWith("/threads/send"))).toHaveLength(0);
  });

  it("rejects an oversized RPC response before parsing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { json: { ok: true } },
          { headers: { "content-length": String(MAX_MOBILE_RPC_RESPONSE_BYTES + 1) } },
        ),
      ),
    );

    await expect(rpc("bots/get", { botId: "bot-1" })).rejects.toThrow(
      new Error("Something went wrong. Try again."),
    );
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
      "Could not save your sign-in on this device. Try again.",
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

  it("recovers a deleted-space fallback over a stale saved selection after restart", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    // Stale deleted id is cleared even while the replacement write stays locked.
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("clears a deleted selection when every SecureStore write fails after delete", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.has("rakazo.space_rollback")).toBe(false);

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    // Cleared selection lets startup fall through to the server default.
    expect(restartedApi.selectedSpaceId()).toBeNull();
    await expect(restartedApi.selectInitialSpace("space-personal")).resolves.toBe(true);
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("drops a stale deleted selection when rollback recovery cannot rewrite SPACE_KEY", async () => {
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
      ],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();

    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );
  });

  it("recovers after restart when SecureStore could neither write nor clear after delete", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-deleted");

    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-deleted");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(restartedApi.rpc("spaces/list")).resolves.toEqual({ spaces: [] });
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-deleted");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
  });

  it("does not let a stale rollback override a saved deleted-space fallback", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      // clearStoredValue falls back to writing ""; keep that failing for rollback
      // so only an overwrite of the rollback payload can neutralize it.
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    // Neutralization overwrote the stale rollback; best-effort clear may leave
    // the matching recovery payload when delete/empty writes stay locked.
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-personal" }),
    );

    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("does not write SPACE_KEY beside a stale rollback when neutralization fails", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      // Block recoverSpaceRollback during loadApiBase, and block SPACE_KEY clears.
      // Writes of the new fallback id would succeed — the bug was doing that write
      // before neutralization, then failing to undo it.
      if (key === "rakazo.space_id" && (value === "" || value === "space-old")) {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-personal");
    // Must not leave the new selection durable beside the stale rollback.
    expect(storage.get("rakazo.space_id")).toBe("space-deleted");
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-old" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    // Restart may still recover the old rollback target, but must not have
    // replaced a newer SPACE_KEY fallback with it.
    expect(restartedApi.selectedSpaceId()).toBe("space-old");
    expect(storage.get("rakazo.space_id")).toBe("space-old");
  });

  it("keeps the Space selection when unauthorized is a session failure", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "expired-token";
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-support");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("spaces/list")).rejects.toThrow("Unauthorized");
    expect(selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-support");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
  });

  it("keeps a Space selected during unauthorized recovery when the retry succeeds", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    let resolveRetry!: (value: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = rpc("spaces/list");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(selectSpace("space-new")).resolves.toBe(true);
    resolveRetry(jsonResponse({ json: { spaces: [] } }));

    await expect(pending).resolves.toEqual({ spaces: [] });
    expect(selectedSpaceId()).toBe("space-new");
    expect(storage.get("rakazo.space_id")).toBe("space-new");
  });

  it("keeps a Space selected during unauthorized recovery when the retry fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    let resolveRetry!: (value: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = rpc("spaces/list");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(selectSpace("space-new")).resolves.toBe(true);
    resolveRetry(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));

    await expect(pending).rejects.toThrow("Unauthorized");
    expect(selectedSpaceId()).toBe("space-new");
    expect(storage.get("rakazo.space_id")).toBe("space-new");
  });

  it("ignores a 401 from a request sent before the user switched Spaces", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-a"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-a");

    let resolveStale!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveStale = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stale = rpc("bots/list");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-a");
    await expect(selectSpace("space-b")).resolves.toBe(true);
    resolveStale(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));

    // The stale request fails without probing or touching the new selection;
    // Space B's own requests run recovery if B is itself inaccessible.
    await expect(stale).rejects.toThrow("Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
  });

  it("ignores a stale 401 after switching away and back to the same Space", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-a"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-a");

    let resolveStale!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveStale = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stale = rpc("bots/list");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-a");
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    resolveStale(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));

    // ID-only matching would treat this obsolete Space A response as current
    // after A → B → A; the selection epoch must keep recovery from clearing
    // the newer Space A selection.
    await expect(stale).rejects.toThrow("Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
  });

  it("clears a session the server rejects and reports it once", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "revoked-token"]]);
    mockSecureStore(store);
    await loadApiBase();
    const rejected = vi.fn();
    const unsubscribe = subscribeSessionRejected(rejected);
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      // Home polls several reads at once; every one of them comes back 401.
      await Promise.all([
        expect(rpc("me")).rejects.toThrow("Unauthorized"),
        expect(rpc("bots/list")).rejects.toThrow("Unauthorized"),
      ]);
      expect(rejected).toHaveBeenCalledOnce();
      expect(store.has("rakazo.session_token")).toBe(false);
      expect(
        vi
          .mocked(SecureStore.deleteItemAsync)
          .mock.calls.filter(([key]) => key === "rakazo.session_token"),
      ).toHaveLength(1);

      // Later requests carry no session and cannot reject it again.
      await expect(rpc("me")).rejects.toThrow("Unauthorized");
      expect(fetchMock.mock.calls[2]![1].headers.authorization).toBeUndefined();
      expect(rejected).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("checks Space access before treating a 401 as a rejected session", async () => {
    const store = new Map<string, string>([
      ["rakazo.session_token", "session-token"],
      ["rakazo.space_id", "space-removed"],
    ]);
    mockSecureStore(store);
    await loadApiBase();
    const rejected = vi.fn();
    const unsubscribe = subscribeSessionRejected(rejected);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(rpc("spaces/list")).resolves.toEqual({ spaces: [] });
      expect(rejected).not.toHaveBeenCalled();
      expect(store.get("rakazo.session_token")).toBe("session-token");
      expect(selectedSpaceId()).toBeNull();

      // When the probe without a Space is refused too, the session itself is
      // gone. The selection is left alone until sign-in resets it.
      await selectSpace("space-support");
      fetchMock
        .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
        .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));
      await expect(rpc("bots/list")).rejects.toThrow("Unauthorized");
      expect(fetchMock.mock.calls[3]![1].headers["x-rakazo-space-id"]).toBeUndefined();
      expect(rejected).toHaveBeenCalledOnce();
      expect(store.has("rakazo.session_token")).toBe(false);
      expect(selectedSpaceId()).toBe("space-support");
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ["a network error", () => Promise.reject(new TypeError("Network request failed"))],
    ["a server error", async () => rpcErrorResponse(503, "INTERNAL_SERVER_ERROR", "Unavailable")],
    ["a forbidden request", async () => rpcErrorResponse(403, "FORBIDDEN", "Forbidden")],
    [
      "a non-401 failure that mentions unauthorized",
      async () => rpcErrorResponse(400, "BAD_REQUEST", "Model server returned 401 Unauthorized"),
    ],
  ])("keeps the session after %s", async (_failure, respond) => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    await loadApiBase();
    const rejected = vi.fn();
    const unsubscribe = subscribeSessionRejected(rejected);
    vi.stubGlobal("fetch", vi.fn(respond));

    try {
      await expect(rpc("bots/list")).rejects.toThrow();
      expect(rejected).not.toHaveBeenCalled();
      expect(store.get("rakazo.session_token")).toBe("session-token");
    } finally {
      unsubscribe();
    }
  });

  it("keeps the session a password change on this device is replacing", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    await loadApiBase();
    const rejected = vi.fn();
    const unsubscribe = subscribeSessionRejected(rejected);
    let resolveChange!: (response: Response) => void;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/auth/change-password")) {
        return new Promise<Response>((resolve) => {
          resolveChange = resolve;
        });
      }
      return rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized");
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const pending = changePassword("old-password", "new-password");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      // The server already revoked the old token; a poll lands before the new one arrives.
      await expect(rpc("bots/list")).rejects.toThrow("Unauthorized");
      resolveChange(jsonResponse({ token: "rotated-token", user: { id: "user-1" } }));
      await pending;

      expect(rejected).not.toHaveBeenCalled();
      expect(store.get("rakazo.session_token")).toBe("rotated-token");
    } finally {
      unsubscribe();
    }
  });

  it("keeps a newer session when a request from the old one is refused", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "old-token"]]);
    mockSecureStore(store);
    await loadApiBase();
    const rejected = vi.fn();
    const unsubscribe = subscribeSessionRejected(rejected);
    const { fetchMock, fetchStarted, resolveFetch } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const stale = rpc("bots/list");
      await fetchStarted;
      await saveSessionToken("new-token");
      resolveFetch(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));

      await expect(stale).rejects.toThrow("Unauthorized");
      expect(rejected).not.toHaveBeenCalled();
      expect(store.get("rakazo.session_token")).toBe("new-token");
    } finally {
      unsubscribe();
    }
  });

  it("heals durable divergence when persisting a new Space fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    await expect(selectSpace("space-support")).resolves.toBe(true);
    // A concurrent recovery persisted the claimed id, then the selection
    // write below fails and rolls the claim back.
    storage.set("rakazo.space_id", "space-new");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-new") {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });

    await expect(selectSpace("space-new")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
  });

  it("keeps a newer overlapping selection when an older persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let rejectA!: (reason: Error) => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        await new Promise<never>((_, reject) => {
          rejectA = reject;
        });
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    rejectA(new Error("device locked"));

    await expect(pendingA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
  });

  it("does not commit a selection superseded during rollback cleanup", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-current"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let releaseOlderCleanup!: () => void;
    let heldOlderCleanup = false;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback" && !heldOlderCleanup) {
        heldOlderCleanup = true;
        await new Promise<void>((resolve) => {
          releaseOlderCleanup = resolve;
        });
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-current");

    const previousSeq = spaceSelectionSeq();
    const pendingOlder = selectSpace("space-older");
    expect(spaceSelectionSeq()).toBe(previousSeq + 1);
    expect(selectedSpaceId()).toBe("space-current");
    await vi.waitFor(() => expect(heldOlderCleanup).toBe(true));
    await expect(selectSpace("space-newer")).resolves.toBe(true);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");

    releaseOlderCleanup();
    await expect(pendingOlder).resolves.toBe(false);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");
  });

  it("converges durable state to the latest overlapping selection", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let resolveA!: () => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        await new Promise<void>((resolve) => {
          resolveA = resolve;
        });
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    // The older write lands stale after the newer one completed.
    resolveA();

    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledTimes(1);
    expect(resumeLiveNotifications).toHaveBeenLastCalledWith(
      currentApiBase(),
      expect.anything(),
      "space-b",
    );
  });

  it("does not restore the first selection after switching away and back", async () => {
    const storage = new Map<string, string>([["rakazo.session_token", "fake-token"]]);
    let releaseFirstA!: () => void;
    let firstA = true;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a" && firstA) {
        firstA = false;
        await new Promise<void>((resolve) => {
          releaseFirstA = resolve;
        });
      }
      storage.set(key, value);
    });
    await loadApiBase();
    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(firstA).toBe(false));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    releaseFirstA();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    expect(resumeLiveNotifications).toHaveBeenCalledTimes(2);
    expect(resumeLiveNotifications).toHaveBeenLastCalledWith(
      currentApiBase(),
      "fake-token",
      "space-a",
    );
  });

  it("does not restore an obsolete selection after its token read finishes", async () => {
    const storage = new Map<string, string>([["rakazo.session_token", "fake-token"]]);
    let releaseToken!: () => void;
    let tokenReadHeld = false;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token" && !tokenReadHeld) {
        tokenReadHeld = true;
        await new Promise<void>((resolve) => {
          releaseToken = resolve;
        });
      }
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(tokenReadHeld).toBe(true));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    releaseToken();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-b");
  });

  it("restores notifications for the previous selection when a newer persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.session_token", "fake-token"]]);
    let releaseA!: () => void;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
      }
      if (key === "rakazo.space_id" && value === "space-b") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();
    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    // Let rollback's recovery write complete without waiting on the older write.
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-b") throw new Error("device locked");
      storage.set(key, value);
    });
    await expect(selectSpace("space-b")).resolves.toBe(false);
    releaseA();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-a");
  });

  it("keeps a later A claim when an earlier A→B→A persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let firstAWriteCount = 0;
    let rejectFirstA!: (reason: Error) => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        firstAWriteCount += 1;
        if (firstAWriteCount === 1) {
          await new Promise<never>((_, reject) => {
            rejectFirstA = reject;
          });
        }
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingFirstA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    rejectFirstA(new Error("device locked"));

    await expect(pendingFirstA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
  });

  it("does not let auth cleanup overwrite a newer selection with a stale snapshot", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let injected = false;
    let holdCleanupReconcile = false;
    let releaseCleanupWrite!: () => void;
    const cleanupWriteHeld = new Promise<void>((resolve) => {
      releaseCleanupWrite = resolve;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id" && !injected) {
        injected = true;
        // Finish selecting B before cleanup snapshots it for reconcile.
        await expect(selectSpace("space-b")).resolves.toBe(true);
        holdCleanupReconcile = true;
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-b" && holdCleanupReconcile) {
        holdCleanupReconcile = false;
        // Hold only the post-clear reconcile write of the B snapshot.
        await cleanupWriteHeld;
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const pendingRpc = rpc("spaces/list");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-b"));
    await expect(selectSpace("space-c")).resolves.toBe(true);
    expect(storage.get("rakazo.space_id")).toBe("space-c");
    releaseCleanupWrite();

    await expect(pendingRpc).resolves.toEqual({ spaces: [] });
    expect(selectedSpaceId()).toBe("space-c");
    expect(storage.get("rakazo.space_id")).toBe("space-c");
  });

  it("re-persists a Space selected while recovery cleanup is in flight", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let injected = false;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id" && !injected) {
        injected = true;
        await expect(selectSpace("space-new")).resolves.toBe(true);
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("spaces/list")).resolves.toEqual({ spaces: [] });
    expect(injected).toBe(true);
    expect(selectedSpaceId()).toBe("space-new");
    expect(storage.get("rakazo.space_id")).toBe("space-new");
  });

  it("does not retry a mutating RPC against the default Space after Space auth failure", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("bots/create", { name: "Wrong space bot" })).rejects.toThrow("Unauthorized");
    expect(selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/rpc/bots/create");
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-deleted");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/rpc/spaces/list");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
  });

  it("keeps the Space selection when a mutating RPC unauthorized is a session failure", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") return "expired-token";
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("bots/create", { name: "Should not land" })).rejects.toThrow("Unauthorized");
    expect(selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/rpc/bots/create");
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-support");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/rpc/spaces/list");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
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
    expect(stream.locked).toBe(false);
  });

  it("rejects an oversized partial SSE frame and cancels the remaining response", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MOBILE_RPC_RESPONSE_BYTES + 1).fill(97));
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.progress","seq":8}}\n\n'));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const onEvent = vi.fn();

    await expect(
      subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal),
    ).rejects.toThrow(RangeError);
    expect(cancelled).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it.each(["single chunk", "fragmented delimiter"])(
    "accepts an exactly-at-cap SSE frame with a %s",
    async (framing) => {
      const frame = paddedThreadFrame(MAX_MOBILE_RPC_RESPONSE_BYTES, 4);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (framing === "single chunk") {
            controller.enqueue(frame);
          } else {
            controller.enqueue(frame.subarray(0, frame.byteLength - 1));
            controller.enqueue(frame.subarray(frame.byteLength - 1));
          }
          controller.close();
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream)),
      );
      const onEvent = vi.fn();

      await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

      expect(onEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "thread.progress", seq: 4 }),
      );
      expect(stream.locked).toBe(false);
    },
  );

  it.each(["single chunk", "fragmented delimiter"])(
    "counts UTF-8 and delimiter bytes when rejecting an oversized frame with a %s",
    async (framing) => {
      const encoder = new TextEncoder();
      const frame = paddedThreadFrame(MAX_MOBILE_RPC_RESPONSE_BYTES + 1, 4);
      frame.set(encoder.encode("é"), 1);
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (framing === "single chunk") {
            controller.enqueue(frame);
          } else {
            controller.enqueue(frame.subarray(0, frame.byteLength - 1));
            controller.enqueue(frame.subarray(frame.byteLength - 1));
          }
          controller.enqueue(
            encoder.encode('data: {"json":{"type":"thread.progress","seq":5}}\n\n'),
          );
          controller.close();
        },
        cancel,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream)),
      );
      const onEvent = vi.fn();

      await expect(
        subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal),
      ).rejects.toThrow(RangeError);

      expect(onEvent).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    },
  );

  it("accepts multiple valid frames in a chunk larger than the per-frame cap", async () => {
    const first = paddedThreadFrame(MAX_MOBILE_RPC_RESPONSE_BYTES / 2 + 1, 4);
    const second = paddedThreadFrame(MAX_MOBILE_RPC_RESPONSE_BYTES / 2 + 1, 5);
    const chunk = new Uint8Array(first.byteLength + second.byteLength);
    chunk.set(first);
    chunk.set(second, first.byteLength);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent.mock.calls.map(([event]) => event.seq)).toEqual([4, 5]);
    expect(stream.locked).toBe(false);
  });

  it("reassembles split UTF-8 characters and a split LF delimiter", async () => {
    const encoder = new TextEncoder();
    const frame = encoder.encode(
      'data: {"json":{"type":"thread.progress","seq":4,"payload":{"delta":"🌿 café"}}}\n\n',
    );
    const splitCharacter = frame.indexOf(0xf0) + 2;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame.subarray(0, splitCharacter));
        controller.enqueue(frame.subarray(splitCharacter, frame.byteLength - 1));
        controller.enqueue(frame.subarray(frame.byteLength - 1));
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.progress","seq":5}}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ seq: 4, payload: { delta: "🌿 café" } }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ seq: 5 }));
    expect(stream.locked).toBe(false);
  });

  it("discards complete JSON without an LF-LF terminator at EOF", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.progress","seq":4}}'));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("keeps consuming frames after a callback throws", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"json":{"type":"thread.progress","seq":4}}\n\n' +
              'data: {"json":{"type":"thread.progress","seq":5}}\n\n',
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn().mockImplementationOnce(() => {
      throw new Error("callback failed");
    });

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent.mock.calls.map(([event]) => event.seq)).toEqual([4, 5]);
    expect(stream.locked).toBe(false);
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

  it("cancels unsuccessful HTTP bodies without replacing the status error", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 503 })),
    );

    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (503)");

    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("ignores heartbeat frames so the caller's cursor never skips an event", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"json":{"type":"heartbeat","seq":0,"payload":{}}}\n\n' +
              ": keepalive\n\n" +
              'data: {"json":{"type":"thread.progress","seq":1,"payload":{}}}\n\n',
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "thread.progress", seq: 1 }),
    );
  });

  it("gives up on a silent stream after the idle timeout so the caller reconnects", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const onEvent = vi.fn();
    const abort = new AbortController();

    const running = subscribeThread({ botId: "bot-1" }, -1, onEvent, abort.signal);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await running;

    expect(settled).toBe(true);
    expect(cancelled).toBe(true);
    expect(abort.signal.aborted).toBe(false);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("unblocks an aborted read without waiting for idle or stalled cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");
    const running = subscribeThread({ botId: "bot-1" }, -1, onEvent, abort.signal);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.locked).toBe(true);

    abort.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    await running;
    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cancels an already-aborted custom response without delivering queued events", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"json":{"type":"thread.progress","seq":4}}\n\n'),
        );
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const onEvent = vi.fn();
    const abort = new AbortController();
    abort.abort();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, abort.signal);

    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("releases an errored reader and clears its timer and abort listener", async () => {
    vi.useFakeTimers();
    const failure = new Error("read failed");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");

    await expect(subscribeThread({ botId: "bot-1" }, -1, vi.fn(), abort.signal)).rejects.toBe(
      failure,
    );

    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
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

describe("discarded mobile thread refresh cursor", () => {
  const onScreen = {
    ...snapshot([mobileMessage("shown", [{ kind: "text", text: "shown" }], 2)]),
    cursor: 2,
  };
  const fetched = {
    ...snapshot([
      mobileMessage("shown", [{ kind: "text", text: "shown" }], 2),
      mobileMessage("missed", [{ kind: "text", text: "from the discarded snapshot" }], 4),
      mobileMessage("also-missed", [{ kind: "text", text: "also only in that snapshot" }], 5),
    ]),
    cursor: 5,
  };
  const gate = {
    fetched,
    onScreen,
    requestEpoch: 1,
    currentEpoch: 1,
    requestGeneration: 1,
    currentGeneration: 1,
    targetBotId: "bot-1",
    targetGroupId: undefined,
    activeBotId: "bot-1",
    activeGroupId: undefined,
  };

  // The server replays events with seq greater than the subscription cursor.
  function shownAfter(cursor: number) {
    const events = [
      {
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "missed",
          role: "bot",
          blocks: [{ kind: "text", text: "from the discarded snapshot" }],
        },
      },
      {
        type: "thread.message.created",
        seq: 5,
        payload: {
          messageId: "also-missed",
          role: "bot",
          blocks: [{ kind: "text", text: "also only in that snapshot" }],
        },
      },
    ];
    return events.reduce<MobileSnapshot>(
      (view, event) => (event.seq > cursor ? (applyMobileThreadEvent(view, event) ?? view) : view),
      onScreen,
    );
  }

  it("shows events only a discarded refresh had seen when a newer refresh fails", () => {
    for (const discard of [{ currentGeneration: 2 }, { currentEpoch: 2 }]) {
      const result = mobileThreadRefreshResult({ ...gate, ...discard });
      const shown = shownAfter(result.snapshot?.cursor ?? -1);
      expect(result.commit).toBe(false);
      expect(shown.messages.map((message) => message.id)).toEqual([
        "shown",
        "missed",
        "also-missed",
      ]);
    }
  });

  it("keeps a live message applied while a refresh snapshot was in flight", () => {
    const live = applyMobileThreadEvent(fetched, {
      type: "thread.message.created",
      seq: 6,
      payload: {
        messageId: "new-live-message",
        role: "user",
        blocks: [{ kind: "text", text: "New message" }],
      },
    })!;
    const result = mobileThreadRefreshResult({ ...gate, onScreen: live });
    expect(result.commit).toBe(false);
    expect(result.snapshot).toBe(live);
    expect(result.snapshot?.messages.at(-1)?.id).toBe("new-live-message");
    expect(result.snapshot?.cursor).toBe(6);
    expect(mobileThreadRefreshResult({ ...gate, onScreen: fetched }).commit).toBe(true);
  });

  it("starts the subscription at a snapshot the refresh committed", () => {
    const result = mobileThreadRefreshResult(gate);
    expect(result.commit).toBe(true);
    expect(result.snapshot?.cursor).toBe(fetched.cursor);
  });
});

describe("mobile thread event reduction", () => {
  it("appends an emoji reply with its exact target", () => {
    const initial = snapshot([mobileMessage("message-1", [{ kind: "text", text: "Done" }])]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.created",
      seq: 4,
      payload: {
        messageId: "reaction-1",
        role: "user",
        blocks: [{ kind: "text", text: "❤️" }],
        replyToMessageId: "message-1",
      },
    });

    expect(next?.messages.find((message) => message.id === "reaction-1")).toMatchObject({
      role: "user",
      blocks: [{ kind: "text", text: "❤️" }],
      replyToMessageId: "message-1",
    });
    expect(next?.cursor).toBe(4);
  });

  it("appends a quoted reply carrying its excerpt", () => {
    const initial = snapshot([mobileMessage("message-1", [{ kind: "text", text: "Done" }])]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.created",
      seq: 4,
      createdAt: "2026-10-08T12:00:00.000Z",
      payload: {
        messageId: "reply-1",
        role: "user",
        blocks: [{ kind: "text", text: "why this?" }],
        replyToMessageId: "message-1",
        replyQuote: "Done",
        replyPreview: { role: "user", text: "Done" },
      },
    });

    expect(next?.messages.find((message) => message.id === "reply-1")).toMatchObject({
      role: "user",
      replyToMessageId: "message-1",
      replyQuote: "Done",
      replyPreview: { role: "user", text: "Done" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });

    const updated = applyMobileThreadEvent(next, {
      type: "thread.message.updated",
      seq: 5,
      payload: { messageId: "reply-1", role: "user", blocks: [{ kind: "text", text: "Updated" }] },
    });
    expect(updated?.messages.find((message) => message.id === "reply-1")).toMatchObject({
      replyToMessageId: "message-1",
      replyQuote: "Done",
      replyPreview: { role: "user", text: "Done" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });
  });

  it("keeps a message in its call when an update leaves the call id out", () => {
    const spoken: MobileMessage = {
      ...mobileMessage("message-1", [{ kind: "text", text: "Hi" }]),
      callId: "call-1",
    };
    const initial = snapshot([spoken]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.updated",
      seq: 5,
      payload: {
        messageId: "message-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Hi. Talk soon." }],
      },
    });

    expect(next?.messages.find((message) => message.id === "message-1")).toMatchObject({
      callId: "call-1",
    });
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

  it("shows peer-started group work without hiding a waiting member", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      groupId: "group-1",
      run: { id: "waiting-run", botId: "bot-1", status: "waiting_input" },
      activeRuns: [{ id: "waiting-run", botId: "bot-1", status: "waiting_input" }],
      members: [
        { botId: "bot-1", name: "Writer", color: "blue", status: "waiting_input" },
        { botId: "bot-2", name: "Researcher", color: "green", status: "idle" },
      ],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.started",
      seq: 9,
      runId: "peer-run",
      botId: "bot-2",
      payload: { trigger: "user_message" },
    });

    expect(next?.cursor).toBe(9);
    expect(next?.run).toEqual({ id: "peer-run", botId: "bot-2", status: "running", error: null });
    expect(next?.activeRuns).toEqual([
      { id: "waiting-run", botId: "bot-1", status: "waiting_input" },
      { id: "peer-run", botId: "bot-2", status: "running", error: null },
    ]);
    expect(next?.members?.map((member) => member.status)).toEqual(["waiting_input", "running"]);
  });

  it("consumes background run starts without changing visible work or members", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      groupId: "group-1",
      run: { id: "waiting-run", botId: "bot-1", status: "waiting_input" },
      activeRuns: [{ id: "waiting-run", botId: "bot-1", status: "waiting_input" }],
      members: [{ botId: "bot-1", name: "Writer", color: "blue", status: "waiting_input" }],
    };
    const event = {
      type: "run.started",
      seq: 9,
      runId: "ticket-run",
      botId: "bot-1",
      payload: { trigger: "tickets" },
    };

    const next = applyMobileThreadEvent(initial, event);

    expect(next?.cursor).toBe(9);
    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toBe(initial.activeRuns);
    expect(next?.members).toBe(initial.members);
    expect(next?.messages).toBe(initial.messages);
    expect(applyMobileThreadEvent(next, event)).toBe(next);
  });

  it("updates only the matching member and cursor when a start omits its run ID", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      groupId: "group-1",
      run: { id: "waiting-run", botId: "bot-1", status: "waiting_takeover" },
      activeRuns: [{ id: "waiting-run", botId: "bot-1", status: "waiting_takeover" }],
      members: [
        { botId: "bot-1", name: "Writer", color: "blue", status: "waiting_takeover" },
        { botId: "bot-2", name: "Researcher", color: "green", status: "idle" },
      ],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.started",
      seq: 9,
      botId: "bot-2",
    });

    expect(next).toEqual({
      ...initial,
      cursor: 9,
      members: [
        initial.members![0],
        { botId: "bot-2", name: "Researcher", color: "green", status: "running" },
      ],
    });
    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toBe(initial.activeRuns);
    expect(next?.members?.[0]).toBe(initial.members?.[0]);
    expect(applyMobileThreadEvent(next, { type: "run.started", seq: 9, botId: "bot-2" })).toBe(
      next,
    );
  });

  it("does not invent members for a start with an unknown bot or run ID", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      groupId: "group-1",
      members: [{ botId: "bot-1", name: "Writer", color: "blue", status: "idle" }],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.started",
      seq: 9,
      botId: "unknown-bot",
    });

    expect(next).toEqual({ ...initial, cursor: 9 });
    expect(next?.members).toBe(initial.members);
    expect(applyMobileThreadEvent(initial, { type: "run.started" })).toBe(initial);
  });

  it("does not infer a started run's bot from the snapshot", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      members: [{ botId: "bot-1", name: "Writer", color: "blue", status: "idle" }],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.started",
      runId: "unattributed-run",
    });

    expect(next?.cursor).toBe(3);
    expect(next?.run).toEqual({ id: "unattributed-run", status: "running", error: null });
    expect(next?.activeRuns).toEqual([{ id: "unattributed-run", status: "running", error: null }]);
    expect(next?.members).toBe(initial.members);
  });

  it("deduplicates a restarted run and retains every other active lifecycle state", () => {
    const retained = [
      { id: "queued-run", status: "queued" },
      { id: "leased-run", status: "leased" },
      { id: "running-run", status: "running" },
      { id: "ask-run", status: "waiting_input" },
      { id: "takeover-run", status: "waiting_takeover" },
    ];
    const initial: MobileSnapshot = {
      ...snapshot(),
      run: retained[3]!,
      activeRuns: [
        ...retained,
        { id: "resumed-run", botId: "bot-2", status: "waiting_input" },
        { id: "resumed-run", botId: "bot-2", status: "running" },
        { id: "completed-run", status: "completed" },
        { id: "failed-run", status: "failed" },
        { id: "cancelled-run", status: "cancelled" },
      ],
    };
    const event = { type: "run.started", seq: 9, runId: "resumed-run", botId: "bot-2" };

    const next = applyMobileThreadEvent(initial, event);
    const replayed = applyMobileThreadEvent(next, event);

    expect(next?.run).toEqual({
      id: "resumed-run",
      botId: "bot-2",
      status: "running",
      error: null,
    });
    expect(next?.activeRuns).toEqual([
      ...retained,
      { id: "resumed-run", botId: "bot-2", status: "running", error: null },
    ]);
    expect(replayed?.activeRuns).toEqual(next?.activeRuns);
  });

  it("retains a waiting primary run when the snapshot omits activeRuns", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      run: { id: "waiting-run", botId: "bot-1", status: "waiting_takeover" },
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.started",
      runId: "peer-run",
      botId: "bot-2",
    });

    expect(next?.activeRuns).toEqual([
      { id: "waiting-run", botId: "bot-1", status: "waiting_takeover" },
      { id: "peer-run", botId: "bot-2", status: "running", error: null },
    ]);
    expect(next?.run).toEqual({ id: "peer-run", botId: "bot-2", status: "running", error: null });
  });

  it("retains an unrelated group failure until that failed run starts again", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      groupId: "group-1",
      run: { id: "failed-run", botId: "bot-1", status: "failed", error: "Provider unavailable" },
      activeRuns: [{ id: "waiting-run", botId: "bot-2", status: "waiting_input" }],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.started",
      seq: 9,
      runId: "peer-run",
      botId: "bot-3",
    });

    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toEqual([
      { id: "waiting-run", botId: "bot-2", status: "waiting_input" },
      { id: "peer-run", botId: "bot-3", status: "running", error: null },
    ]);
    const restarted = applyMobileThreadEvent(next, {
      type: "run.started",
      seq: 10,
      runId: "failed-run",
      botId: "bot-1",
    });
    expect(restarted?.cursor).toBe(10);
    expect(restarted?.run).toEqual({
      id: "failed-run",
      botId: "bot-1",
      status: "running",
      error: null,
    });
    expect(restarted?.activeRuns).toEqual([
      { id: "waiting-run", botId: "bot-2", status: "waiting_input" },
      { id: "peer-run", botId: "bot-3", status: "running", error: null },
      { id: "failed-run", botId: "bot-1", status: "running", error: null },
    ]);
  });

  it("replaces an unrelated failure when a direct thread starts work", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      run: { id: "failed-run", status: "failed", error: "Provider unavailable" },
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.started",
      seq: 9,
      runId: "new-run",
      botId: "bot-1",
    });

    expect(next?.run).toEqual({ id: "new-run", botId: "bot-1", status: "running", error: null });
    expect(next?.activeRuns).toEqual([
      { id: "new-run", botId: "bot-1", status: "running", error: null },
    ]);
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

  it("keeps hidden token progress so re-enabling streaming stays continuous", () => {
    const afterTokens = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      seq: 4,
      runId: "run-1",
      payload: { text: "Lis", streaming: true },
    });
    const afterDelta = applyMobileThreadEvent(afterTokens, {
      type: "thread.progress",
      seq: 5,
      runId: "run-1",
      payload: { delta: "bon", streaming: true },
    });

    expect(afterDelta?.cursor).toBe(5);
    expect(afterDelta?.messages).toEqual([
      {
        id: "progress:run-1",
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "progress", text: "Lisbon" }],
      },
    ]);
    expect(withLiveStreamingProgress(afterDelta, false)?.messages).toEqual([]);

    const afterComplete = applyMobileThreadEvent(afterDelta, {
      type: "thread.message.created",
      seq: 6,
      runId: "run-1",
      payload: {
        messageId: "m-final",
        role: "bot",
        blocks: [{ kind: "text", text: "Lisbon" }],
      },
    });
    expect(afterComplete?.messages).toEqual([
      expect.objectContaining({
        id: "m-final",
        blocks: [{ kind: "text", text: "Lisbon" }],
      }),
    ]);
  });

  it("resumes from retained tokens after streaming is turned back on mid-reply", () => {
    const afterPrefix = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      seq: 4,
      runId: "run-1",
      payload: { text: "Lis", streaming: true },
    });
    expect(withLiveStreamingProgress(afterPrefix, false)?.messages).toEqual([]);

    const afterResume = applyMobileThreadEvent(afterPrefix, {
      type: "thread.progress",
      seq: 5,
      runId: "run-1",
      payload: { delta: "bon", streaming: true },
    });
    expect(withLiveStreamingProgress(afterResume, true)?.messages).toEqual([
      {
        id: "progress:run-1",
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "progress", text: "Lisbon" }],
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
            transport: "SMS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alex",
            text: "Hello from the group",
          },
        ]),
      ),
    ).toBe("Alex (SMS): Hello from the group");
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
    ).toBe("Alex (Slack): Hello from the group");
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

  it("applies the waiting-input owner only to its run", () => {
    const type = "run.waiting_input";
    const status = "waiting_input";
    const initial: MobileSnapshot = {
      ...snapshot(),
      run: { id: "run-1", status: "running", userId: "old-owner" },
      activeRuns: [
        { id: "run-1", status: "running", userId: "old-owner" },
        { id: "run-2", status: "running", userId: "other-owner" },
      ],
    };
    const waiting = applyMobileThreadEvent(initial, {
      type,
      runId: "run-1",
      payload: { userId: "owner-1" },
    });

    expect(waiting?.run).toEqual({ id: "run-1", status, userId: "owner-1" });
    expect(waiting?.activeRuns).toEqual([
      { id: "run-1", status, userId: "owner-1" },
      { id: "run-2", status: "running", userId: "other-owner" },
    ]);

    const corrected = applyMobileThreadEvent(waiting, {
      type,
      runId: "run-1",
      payload: { userId: "owner-2" },
    });
    expect(corrected?.run?.userId).toBe("owner-2");
    expect(corrected?.activeRuns?.[0]?.userId).toBe("owner-2");

    const repeated = applyMobileThreadEvent(corrected, {
      type,
      runId: "run-1",
      payload: { userId: "owner-2" },
    });
    expect(repeated).toBe(corrected);

    const legacy = applyMobileThreadEvent(corrected, { type, runId: "run-1" });
    expect(legacy?.run?.userId).toBe("owner-2");
    expect(legacy?.activeRuns?.[0]?.userId).toBe("owner-2");
  });

  it("records the owner of an inserted waiting group run without changing another run", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      groupId: "group-1",
      run: { id: "run-1", status: "waiting_input", userId: "owner-1" },
      activeRuns: [{ id: "run-1", status: "waiting_input", userId: "owner-1" }],
    };
    const waiting = applyMobileThreadEvent(initial, {
      type: "run.waiting_input",
      runId: "run-2",
      botId: "bot-2",
      payload: { userId: "owner-2" },
    });

    expect(waiting?.run).toEqual(initial.run);
    expect(waiting?.activeRuns).toEqual([
      initial.run,
      { id: "run-2", botId: "bot-2", status: "waiting_input", userId: "owner-2" },
    ]);
    const withoutRunId = applyMobileThreadEvent(waiting, {
      type: "run.waiting_input",
      payload: { userId: "unknown-owner" },
    });
    expect(withoutRunId?.run).toEqual(waiting?.run);
    expect(withoutRunId?.activeRuns).toEqual(waiting?.activeRuns);
  });

  it("hydrates a late owner on an already-waiting group run", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      groupId: "group-1",
      run: { id: "run-newer", status: "running", userId: "other-owner" },
      activeRuns: [
        { id: "run-newer", status: "running", userId: "other-owner" },
        { id: "run-waiting", status: "waiting_input" },
      ],
    };
    const next = applyMobileThreadEvent(initial, {
      type: "run.waiting_input",
      runId: "run-waiting",
      payload: { userId: "owner" },
    });
    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toEqual([
      initial.run,
      { id: "run-waiting", status: "waiting_input", userId: "owner" },
    ]);
  });

  it("does not infer an owner from a legacy waiting event or takeover payload", () => {
    const legacy = applyMobileThreadEvent(snapshot(), {
      type: "run.waiting_input",
      runId: "run-1",
    });
    expect(legacy?.run).toEqual({ id: "run-1", status: "waiting_input" });
    const takeover = applyMobileThreadEvent(snapshot(), {
      type: "computer.takeover.requested",
      runId: "run-2",
      payload: { userId: "owner" },
    });
    expect(takeover?.run).toEqual({ id: "run-2", status: "waiting_takeover" });
  });

  it.each([undefined, "group-1"])(
    "allows only the owner to dismiss a live secret ask in %s",
    (groupId) => {
      const ask = {
        ...mobileMessage("ask-1", [
          { kind: "ask", text: "Secret", input: "secret", status: "pending" },
        ]),
        runId: "run-1",
      };
      const initial: MobileSnapshot = {
        ...snapshot([ask]),
        groupId,
        run: { id: "run-1", status: "running" },
        activeRuns: [{ id: "run-1", status: "running" }],
      };
      const waiting = applyMobileThreadEvent(initial, {
        type: "run.waiting_input",
        runId: "run-1",
        payload: { userId: "owner" },
      });

      expect(dismissableAskMessageIds(waiting, "owner")).toEqual(new Set(["ask-1"]));
      expect(dismissableAskMessageIds(waiting, "other")).toEqual(new Set());
      expect(
        dismissableAskMessageIds(
          applyMobileThreadEvent(initial, { type: "run.waiting_input", runId: "run-1" }),
          "owner",
        ),
      ).toEqual(new Set());
    },
  );

  it("applies computer takeover requests as waiting_takeover", () => {
    const progress = mobileMessage("progress:run-1", [{ kind: "progress", text: "working…" }], 1);
    const initial: MobileSnapshot = {
      ...snapshot([progress]),
      run: { id: "run-1", status: "running" },
      activeRuns: [{ id: "run-1", status: "running" }],
    };
    const waiting = applyMobileThreadEvent(initial, {
      type: "computer.takeover.requested",
      runId: "run-1",
      seq: 10,
    });

    expect(waiting?.run?.status).toBe("waiting_takeover");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_takeover");
    expect(waiting?.messages.some((message) => message.id.startsWith("progress:"))).toBe(false);
    expect(waiting?.cursor).toBe(10);

    const released = applyMobileThreadEvent(
      {
        ...initial,
        run: { id: "run-1", status: "waiting_takeover" },
        activeRuns: [
          { id: "run-1", status: "waiting_takeover" },
          { id: "run-2", status: "waiting_takeover" },
        ],
      },
      {
        type: "computer.takeover.released",
        runId: "run-1",
        seq: 11,
      },
    );
    expect(released?.run?.status).toBe("queued");
    expect(released?.activeRuns).toEqual([
      { id: "run-1", status: "queued" },
      { id: "run-2", status: "waiting_takeover" },
    ]);
    expect(released?.cursor).toBe(11);

    const running = applyMobileThreadEvent(
      {
        ...snapshot(),
        run: { id: "run-1", status: "running" },
        activeRuns: [{ id: "run-1", status: "running" }],
      },
      { type: "computer.takeover.released", runId: "run-1", seq: 12 },
    );
    expect(running?.run?.status).toBe("running");
    expect(running?.activeRuns?.[0]?.status).toBe("running");
  });

  it("lets a newer refresh replace waiting_takeover with queued", () => {
    const waiting: MobileSnapshot = {
      ...snapshot(),
      cursor: 10,
      run: { id: "run-1", status: "waiting_takeover" },
      activeRuns: [{ id: "run-1", status: "waiting_takeover" }],
    };
    const refreshed: MobileSnapshot = {
      ...snapshot(),
      cursor: 12,
      run: { id: "run-1", status: "queued" },
      activeRuns: [{ id: "run-1", status: "queued" }],
    };

    const next = mergeMobileSnapshot(waiting, refreshed);

    expect(next.cursor).toBe(12);
    expect(next.run?.status).toBe("queued");
    expect(next.activeRuns?.[0]?.status).toBe("queued");
  });

  it("inserts a peer takeover run that was absent from the open snapshot", () => {
    const progress = mobileMessage(
      "progress:run-peer",
      [{ kind: "progress", text: "working…" }],
      1,
    );
    const initial: MobileSnapshot = {
      ...snapshot([progress]),
      run: { id: "run-user", status: "running" },
      activeRuns: [{ id: "run-user", status: "running" }],
      computer: {
        state: "running",
        controlHolder: "bot",
        screenAvailable: true,
        mode: "team",
        busyBotName: "Peer",
      },
    };

    const waiting = applyMobileThreadEvent(initial, {
      type: "computer.takeover.requested",
      runId: "run-peer",
      botId: "bot-peer",
      seq: 12,
    });

    expect(waiting?.run).toEqual({ id: "run-peer", botId: "bot-peer", status: "waiting_takeover" });
    expect(waiting?.activeRuns).toEqual([
      { id: "run-user", status: "running" },
      { id: "run-peer", botId: "bot-peer", status: "waiting_takeover" },
    ]);
    expect(waiting?.messages.some((message) => message.id.startsWith("progress:"))).toBe(false);
    expect(waiting?.computer?.busyBotName).toBeNull();
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

  it("updates a cloud agent card from thread.cloud_agent", () => {
    const initial = snapshot([
      mobileMessage("msg-ca", [
        {
          kind: "cloud_agent",
          agentId: "ca-1",
          title: "Add README",
          status: "running",
          url: "https://example.test/agents/ca-1",
        },
      ]),
    ]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.cloud_agent",
      seq: 9,
      payload: {
        messageId: "msg-ca",
        agentId: "ca-1",
        title: "Add README",
        status: "finished",
        url: "https://example.test/agents/ca-1",
        branch: "cursor/add-readme",
        prUrl: "https://github.com/example/repo/pull/1",
      },
    });

    expect(next?.cursor).toBe(9);
    expect(next?.messages[0]?.blocks[0]).toEqual({
      kind: "cloud_agent",
      agentId: "ca-1",
      title: "Add README",
      status: "finished",
      url: "https://example.test/agents/ca-1",
      branch: "cursor/add-readme",
      prUrl: "https://github.com/example/repo/pull/1",
    });
  });

  it("starts an idle run from live events and selects the active safety cadence", () => {
    const initial: MobileSnapshot = { ...snapshot(), run: null, activeRuns: [] };
    expect(threadRefreshDelayMs(initial.run?.status, { liveSubscribed: true })).toBe(60_000);
    const started = applyMobileThreadEvent(initial, {
      type: "run.started",
      runId: "run-remote",
      botId: "bot-1",
      seq: 12,
      payload: { trigger: "routine" },
    });
    expect(started?.cursor).toBe(12);
    expect(started?.run).toEqual({
      id: "run-remote",
      botId: "bot-1",
      status: "running",
      error: null,
    });
    expect(started?.activeRuns).toEqual([started?.run]);
    expect(threadRefreshDelayMs(started?.run?.status, { liveSubscribed: true })).toBe(30_000);
    const finished = applyMobileThreadEvent(started, {
      type: "run.completed",
      runId: "run-remote",
      seq: 13,
    });
    expect(finished?.run).toBeNull();
    expect(finished?.activeRuns).toEqual([]);
  });

  it("resumes a waiting run without duplicating it or dropping other paused runs", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      run: { id: "run-1", status: "waiting_input" },
      activeRuns: [
        { id: "run-1", status: "waiting_input" },
        { id: "run-2", status: "waiting_takeover" },
        { id: "run-old", status: "completed" },
      ],
    };
    const next = applyMobileThreadEvent(initial, { type: "run.started", runId: "run-1" });
    expect(next?.run?.status).toBe("running");
    expect(next?.activeRuns).toEqual([
      { id: "run-2", status: "waiting_takeover" },
      { id: "run-1", status: "running", error: null },
    ]);
  });

  it("ignores background run starts and preserves group failures on member starts", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      groupId: "group-1",
      run: { id: "run-failed", status: "failed", error: "Failed" },
      activeRuns: [],
    };
    expect(
      applyMobileThreadEvent(initial, {
        type: "run.started",
        runId: "run-background",
        payload: { trigger: "tickets" },
      }),
    ).toBe(initial);
    const next = applyMobileThreadEvent(initial, { type: "run.started", runId: "run-new" });
    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toEqual([{ id: "run-new", status: "running", error: null }]);
  });

  it("leaves the snapshot unchanged for unrelated events", () => {
    const initial = snapshot();
    expect(applyMobileThreadEvent(initial, { type: "thread.unrecognized" })).toBe(initial);
    expect(applyMobileThreadEvent(initial, { type: "run.checkpointed" })).toBe(initial);
    expect(applyMobileThreadEvent(null, { type: "thread.progress" })).toBeNull();
  });
});

function mockSecureStore(store: Map<string, string>) {
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    store.delete(key);
  });
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
}

function deferredFetch() {
  let resolveFetch: (response: Response) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolveResponse) => {
        resolveFetch = resolveResponse;
        markStarted();
      }),
  );
  return {
    fetchMock,
    fetchStarted,
    resolveFetch: (response: Response) => resolveFetch(response),
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A failed procedure as the oRPC server sends it. */
function rpcErrorResponse(status: number, code: string, message: string) {
  return jsonResponse({ json: { defined: false, code, status, message } }, { status });
}

function paddedThreadFrame(bytes: number, seq: number) {
  const suffix = new TextEncoder().encode(
    `\ndata: ${JSON.stringify({ json: { type: "thread.progress", seq } })}\n\n`,
  );
  const frame = new Uint8Array(bytes).fill(120);
  frame[0] = 58;
  frame.set(suffix, bytes - suffix.byteLength);
  return frame;
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

describe("mobile clipboard text", () => {
  it("copies message content with transport labels and omits card chrome", async () => {
    const { copyableMobileMessageText } = await import("./api");
    expect(
      copyableMobileMessageText({
        id: "message",
        role: "bot",
        blocks: [
          { kind: "text", text: "Hello" },
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "SMS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Sender",
            text: "Reply",
          },
          { kind: "card", lines: [] },
        ],
      }),
    ).toBe("Hello\nSender (SMS): Reply");
  });

  it("keeps leading whitespace for selection while copying trims it", async () => {
    const { copyableMobileMessageText, selectableMobileMessageText } = await import("./api");
    const message: MobileMessage = {
      id: "message",
      role: "user",
      blocks: [{ kind: "text", text: "    indented\nnext  " }],
    };
    expect(selectableMobileMessageText(message)).toBe("    indented\nnext  ");
    expect(copyableMobileMessageText(message)).toBe("indented\nnext");
  });
});

it("sends the deletion-code request with a JSON body", async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ status: true }));
  vi.stubGlobal("fetch", fetchMock);

  await requestAccountDeletionCode();

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://127.0.0.1:3100/api/auth/request-account-deletion");
  expect(init.headers).toMatchObject({ "content-type": "application/json" });
  expect(init.body).toBe("{}");
});

it("localizes non-JSON successful account-security responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<html>Gateway error</html>")),
  );
  await expect(fetchAccountSecurity()).rejects.toThrow("Could not load sign-in options");
});

it("keeps the thread id on live messages so inline cards can act on them", () => {
  const view = applyMobileThreadEvent(
    { threadId: "chat", messages: [], olderCursor: null, run: null } as MobileSnapshot,
    {
      type: "thread.message.created",
      seq: 1,
      payload: { messageId: "card", role: "bot", blocks: [] },
    } as never,
  );
  expect(view?.messages[0]?.threadId).toBe("chat");
});

describe("stale helper projection", () => {
  it.each([
    "run.waiting_input",
    "computer.takeover.requested",
    "run.completed",
    "run.failed",
    "run.cancelled",
  ])("settles helpers on %s without reviving them on resume", (type) => {
    const base = {
      id: "fixture",
      threadId: "thread-1",
      runId: "run-1",
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const helper = { agentId: "helper", name: "Helper", task: "Check", status: "running" };
    let next = applyMobileThreadEvent(snapshot(), {
      ...base,
      type: "thread.subagent",
      payload: helper,
    });
    next = applyMobileThreadEvent(next, { ...base, seq: 2, type, payload: {} });
    expect(next?.messages.find((m) => m.id === "subagent:helper")?.blocks[0]).toMatchObject({
      status: "failed",
      result: "stopped",
    });
    next = applyMobileThreadEvent(next, { ...base, seq: 3, type: "run.started", payload: {} });
    next = applyMobileThreadEvent(next, {
      ...base,
      seq: 4,
      type: "thread.subagent",
      payload: { ...helper, agentId: "resumed" },
    });
    expect(next?.messages.find((m) => m.id === "subagent:helper")?.blocks[0]).toMatchObject({
      status: "failed",
    });
    expect(next?.messages.find((m) => m.id === "subagent:resumed")?.blocks[0]).toMatchObject({
      status: "running",
    });
  });
});
