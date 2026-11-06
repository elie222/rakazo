import { getArtifactById } from "./artifacts";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import type { RpcInput } from "@rakazo/contracts";
import { isServerUnreachable, mergeThreadSnapshot, reduceThreadSnapshot } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptAiConsent } from "./ai-consent";
import type { MobileMessage, MobileModelCredential, MobileSnapshot } from "./api.js";
import {
  adoptDeletedSpaceFallback,
  authHeaders,
  blockText,
  captureApiRequestContext,
  changePassword,
  clearSpace,
  configureSessionEndHangUp,
  currentApiBase,
  deleteAccount,
  fetchAccountSecurity,
  flushPendingSignOut,
  IDLE_TIMEOUT_MS,
  isServerReachable,
  loadApiBase,
  MAX_MOBILE_AUTH_RESPONSE_BYTES,
  MAX_MOBILE_RPC_RESPONSE_BYTES,
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
  subscribeIncomingCallEvents,
  subscribeServerReachable,
  subscribeSessionRejected,
  subscribeThread,
  updateAccountName,
} from "./api.js";
import { artifactCacheSession } from "./artifact-cache-session";
import { resumeLiveNotifications, stopLiveNotifications } from "./live-notifications.js";
import { threadRefreshDelayMs } from "./refresh";
import {
  clearSessionToken,
  currentSessionGeneration,
  loadSessionToken,
  replaceSessionTokenIfCurrent,
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
      // A sign-in that reports failure leaves no session in use.
      expect((await authHeaders()).authorization).toBeUndefined();
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
        vi.fn(async () => new Response(body, { status })),
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
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          "accept-language": "en",
        },
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
      passwordChanging: () => false,
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
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          "accept-language": "en",
        },
        body: JSON.stringify({
          email: "new@example.com",
          password: "correct horse",
          name: "New User",
        }),
      }),
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "signup-token");
  });

  describe.each([
    ["sign-in", () => signIn("ada@example.test", "correct horse")],
    ["sign-up", () => signUp("ada@example.test", "correct horse", "Ada")],
    ["sign-in code", () => signInWithCode("ada@example.test", "123456")],
  ])("a %s that finishes after a server change", (_name, authenticate) => {
    it.each([
      ["https://second.example.test", () => saveApiBase("https://second.example.test")],
      ["http://127.0.0.1:3100", () => resetApiBase()],
    ])(
      "is dropped and signed out on the first server when switching to %s",
      async (next, change) => {
        const storage = new Map<string, string>();
        vi.mocked(SecureStore.getItemAsync).mockImplementation(
          async (key) => storage.get(key) ?? null,
        );
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          storage.set(key, value);
        });
        vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
          storage.delete(key);
        });
        await saveApiBase("https://first.example.test", { "x-gateway": "fake-gateway-key" });
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
          if (input.startsWith("https://first.example.test/api/auth/sign-")) {
            await held;
            return jsonResponse({ token: "fake-session-first" });
          }
          if (input.endsWith("/api/auth/sign-out")) return jsonResponse({ success: true });
          return jsonResponse({ json: { id: "user" } });
        });
        vi.stubGlobal("fetch", fetchMock);

        const pending = authenticate();
        const rejection = expect(pending).rejects.toThrow("Could not continue");
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        await expect(change()).resolves.toMatchObject({ ok: true });
        expect(currentApiBase()).toBe(next);
        release();
        await rejection;

        expect(await loadSessionToken()).toBe("");
        expect(storage.get("rakazo.session_token") ?? "").toBe("");
        await vi.waitFor(() =>
          expect(fetchMock).toHaveBeenCalledWith(
            "https://first.example.test/api/auth/sign-out",
            expect.objectContaining({
              credentials: "omit",
              headers: expect.objectContaining({
                authorization: "Bearer fake-session-first",
                "x-gateway": "fake-gateway-key",
              }),
            }),
          ),
        );
        const [, authInit] = fetchMock.mock.calls[0] ?? [];
        expect(authInit?.credentials).toBe("omit");

        fetchMock.mockClear();
        await rpc("me").catch(() => undefined);
        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(url).toMatch(new RegExp(`^${next.replaceAll(".", "\\.")}/`));
        expect(new Headers(init?.headers).get("authorization")).toBeNull();

        await resetApiBase();
      },
    );
  });

  it("drops a sign-in whose session changes while its token is being written", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing!: () => void;
    const started = new Promise<void>((resolve) => {
      writing = resolve;
    });
    // A store that keeps what it accepts: the dropped sign-in's revocation is delivered from it.
    const storage = new Map<string, string>();
    mockSecureStore(storage);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") {
        writing();
        await held;
      }
      storage.set(key, value);
    });
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) =>
      input.endsWith("/api/auth/sign-out")
        ? jsonResponse({ success: true })
        : jsonResponse({ token: "fake-session-late" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = signIn("ada@example.test", "correct horse");
    const rejection = expect(pending).rejects.toThrow("Could not continue");
    await started;
    const clearing = clearSessionToken();
    release();
    await clearing;
    await rejection;

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/auth\/sign-out$/),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer fake-session-late" }),
        }),
      ),
    );
  });

  it("keeps a dropped sign-in's revocation pending until its server answers", async () => {
    const storage = new Map<string, string>();
    mockSecureStore(storage);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstServerUp = false;
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input.startsWith("http://127.0.0.1:3100/api/auth/sign-in/")) {
        await held;
        return jsonResponse({ token: "fake-session-first" });
      }
      if (input.startsWith("http://127.0.0.1:3100/") && !firstServerUp)
        throw new TypeError("Network request failed");
      return jsonResponse({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = signIn("ada@example.test", "correct horse");
    const rejection = expect(pending).rejects.toThrow("Could not continue");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(saveApiBase("https://second.example.test")).resolves.toMatchObject({ ok: true });
    release();
    await rejection;

    // The first server cannot be reached, so the revocation stays recorded for it.
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === "http://127.0.0.1:3100/api/auth/sign-out"),
      ).toBe(true),
    );
    expect(pendingSignOutRecords(storage)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "fake-session-first" },
    ]);

    firstServerUp = true;
    await flushPendingSignOut(true);
    expect(pendingSignOutRecords(storage)).toEqual([]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:3100/api/auth/sign-out",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({ authorization: "Bearer fake-session-first" }),
      }),
    );
    await resetApiBase();
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
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          "accept-language": "en",
        },
        body: JSON.stringify({ email: "ada@example.test", type: "sign-in" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3100/api/auth/sign-in/email-otp",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          "accept-language": "en",
        },
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
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "rakazo.session_token" ? "fake-session" : null,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ status: true }))
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
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/api/auth/delete-user");
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body)).toEqual({ password: "new-password" });
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

  it("keeps the same account's unsent messages and their cache namespace across a password change", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    const clear = vi.fn();
    configureUnsentSends({
      request: vi.fn(),
      serverReachable: () => true,
      passwordChanging: () => false,
      scope: () => null,
      disk: { clear, save: vi.fn() } as unknown as UnsentDisk,
      errorText: String,
      notDelivered: vi.fn(),
    });
    const namespace = await artifactCacheSession("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: "rotated-token", user: { id: "user-1" } })),
    );

    await changePassword("old-password", "new-password");

    expect(clear).not.toHaveBeenCalled();
    expect(await artifactCacheSession("rotated-token")).toBe(namespace);
    // A restart reads the new token and the namespace that names the queue.
    expect(store.get("rakazo.session_token")).toBe("rotated-token");
    expect(JSON.parse(store.get("rakazo.artifact-cache-session") ?? "null")).toEqual({
      token: "rotated-token",
      namespace,
      previous: "session-token",
    });
  });

  it("finishes a pending session save before it submits another password change", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    const namespace = await artifactCacheSession("session-token");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      jsonResponse({
        token:
          JSON.parse(String(init.body)).newPassword === "new-password" ? "rotated-1" : "rotated-2",
        user: { id: "user-1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const keychainFails = () =>
      vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async () => {
        throw new Error("keychain unavailable");
      });
    keychainFails();
    await expect(changePassword("old-password", "new-password")).rejects.toThrow(
      "keychain unavailable",
    );
    expect(store.get("rakazo.session_token")).toBe("session-token");

    // While the earlier session cannot be saved, nothing new is submitted.
    keychainFails();
    await expect(changePassword("new-password", "newer-password")).rejects.toThrow(
      "keychain unavailable",
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    await changePassword("new-password", "newer-password");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retry] = fetchMock.mock.calls[1]!;
    expect(new Headers(retry.headers).get("authorization")).toBe("Bearer rotated-1");
    expect(JSON.parse(String(retry.body))).toMatchObject({
      currentPassword: "new-password",
      newPassword: "newer-password",
    });
    expect(store.get("rakazo.session_token")).toBe("rotated-2");
    expect(JSON.parse(store.get("rakazo.artifact-cache-session") ?? "null")).toEqual({
      token: "rotated-2",
      namespace,
      previous: "rotated-1",
    });
  });

  it("completes a resubmitted password change after its session save failed, without resending it", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    // The server accepted the first change, so the old password no longer matches.
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1
        ? jsonResponse({ token: "rotated-token", user: { id: "user-1" } })
        : jsonResponse({ message: "Invalid password" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async () => {
      throw new Error("keychain unavailable");
    });
    await expect(changePassword("old-password", "new-password")).rejects.toThrow(
      "keychain unavailable",
    );

    await changePassword("old-password", "new-password");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.get("rakazo.session_token")).toBe("rotated-token");
    // A different submission is still sent.
    await expect(changePassword("new-password", "newer-password")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rotates the cache namespace from the token the password change was sent with", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    const namespace = await artifactCacheSession("session-token");
    let sessionReads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      // One transient keychain failure while the password change starts.
      if (key === "rakazo.session_token" && ++sessionReads === 1)
        throw new Error("keychain unavailable");
      return store.get(key) ?? null;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        new Headers(init.headers).get("authorization") === "Bearer session-token"
          ? jsonResponse({ token: "rotated-token", user: { id: "user-1" } })
          : jsonResponse({ message: "Unauthorized" }, { status: 401 }),
      ),
    );

    await changePassword("old-password", "new-password").catch(() => undefined);
    // Whether or not that change went through, the saved session still names the queue.
    expect(await artifactCacheSession(store.get("rakazo.session_token") ?? "")).toBe(namespace);

    await changePassword("old-password", "new-password");
    expect(store.get("rakazo.session_token")).toBe("rotated-token");
    expect(await artifactCacheSession("rotated-token")).toBe(namespace);
  });

  it.each([
    [
      "an SSO or passkey session",
      () => replaceSessionTokenIfCurrent(currentSessionGeneration(), "fake-other"),
    ],
    ["sign-out", () => signOut()],
    ["a restored session", () => restoreSessionToken("fake-other")],
    ["a server change", () => saveApiBase("https://second-server.example")],
  ])("still deletes unsent messages for %s", async (_change, change) => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({})),
    );
    const clear = vi.fn();
    configureUnsentSends({
      request: vi.fn(),
      serverReachable: () => true,
      passwordChanging: () => false,
      scope: () => null,
      disk: { clear, save: vi.fn() } as unknown as UnsentDisk,
      errorText: String,
      notDelivered: vi.fn(),
    });
    const namespace = await artifactCacheSession("session-token");
    try {
      await change();
      expect(clear).toHaveBeenCalled();
      expect(await artifactCacheSession("fake-other")).not.toBe(namespace);
    } finally {
      await resetApiBase();
    }
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

  it("does not change the password when the session token cannot be read", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("keychain locked"));
    const fetchMock = vi.fn(async () => jsonResponse({ token: "rotated-token" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(changePassword("old-password", "new-password")).rejects.toThrow(
      "Could not change password",
    );

    expect(fetchMock).not.toHaveBeenCalled();
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

  it("reads a slowly delivered Files detail body", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const artifact = { id: "artifact-1", contentBase64: "aGVsbG8=" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        let timer: ReturnType<typeof setTimeout>;
        return new Response(
          new ReadableStream({
            start(controller) {
              timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ json: artifact })));
                controller.close();
              }, 20_000);
            },
            cancel() {
              clearTimeout(timer);
            },
          }),
        );
      }),
    );

    const result = getArtifactById("artifact-1").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toEqual({ value: artifact });
  });

  it("times out and cancels a stalled Files detail body after the download budget", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );

    const pending = getArtifactById("artifact-1");
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
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

  it("signs out locally and keeps the revocation pending when the server cannot be reached", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );

    await expect(signOut()).resolves.toBeUndefined();
    expect(store.has("rakazo.session_token")).toBe(false);
    // The old server keeps the session and the push registration until the revocation lands.
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);
  });

  it("preserves the session for retry when sign-out cannot snapshot it", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    await selectSpace("space-support");
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    vi.mocked(SecureStore.deleteItemAsync).mockClear();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(signOut()).rejects.toThrow("Could not clear the local session");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(store.get("rakazo.session_token")).toBe("session-token");
    expect(store.get("rakazo.space_id")).toBe("space-support");
    expect(pendingSignOutRecords(store)).toEqual([]);
    await expect(authHeaders()).resolves.toMatchObject({ authorization: "Bearer session-token" });

    await signOut();

    // Delivery runs after sign-out returns and still carries the captured bearer.
    await vi.waitFor(() => expect(fetchMock.mock.calls).toHaveLength(1));
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({ authorization: "Bearer session-token" });
    }
    expect(store.has("rakazo.session_token")).toBe(false);
    expect(selectedSpaceId()).toBeNull();
  });

  it("sends sign-out with a JSON body so the server ends the session", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await signOut();

    await vi.waitFor(() => {
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toMatchObject({ "content-type": "application/json" });
      expect(init.body).toBe("{}");
    });
  });

  it("clears the local session when the sign-out request stalls", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    const pending = signOut();
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.space_id");
  });

  it("clears the local session before a silent server answers", async () => {
    vi.useFakeTimers();
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    const fetchMock = vi.fn((_url: string) => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    const pending = signOut();
    // No request timeout has fired yet: this device is already signed out.
    await vi.advanceTimersByTimeAsync(0);
    expect(store.has("rakazo.session_token")).toBe(false);
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);

    // The visible sign-out does not wait for the delivery: it resolves while the
    // request still hangs.
    await pending;
    await vi.advanceTimersByTimeAsync(8_000);

    // The request timed out; the record stays for the next connectivity window.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);
  });

  it.each([200, 503])(
    "does not repeat what a flush during the local clear delivered (sign-out %s)",
    async (status) => {
      const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
      mockSecureStore(store);
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status }));
      vi.stubGlobal("fetch", fetchMock);
      let finishClear!: () => void;
      const clearHeld = new Promise<void>((release) => {
        finishClear = release;
      });
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
        if (key === "rakazo.session_token") await clearHeld;
        store.delete(key);
      });

      const signingOut = signOut();
      // The record is saved while the local clear still waits, and a flush delivers it in that
      // window. After a hard answer the sign-out's own delivery finds no record left to send.
      await vi.waitFor(() => expect(pendingSignOutRecords(store)).toHaveLength(1));
      await flushPendingSignOut(true);
      finishClear();
      await signingOut;

      await vi.waitFor(() =>
        expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
          "http://127.0.0.1:3100/api/auth/sign-out",
          ...(status === 200 ? [] : ["http://127.0.0.1:3100/api/auth/sign-out"]),
        ]),
      );
      expect(pendingSignOutRecords(store)).toEqual(
        status === 200 ? [] : [{ apiBase: "http://127.0.0.1:3100", token: "session-token" }],
      );
    },
  );

  it("joins the earlier sign-out's delivery instead of resending it", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    mockSecureStore(store);
    let releaseFirst!: (response: Response) => void;
    const heldResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>((_url) => {
      calls += 1;
      if (calls === 1) return heldResponse;
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    // Account A signs out; the old server holds its revocation. Account B signs in
    // on the same server and signs out; B's delivery completes while A's is in flight.
    await signOut();
    store.set("rakazo.session_token", "token-b");
    await signOut();
    await vi.waitFor(() =>
      expect(pendingSignOutRecords(store)).toEqual([
        { apiBase: "http://127.0.0.1:3100", token: "token-a" },
      ]),
    );

    const flushing = flushPendingSignOut(true);
    // The pass joins A's held delivery and stays pending; a pass that resends it finishes
    // on its own.
    const raced = await Promise.race([
      flushing.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    expect(raced).toBe("waiting");
    releaseFirst(jsonResponse({}));
    await flushing;

    const bearers = fetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization,
    );
    expect(bearers).toEqual(["Bearer token-a", "Bearer token-b"]);
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("joins a delivery a launch flush already started for the pending record", async () => {
    // An interrupted sign-out left the session active and its revocation pending.
    const store = new Map<string, string>([
      ["rakazo.session_token", "session-token"],
      [
        "rakazo.pending_sign_out",
        JSON.stringify([
          {
            apiBase: "http://127.0.0.1:3100",
            token: "session-token",
            headers: {},
            recordedAt: Date.now(),
          },
        ]),
      ],
    ]);
    mockSecureStore(store);
    let releaseFirst!: (response: Response) => void;
    const heldResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>((_url) => {
      calls += 1;
      if (calls === 1) return heldResponse;
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    // The launch flush starts delivering the pending record; its request is held.
    const flushing = flushPendingSignOut(true);
    await vi.waitFor(() => expect(calls).toBe(1));
    // Signing out again must join that delivery, not replace it with another one.
    await signOut();
    releaseFirst(jsonResponse({}));
    await flushing;

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    // The sign-out re-recorded its revocation; a later pass delivers it once more.
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);
  });

  it("delivers the captured revocation when the record cannot be persisted", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.pending_sign_out") throw new Error("device locked");
      store.set(key, value);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await signOut();

    // The write failed, so the store holds no record to deliver: the captured
    // revocation still reaches the server.
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        "http://127.0.0.1:3100/api/auth/sign-out",
      ]),
    );
    expect(store.has("rakazo.session_token")).toBe(false);
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("does not deliver when the local clear fails and the next pass delivers the record", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key !== "rakazo.session_token") store.delete(key);
      else throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key !== "rakazo.session_token") store.set(key, value);
      else throw new Error("device locked");
    });

    await expect(signOut()).rejects.toThrow("Could not clear the local session");
    expect(fetchMock).not.toHaveBeenCalled();
    // The record stays, and the settled wait lets the next pass deliver it.
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);

    await flushPendingSignOut(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("clears the pending revocation when the server answers", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await signOut();
    expect(pendingSignOutRecords(store).length).toBe(1);
    // Sign-out returns before its delivery finishes; settle it on this offline stub.
    await flushPendingSignOut(true);

    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("delivers a pending revocation on the next answered request", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await signOut();
    await flushPendingSignOut(true);

    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ json: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await rpc("bots/list");
    await flushPendingSignOut(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/rpc/bots/list",
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    const [, revocationInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(revocationInit.headers).toMatchObject({ authorization: "Bearer session-token" });
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("retries a stored revocation on an answered request after the launch could not read it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const record = {
      apiBase: "http://127.0.0.1:3100",
      token: "token-a",
      headers: {},
      recordedAt: Date.now(),
    };
    const store = new Map<string, string>([["rakazo.pending_sign_out", JSON.stringify([record])]]);
    mockSecureStore(store);
    let storeLocked = true;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.pending_sign_out" && storeLocked) throw new Error("device locked");
      return store.get(key) ?? null;
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ json: [] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    // Joins the launch retry, which cannot read the store.
    await restartedApi.flushPendingSignOut(true);
    storeLocked = false;

    vi.setSystemTime(Date.now() + 61_000);
    await restartedApi.rpc("bots/list");
    await vi.waitFor(() => {
      const signOuts = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/auth/sign-out"),
      );
      expect(signOuts).toHaveLength(1);
      const [, init] = signOuts[0] as [string, RequestInit];
      expect(init.headers).toMatchObject({ authorization: "Bearer token-a" });
    });
    expect(pendingSignOutRecords(store)).toEqual([]);
    vi.useRealTimers();
  });

  it("spaces non-forced retries, keeping launch retries immediate", async () => {
    vi.useFakeTimers();
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await signOut();
    await flushPendingSignOut(true);

    // A proxy keeps refusing the old server's revocation, so its record stays.
    const deadServer = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}", { status: 403 }),
    );
    vi.stubGlobal("fetch", deadServer);
    await flushPendingSignOut(true);
    expect(deadServer.mock.calls.length).toBe(1);

    // Answered requests within the spacing window start no new attempt.
    await flushPendingSignOut();
    expect(deadServer.mock.calls.length).toBe(1);

    vi.advanceTimersByTime(61_000);
    await flushPendingSignOut();
    expect(deadServer.mock.calls.length).toBe(2);

    // A launch retry is never spaced out.
    await flushPendingSignOut(true);
    expect(deadServer.mock.calls.length).toBe(3);
    expect(pendingSignOutRecords(store).length).toBe(1);
  });

  it("keeps a revocation for each signed-out server", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await signOut();
    await flushPendingSignOut(true);
    await saveApiBase("https://second-server.example");

    // Signed in on the second server, then offline sign-out there as well.
    store.set("rakazo.session_token", "token-b");
    await signOut();
    await flushPendingSignOut(true);
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "https://second-server.example", token: "token-b" },
      { apiBase: "http://127.0.0.1:3100", token: "token-a" },
    ]);

    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://second-server.example/api/auth/sign-out",
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("does not delete a revocation recorded while another is delivering", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await signOut();
    await flushPendingSignOut(true);

    // The retry of the first record is waiting on the network when a server switch
    // records a second one on the same server; finishing the first must leave it alone.
    const deferred: ((response: Response) => void)[] = [];
    const fetchStarted = new Promise<void>((resolveStarted) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof globalThis.fetch>(() => {
          if (deferred.length > 0) return Promise.resolve(jsonResponse({}));
          return new Promise<Response>((resolve) => {
            resolveStarted();
            deferred.push(resolve);
          });
        }),
      );
    });
    const delivering = flushPendingSignOut(true);
    await fetchStarted;
    store.set("rakazo.session_token", "token-b");
    await saveApiBase("https://second-server.example");
    deferred[0]?.(jsonResponse({}));
    await delivering;

    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "token-b" },
    ]);
    await resetApiBase();
  });

  it("replaces a stored record list this app cannot read", async () => {
    const store = new Map<string, string>([
      ["rakazo.session_token", "session-token"],
      ["rakazo.pending_sign_out", "not a record list"],
    ]);
    mockSecureStore(store);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    await flushPendingSignOut(true);
    expect(fetchMock).not.toHaveBeenCalled();

    await signOut();
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);
  });

  it("retries a revocation recorded while the flush's deciding read waits", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    // The flush's deciding read — the one that may mark the store absent — waits while a
    // sign-out records its revocation; the empty store the read saw first must not silence
    // the retries that answered requests later trigger.
    let pendingListReads = 0;
    const decidingReadStarted = new Promise<void>((resolveStarted) => {
      vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
        if (key !== "rakazo.pending_sign_out") return store.get(key) ?? null;
        const stored = store.get(key) ?? null;
        pendingListReads += 1;
        if (pendingListReads === 2) {
          resolveStarted();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return stored;
      });
    });

    const flushing = flushPendingSignOut(true);
    await decidingReadStarted;
    const signingOut = signOut();
    await signingOut;
    await flushing;

    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut();

    // The sign-out's own background delivery may also reach this mock first.
    expect(fetchMock.mock.calls.slice(-1).map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it.each([200, 401])("retries a same-origin login page with status %s", async (status) => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    const fetchMock = vi.fn(async () => {
      const response = new Response("<html>Sign in</html>", { status });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: "http://127.0.0.1:3100/login" },
      });
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await signOut();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await flushPendingSignOut(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pendingSignOutRecords(store)).toHaveLength(1);
  });

  it.each([200, 401])("accepts a same-origin redirected status %s", async (status) => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const response = new Response("{}", { status });
        Object.defineProperties(response, {
          redirected: { value: true },
          url: { value: `${input}/` },
        });
        return response;
      }),
    );

    await signOut();
    // The delivery runs in the background; a forced flush waits for it.
    await flushPendingSignOut(true);

    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it.each([
    [200, true, ""],
    [401, true, ""],
    [200, true, "https://other-server.example"],
    [401, true, "https://other-server.example"],
    [200, false, "https://other-server.example"],
    [401, false, "https://other-server.example"],
  ])("retains the record for status %s, redirected %s, URL %s", async (status, redirected, url) => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Response("{}", { status });
        Object.defineProperties(response, {
          redirected: { value: redirected },
          url: { value: url },
        });
        return response;
      }),
    );

    await signOut();

    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({})),
    );
    await flushPendingSignOut(true);
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("keeps the pending revocation unless the server reports the session invalid", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await signOut();

    // A proxy can refuse with 403 without the request reaching the server at all.
    for (const status of [500, 429, 403] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status })),
      );
      await flushPendingSignOut(true);
      expect(pendingSignOutRecords(store).length).toBe(1);
    }

    // An invalid session is final: the server has nothing left to revoke.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await flushPendingSignOut(true);
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("drops a pending revocation older than the session lifetime", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const store = new Map<string, string>([
      [
        "rakazo.pending_sign_out",
        JSON.stringify([
          {
            apiBase: "https://old.example",
            token: "expired-token",
            headers: {},
            recordedAt: Date.now() - 31 * dayMs,
          },
          {
            apiBase: "https://old.example",
            token: "fresh-token",
            headers: {},
            recordedAt: Date.now(),
          },
        ]),
      ],
    ]);
    mockSecureStore(store);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await flushPendingSignOut(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://old.example/api/auth/sign-out",
    ]);
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("does not deliver an expired revocation when the prune write fails", async () => {
    const store = new Map<string, string>([
      [
        "rakazo.pending_sign_out",
        JSON.stringify([
          {
            apiBase: "https://old.example",
            token: "expired-token",
            headers: {},
            recordedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
          },
        ]),
      ],
    ]);
    mockSecureStore(store);
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("device locked"));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await flushPendingSignOut(true);
    expect(fetchMock).not.toHaveBeenCalled();

    // The next pass that can write retires it.
    await flushPendingSignOut(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("bounds the stored revocations, dropping the oldest", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    for (let index = 0; index <= 100; index += 1) {
      store.set("rakazo.session_token", `token-${index}`);
      await signOut();
    }

    const records = pendingSignOutRecords(store);
    expect(records.length).toBe(100);
    expect(records.some((record) => record.token === "token-0")).toBe(false);
    expect(records.some((record) => record.token === "token-100")).toBe(true);
  });

  it("sends the revocation to the recorded server with redirect error and its own headers", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    mockSecureStore(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await signOut();
    // The switch has no session, so it records nothing; it only makes the current
    // connection settings belong to another server with its own header.
    await saveApiBase("https://second-server.example", { "x-proxy": "current-secret" });

    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(init.redirect).toBe("error");
      expect(init.headers).not.toHaveProperty("x-proxy");
    }
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("retries a persisted pending revocation on launch against its own server", async () => {
    const store = new Map<string, string>([
      [
        "rakazo.pending_sign_out",
        JSON.stringify([
          {
            apiBase: "https://old.example",
            token: "old-token",
            headers: {},
            recordedAt: Date.now(),
          },
        ]),
      ],
    ]);
    mockSecureStore(store);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await loadApiBase();
    await flushPendingSignOut(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://old.example/api/auth/sign-out",
    ]);
    const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstInit.headers).toMatchObject({ authorization: "Bearer old-token" });
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("resolves a dying server switch's record at launch", async () => {
    const provisional = (token: string) => ({
      apiBase: "http://127.0.0.1:3100",
      token,
      headers: {},
      recordedAt: Date.now(),
      provisional: true,
    });

    // The switch never completed: its session is still the active one, so the record goes.
    const uncompleted = new Map<string, string>([
      ["rakazo.session_token", "token-a"],
      ["rakazo.pending_sign_out", JSON.stringify([provisional("token-a")])],
    ]);
    mockSecureStore(uncompleted);
    const noFetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", noFetch);
    await loadApiBase();
    await flushPendingSignOut(true);
    expect(noFetch.mock.calls).toEqual([]);
    expect(pendingSignOutRecords(uncompleted)).toEqual([]);
    expect(uncompleted.get("rakazo.session_token")).toBe("token-a");

    // The switch committed but died before promoting: the record is promoted and delivered.
    const committed = new Map<string, string>([
      ["rakazo.api_base", "https://second-server.example"],
      ["rakazo.pending_sign_out", JSON.stringify([provisional("token-a")])],
    ]);
    mockSecureStore(committed);
    const deliverFetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", deliverFetch);
    await loadApiBase();
    await flushPendingSignOut(true);
    expect(deliverFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    expect(pendingSignOutRecords(committed)).toEqual([]);
    await resetApiBase();
  });

  it("does not unregister push delivery when deleting the account", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi.fn(async (_url: string | URL | Request) => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await deleteAccount("correct horse");

    // Deleting the user removes the push rows on the server; unregistering first would
    // drop this device's notifications whenever the deletion fails.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/delete-user",
    ]);
  });

  it("keeps push registered when the account deletion fails", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      jsonResponse({ message: "Invalid password" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteAccount("wrong horse")).rejects.toThrow("Invalid password");

    // A wrong password must not leave this device without notifications or incoming
    // calls; the server still knows the registration until the account is gone for real.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/delete-user",
    ]);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith("rakazo.session_token");
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

  it("asks about every mentioned routine's recipients before a combined send", async () => {
    vi.mocked(promptAiConsent).mockClear();
    vi.mocked(promptAiConsent).mockResolvedValue(false);
    // A paused routine on another bot is reported only by a check for that routine.
    const recipient = {
      key: "routine-model",
      name: "Example AI",
      use: "model",
      detail: "",
      allowed: false,
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).json;
      return jsonResponse({
        json: {
          scope: "account-space",
          version: "2026-09-14",
          recipients: query.routineId === "routine-paused" ? [recipient] : [],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      rpc("threads/sendWithRoutines", {
        botId: "bot-1",
        clientNonce: "nonce-1",
        text: "private content",
        routineIds: ["routine-active", "routine-paused"],
      }),
    ).rejects.toThrow("AI data sharing");
    expect(promptAiConsent).toHaveBeenCalledWith(recipient, undefined);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/rpc/aiConsent/status",
      "/rpc/aiConsent/status",
      "/rpc/aiConsent/status",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).json)).toEqual([
      { uses: ["model", "memory"], botId: "bot-1" },
      { uses: ["model", "memory"], routineId: "routine-active" },
      { uses: ["model", "memory"], routineId: "routine-paused" },
    ]);
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

  it("keeps the previous server's revocation pending when switching servers signed in", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    // The old server keeps the session and the push registration after a local switch.
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "http://127.0.0.1:3100", token: "session-token" },
    ]);
    await resetApiBase();
  });

  it("records the switch's revocation before discarding the old session", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    const recorded = vi
      .mocked(SecureStore.setItemAsync)
      .mock.calls.findIndex(([key]) => key === "rakazo.pending_sign_out");
    const discarded = vi
      .mocked(SecureStore.deleteItemAsync)
      .mock.calls.findIndex((call) => call[0] === "rakazo.session_token");
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(discarded).toBeGreaterThanOrEqual(0);
    // A process kill between the two leaves the revocation durable, not neither.
    const recordedOrder = vi.mocked(SecureStore.setItemAsync).mock.invocationCallOrder[
      recorded
    ] as number;
    const discardedOrder = vi.mocked(SecureStore.deleteItemAsync).mock.invocationCallOrder[
      discarded
    ] as number;
    expect(recordedOrder).toBeLessThan(discardedOrder);
    await resetApiBase();
  });

  it("a rolled-back server switch leaves no pending revocation", async () => {
    for (const failure of ["clear", "endpoint"] as const) {
      const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
      mockSecureStore(store);
      if (failure === "clear") {
        vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
          if (key === "rakazo.session_token") throw new Error("device locked");
          store.delete(key);
        });
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.session_token") throw new Error("device locked");
          store.set(key, value);
        });
      } else {
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.api_base") throw new Error("device locked");
          store.set(key, value);
        });
      }

      const saved = saveApiBase("https://second-server.example");
      await expect(saved).resolves.toMatchObject({ ok: false });
      // The switch rolled back, so the session it recorded a revocation for stays in use.
      expect(pendingSignOutRecords(store)).toEqual([]);
    }
  });

  it("aborts a server switch when the revocation cannot be recorded", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await saveApiBase("https://second-server.example");
    store.set("rakazo.session_token", "session-token");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.pending_sign_out") throw new Error("device locked");
      store.set(key, value);
    });

    // Without the record the old server keeps its session forever, so the switch stops.
    await expect(resetApiBase()).resolves.toEqual({
      ok: false,
      error: "Could not save the previous server session",
    });
    expect(store.get("rakazo.session_token")).toBe("session-token");
    expect(store.get("rakazo.api_base")).toBe("https://second-server.example");

    await expect(saveApiBase("https://third-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the previous server session",
    });
    expect(store.get("rakazo.session_token")).toBe("session-token");
    // Restore writable storage so the cleanup switch can record its own revocation.
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      store.set(key, value);
    });
    await resetApiBase();
  });

  it("a flush racing a failing server switch cannot revoke the old session", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    mockSecureStore(store);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") {
        // An answered request retries the record at the moment the switch starts clearing.
        await flushPendingSignOut();
        throw new Error("device locked");
      }
      store.delete(key);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const next =
      currentApiBase() === "https://second-server.example"
        ? "https://third-server.example"
        : "https://second-server.example";

    await expect(saveApiBase(next)).resolves.toMatchObject({ ok: false });

    expect(fetchMock.mock.calls).toEqual([]);
    expect(pendingSignOutRecords(store)).toEqual([]);
    expect(store.get("rakazo.session_token")).toBe("token-a");
  });

  it("delivers a provisional record a failed promotion left behind", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    mockSecureStore(store);
    let pendingWrites = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.pending_sign_out") {
        pendingWrites += 1;
        // The switch's own write lands; the promotion at commit does not.
        if (pendingWrites === 2) throw new Error("device locked");
        store.set(key, value);
        return;
      }
      store.set(key, value);
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });
    const stored = JSON.parse(store.get("rakazo.pending_sign_out") ?? "[]") as {
      provisional?: boolean;
    }[];
    expect(stored.length).toBe(1);
    expect(stored[0]?.provisional).toBe(true);

    // An ordinary flush — not a launch — resolves the leftover record and delivers it.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/auth/sign-out",
    ]);
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("a reconcile suspended mid-read leaves a starting switch's record alone", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "token-a"]]);
    store.set(
      "rakazo.pending_sign_out",
      JSON.stringify([
        {
          apiBase: "http://127.0.0.1:3100",
          token: "token-a",
          headers: {},
          recordedAt: Date.now(),
          provisional: true,
        },
      ]),
    );
    mockSecureStore(store);
    let releaseSessionRead: (() => void) | undefined;
    let sessionReads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") {
        sessionReads += 1;
        if (sessionReads === 1)
          await new Promise<void>((resolve) => {
            releaseSessionRead = resolve;
          });
      }
      return store.get(key) ?? null;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    // The reconcile suspends reading the session; the switch starts while it waits.
    const settling = flushPendingSignOut(true);
    await vi.waitFor(() => expect(sessionReads).toBeGreaterThanOrEqual(1));
    const switching = saveApiBase("https://second-server.example");
    await vi.waitFor(() => expect(sessionReads).toBeGreaterThanOrEqual(2));
    releaseSessionRead?.();
    await settling;
    await expect(switching).resolves.toMatchObject({ ok: false });

    expect(fetchMock.mock.calls).toEqual([]);
    expect(pendingSignOutRecords(store)).toEqual([]);
    expect(store.get("rakazo.session_token")).toBe("token-a");
  });

  it.each(["save", "reset"])(
    "serializes a %s behind an earlier switch rollback",
    async (change) => {
      const store = new Map<string, string>();
      mockSecureStore(store);
      await saveApiBase("https://old-server.example");
      await restoreSessionToken("token-a");
      let failEndpointWrite: (() => void) | undefined;
      let endpointWrites = 0;
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === "rakazo.api_base") {
          endpointWrites += 1;
          if (endpointWrites === 1) {
            await new Promise((_resolve, reject) => {
              failEndpointWrite = () => reject(new Error("device locked"));
            });
          }
        }
        store.set(key, value);
      });
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);

      // This switch clears the old credentials, then parks before committing.
      const first = saveApiBase("https://second-server.example");
      await vi.waitFor(() => expect(failEndpointWrite).toBeTruthy());
      const second =
        change === "save" ? saveApiBase("https://third-server.example") : resetApiBase();
      try {
        // Give the overlapping transaction and reconciliation the same storage window.
        await flushPendingSignOut(true);
        expect(fetchMock.mock.calls).toEqual([]);
      } finally {
        failEndpointWrite?.();
      }
      await expect(first).resolves.toMatchObject({ ok: false });
      await expect(second).resolves.toMatchObject({ ok: true });
      expect(currentApiBase()).toBe(
        change === "save" ? "https://third-server.example" : "http://127.0.0.1:3100",
      );
      expect(store.has("rakazo.session_token")).toBe(false);
      expect(pendingSignOutRecords(store)).toEqual([
        { apiBase: "https://old-server.example", token: "token-a" },
      ]);
      await resetApiBase();
    },
  );

  it.each(["save", "reset"])(
    "a %s rollback preserves a newer explicit sign-out record",
    async (change) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const store = new Map<string, string>();
      mockSecureStore(store);
      if (change === "reset") await saveApiBase("https://old-server.example");
      const apiBase = currentApiBase();
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      let releaseRollback!: () => void;
      const rollbackStarted = new Promise<void>((resolve) => {
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.space_rollback" && value) {
            resolve();
            await new Promise<void>((release) => {
              releaseRollback = release;
            });
            throw new Error("device locked");
          }
          store.set(key, value);
        });
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("offline");
        }),
      );

      const switching =
        change === "save" ? saveApiBase("https://second-server.example") : resetApiBase();
      await rollbackStarted;
      // The provisional record is durable; the old session has not been cleared yet.
      const signingOut = signOut();
      try {
        await vi.waitFor(() => {
          const records = JSON.parse(store.get("rakazo.pending_sign_out") ?? "[]");
          expect(records).toHaveLength(1);
          expect(records[0].provisional).toBeUndefined();
        });
      } finally {
        releaseRollback();
      }
      await expect(switching).resolves.toMatchObject({ ok: false });
      await signingOut;
      expect(pendingSignOutRecords(store)).toEqual([{ apiBase, token: "token-a" }]);
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        store.set(key, value);
      });
      await resetApiBase();
    },
  );

  it("aborts a server switch when the session cannot be read", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    let sessionReads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") {
        sessionReads += 1;
        // The switch's own read fails; a later read would see the session again.
        if (sessionReads === 1) throw new Error("device locked");
      }
      return store.get(key) ?? null;
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the previous server session",
    });
    // Without knowing whether the old server has a session, the switch clears nothing.
    expect(store.get("rakazo.session_token")).toBe("session-token");
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it.each(["the call hang-up", "the space rollback write"])(
    "a save never clears a session that replaced the recorded one during %s",
    async (during) => {
      const store = new Map<string, string>();
      mockSecureStore(store);
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      // An earlier failed switch left the selection stored only in its rollback record.
      store.delete("rakazo.space_id");
      const signIn = () => saveSessionToken("token-b");
      if (during === "the call hang-up") {
        configureSessionEndHangUp(signIn);
      } else {
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.space_rollback" && value) await signIn();
          store.set(key, value);
        });
      }
      let result: Awaited<ReturnType<typeof saveApiBase>>;
      try {
        result = await saveApiBase("https://second-server.example");
      } finally {
        configureSessionEndHangUp(undefined);
        mockSecureStore(store);
      }

      if (during === "the call hang-up") {
        // The switch reads the session after the hang-up, so it revokes the session it clears.
        expect(result).toMatchObject({ ok: true });
        expect(store.has("rakazo.session_token")).toBe(false);
        expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-b"]);
      } else {
        // A session that changed after the read stops the switch before it clears anything.
        expect(result).toMatchObject({ ok: false });
        expect(store.get("rakazo.session_token")).toBe("token-b");
        expect(pendingSignOutRecords(store)).toEqual([]);
        expect(store.get("rakazo.space_id")).toBe("space-old");
      }
      await resetApiBase();
    },
  );

  it("a save stops while a session save started during the hang-up is still running", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saving: Promise<void> | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" && value === "token-b") await saveHeld;
      // The save completes while the switch writes the Space rollback.
      if (key === "rakazo.space_rollback" && value) {
        releaseSave();
        await saving;
      }
      store.set(key, value);
    });
    configureSessionEndHangUp(async () => {
      saving = saveSessionToken("token-b");
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      configureSessionEndHangUp(undefined);
      releaseSave();
      await saving;
      mockSecureStore(store);
    }

    expect(result).toMatchObject({ ok: false });
    expect(store.get("rakazo.session_token")).toBe("token-b");
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("a save revokes a stored session that a failed save during the hang-up left unsent", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" && value === "token-b") throw new Error("device locked");
      store.set(key, value);
    });
    configureSessionEndHangUp(() => saveSessionToken("token-b"));
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      configureSessionEndHangUp(undefined);
      mockSecureStore(store);
    }

    // The failed save left token-a stored; a restart would send it, so the switch revokes it.
    expect(result).toMatchObject({ ok: true });
    expect(store.has("rakazo.session_token")).toBe(false);
    expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
    await resetApiBase();
  });

  it.each(["save", "reset"])(
    "a %s rolled back after clearing a stored session a failed save left unsent keeps its revocation",
    async (change) => {
      const store = new Map<string, string>();
      mockSecureStore(store);
      if (change === "reset") await saveApiBase("https://old-server.example");
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === "rakazo.session_token" && value === "token-b") throw new Error("device locked");
        if (change === "save" && key === "rakazo.api_base") throw new Error("device locked");
        store.set(key, value);
      });
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
        if (change === "reset" && key === "rakazo.api_base") throw new Error("device locked");
        store.delete(key);
      });
      configureSessionEndHangUp(() => saveSessionToken("token-b"));
      let result: Awaited<ReturnType<typeof saveApiBase>>;
      try {
        result = await (change === "save"
          ? saveApiBase("https://second-server.example")
          : resetApiBase());
      } finally {
        configureSessionEndHangUp(undefined);
        mockSecureStore(store);
      }

      // The rollback does not bring token-a back, so its revocation stays owed.
      expect(result).toMatchObject({ ok: false });
      expect(store.has("rakazo.session_token")).toBe(false);
      expect(await authHeaders()).not.toHaveProperty("authorization");
      expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
      await resetApiBase();
    },
  );

  it.each([
    ["save", "nothing"],
    ["save", "a sign-in during the rollback"],
    ["save", "a sign-in after the rollback"],
    ["reset", "nothing"],
    ["reset", "a sign-in during the rollback"],
    ["reset", "a sign-in after the rollback"],
  ])(
    "a %s rolled back after clearing an unsent stored session revokes it unless %s reactivates it",
    async (change, reactivation) => {
      const store = new Map<string, string>();
      mockSecureStore(store);
      if (change === "reset") await saveApiBase("https://old-server.example");
      const previous = currentApiBase();
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      let rollingBack = false;
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === "rakazo.session_token" && value === "token-b") throw new Error("device locked");
        if (change === "save" && key === "rakazo.api_base") {
          rollingBack = true;
          throw new Error("device locked");
        }
        // The rollback restores the Space; a sign-in that returns token-a lands meanwhile.
        if (
          key === "rakazo.space_id" &&
          rollingBack &&
          reactivation === "a sign-in during the rollback"
        ) {
          rollingBack = false;
          await saveSessionToken("token-a");
        }
        store.set(key, value);
      });
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
        if (change === "reset" && key === "rakazo.api_base") {
          rollingBack = true;
          throw new Error("device locked");
        }
        store.delete(key);
      });
      configureSessionEndHangUp(() => saveSessionToken("token-b"));
      let result: Awaited<ReturnType<typeof saveApiBase>>;
      try {
        result = await (change === "save"
          ? saveApiBase("https://second-server.example")
          : resetApiBase());
      } finally {
        configureSessionEndHangUp(undefined);
        mockSecureStore(store);
      }
      if (reactivation === "a sign-in after the rollback") await saveSessionToken("token-a");
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);
      await flushPendingSignOut(true);

      expect(result).toMatchObject({ ok: false });
      const signOuts = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/auth/sign-out"),
      );
      if (reactivation === "nothing") {
        expect(signOuts.map(([url]) => url)).toEqual([`${previous}/api/auth/sign-out`]);
        const [, init] = signOuts[0] as [string, RequestInit];
        expect(init.headers).toMatchObject({
          authorization: "Bearer token-a",
        });
      } else {
        // The session in use again is not revoked.
        expect(signOuts).toEqual([]);
        expect(store.get("rakazo.session_token")).toBe("token-a");
      }
      expect(pendingSignOutRecords(store)).toEqual([]);
      await resetApiBase();
    },
  );

  it("a save stopped by a session change stores a Space selected during its restoring write", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    let selecting: Promise<boolean> | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value) await saveSessionToken("token-b");
      if (key === "rakazo.space_id" && value === "space-old" && !selecting) {
        // A new selection lands before the switch's restoring write.
        selecting = selectSpace("space-new");
        await selecting;
      }
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }

    expect(selecting).toBeDefined();
    expect(result).toMatchObject({ ok: false });
    expect(selectedSpaceId()).toBe("space-new");
    expect(store.get("rakazo.space_id")).toBe("space-new");
    expect(store.has("rakazo.space_rollback")).toBe(false);
    await resetApiBase();
  });

  it("a save stopped by a session change stores the last Space selected during its repair", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    let selecting: Promise<boolean> | undefined;
    let reselecting: Promise<boolean> | undefined;
    let newWrites = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value) await saveSessionToken("token-b");
      if (key === "rakazo.space_id" && value === "space-old" && !selecting) {
        selecting = selectSpace("space-new");
        await selecting;
      }
      // The second write of space-new is the switch's repair; another selection lands first.
      if (key === "rakazo.space_id" && value === "space-new" && ++newWrites === 2) {
        reselecting = selectSpace("space-newest");
        await reselecting;
      }
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }

    expect(reselecting).toBeDefined();
    expect(result).toMatchObject({ ok: false });
    expect(selectedSpaceId()).toBe("space-newest");
    expect(store.get("rakazo.space_id")).toBe("space-newest");
    expect(store.has("rakazo.space_rollback")).toBe(false);
    await resetApiBase();
  });

  it("a save stopped by a session change keeps a Space selected while it read the old one", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await clearSpace();
    // Stored but not yet cached, so the switch reads the selection from the store.
    store.set("rakazo.space_id", "space-old");
    let selecting: Promise<boolean> | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      const value = store.get(key) ?? null;
      if (key === "rakazo.space_id" && !selecting) {
        // A new selection lands after the switch read the old one.
        selecting = selectSpace("space-new");
        await selecting;
      }
      return value;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value) await saveSessionToken("token-b");
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }

    expect(selecting).toBeDefined();
    expect(result).toMatchObject({ ok: false });
    expect(store.get("rakazo.space_id")).toBe("space-new");
    expect(store.has("rakazo.space_rollback")).toBe(false);
    await resetApiBase();
  });

  it("a reset that cannot store the old server again keeps its session revoked, not restored", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await saveApiBase("https://old-server.example");
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.server_headers") throw new Error("device locked");
      store.delete(key);
    });
    let result: Awaited<ReturnType<typeof resetApiBase>>;
    try {
      result = await resetApiBase();
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);

    // The next launch opens the default server, so the old session is revoked, not restored.
    expect(result).toMatchObject({ ok: false });
    expect(store.has("rakazo.api_base")).toBe(false);
    expect(store.has("rakazo.session_token")).toBe(false);
    const signOuts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/sign-out"),
    );
    expect(signOuts.map(([url]) => url)).toEqual(["https://old-server.example/api/auth/sign-out"]);
    const [, init] = signOuts[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer token-a" });
    await resetApiBase();
  });

  it("a reset that cannot store the old server again signs in to the server the next launch opens", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await saveApiBase("https://old-server.example");
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.server_headers") throw new Error("device locked");
      store.delete(key);
    });
    let result: Awaited<ReturnType<typeof resetApiBase>>;
    try {
      result = await resetApiBase();
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/api/auth/sign-in/email")
        ? jsonResponse({ token: "token-c" })
        : jsonResponse({}),
    );
    vi.stubGlobal("fetch", fetchMock);
    await signIn("ada@example.com", "correct horse");
    await loadApiBase();

    // The token comes from the server a restart opens, so it is never sent to another one.
    expect(result).toMatchObject({ ok: false });
    const signIns = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/sign-in/email"),
    );
    expect(signIns.map(([url]) => url)).toEqual([`${currentApiBase()}/api/auth/sign-in/email`]);
    expect(currentApiBase()).toBe("http://127.0.0.1:3100");
    expect(await authHeaders(null)).toMatchObject({ authorization: "Bearer token-c" });
    await resetApiBase();
  });

  it("a sign-out during a running session save stops without clearing and records nothing", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" && value === "token-b") await saveHeld;
      store.set(key, value);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const saving = saveSessionToken("token-b");
    const signingOut = signOut();
    releaseSave();
    await saving;

    await expect(signingOut).rejects.toThrow("Could not clear the local session");
    expect(store.get("rakazo.session_token")).toBe("token-b");
    expect(pendingSignOutRecords(store)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a sign-out stops without clearing a session saved while it wrote its record", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      // A sign-in saves its token while the sign-out writes the revocation record.
      if (key === "rakazo.pending_sign_out") await saveSessionToken("token-b");
      store.set(key, value);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () => jsonResponse({})),
    );

    await expect(signOut()).rejects.toThrow("Could not clear the local session");
    mockSecureStore(store);
    expect(store.get("rakazo.session_token")).toBe("token-b");
    // The record for the session the user signed out of stays for delivery.
    expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
  });

  it("a rolled-back switch keeps the revocation of a session it could only restore in memory", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }

    // A restart would not find token-a, so its revocation record stays for the next retry.
    expect(result).toMatchObject({ ok: false });
    expect(store.has("rakazo.session_token")).toBe(false);
    expect(await authHeaders(null)).toMatchObject({ authorization: "Bearer token-a" });
    expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
  });

  it("a flush keeps the revocation of a rolled-back session kept only in memory", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    try {
      await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);

    // token-a is still in use, so it is not revoked; a restart loses it, so the record stays.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
  });

  it("a flush during a save of a memory-only session does not revoke it", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      if (key === "rakazo.session_token") throw new Error("device locked");
      store.set(key, value);
    });
    try {
      await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") await saveHeld;
      store.set(key, value);
    });
    // The same token is saved again; a flush runs while its write is held.
    const saving = saveSessionToken("token-a");
    await flushPendingSignOut(true);
    releaseSave();
    await saving;
    mockSecureStore(store);
    await flushPendingSignOut(true);

    // token-a is in use and now stored, so it is never revoked and its record is dropped.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get("rakazo.session_token")).toBe("token-a");
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("a hung session save defers only the current server's switch records", async () => {
    const record = (apiBase: string, token: string) => ({
      apiBase,
      token,
      headers: {},
      recordedAt: Date.now(),
      provisional: true,
    });
    const store = new Map<string, string>([
      [
        "rakazo.pending_sign_out",
        JSON.stringify([
          record("https://old-server.example", "token-a"),
          record(currentApiBase(), "token-c"),
        ]),
      ],
    ]);
    mockSecureStore(store);
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") await saveHeld;
      store.set(key, value);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const signOuts = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/api/auth/sign-out"))
        .map(([url, init]) => [url, new Headers(init?.headers).get("authorization")]);
    const saving = saveSessionToken("token-b");
    await flushPendingSignOut(true);

    // The other server's session cannot be the one being saved here, so it is revoked now.
    expect(signOuts()).toEqual([
      ["https://old-server.example/api/auth/sign-out", "Bearer token-a"],
    ]);
    expect(pendingSignOutRecords(store).map((entry) => entry.token)).toEqual(["token-c"]);

    releaseSave();
    await saving;
    await flushPendingSignOut(true);
    expect(signOuts()).toEqual([
      ["https://old-server.example/api/auth/sign-out", "Bearer token-a"],
      [`${currentApiBase()}/api/auth/sign-out`, "Bearer token-c"],
    ]);
  });

  it("a server switch stops when a session is saved while it clears the old one", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    const previous = currentApiBase();
    await restoreSessionToken("token-a");
    let signIn = true;
    vi.mocked(stopLiveNotifications).mockImplementation(async () => {
      // A sign-in on the old server saves its token while the clear stops notifications.
      if (signIn) {
        signIn = false;
        await saveSessionToken("token-b");
      }
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      vi.mocked(stopLiveNotifications).mockImplementation(async () => undefined);
    }

    // The old server's token is never sent to the new server.
    expect(result).toEqual({ ok: false, error: "Could not clear the previous server session" });
    expect(currentApiBase()).toBe(previous);
    expect(store.get("rakazo.session_token")).toBe("token-b");
    expect(await authHeaders(null)).toMatchObject({ authorization: "Bearer token-b" });
    // The cleared session is gone from the device, so its revocation stays.
    expect(pendingSignOutRecords(store).map((record) => record.token)).toEqual(["token-a"]);
  });

  it("a sign-out does not record a session saved while it reads the active one", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    let signedIn: Promise<void> | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      const value = store.get(key) ?? null;
      // A sign-in saves its token while the sign-out reads the active session.
      if (key === "rakazo.session_token" && !signedIn) {
        signedIn = saveSessionToken("fake-session-new");
        await signedIn;
      }
      return value;
    });

    await expect(signOut()).rejects.toThrow("Could not clear the local session");

    // The new session stays in use, so nothing may revoke it later.
    expect(store.get("rakazo.session_token")).toBe("fake-session-new");
    expect(await authHeaders(null)).toMatchObject({ authorization: "Bearer fake-session-new" });
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("a sign-out after a failed session save revokes the stored token it clears", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token" && value === "token-b") throw new Error("device locked");
      store.set(key, value);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await saveSessionToken("token-b").catch(() => undefined);
    await signOut();

    await vi.waitFor(() => {
      const signOuts = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/auth/sign-out"),
      );
      expect(signOuts).toHaveLength(1);
      const [, init] = signOuts[0] as [string, RequestInit];
      expect(init.headers).toMatchObject({ authorization: "Bearer token-a" });
    });
    expect(store.has("rakazo.session_token")).toBe(false);
    expect(await authHeaders()).not.toHaveProperty("authorization");
  });

  it("records no revocation when switching servers without a session", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    expect(pendingSignOutRecords(store)).toEqual([]);
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

  it("reports a failed clear when the remembered organization Spaces stay on the device", async () => {
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.org_spaces") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.org_spaces") throw new Error("device locked");
    });

    await expect(clearSpace()).resolves.toBe(false);
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
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith("rakazo.org_spaces");
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
      error: "Could not save the previous server session",
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

  it("keeps the unsent queue of a session the server rejects", async () => {
    const store = new Map<string, string>([["rakazo.session_token", "revoked-token"]]);
    mockSecureStore(store);
    await loadApiBase();
    const clear = vi.fn();
    configureUnsentSends({
      request: vi.fn(),
      serverReachable: () => true,
      passwordChanging: () => false,
      scope: () => null,
      disk: { clear, save: vi.fn() } as unknown as UnsentDisk,
      errorText: String,
      notDelivered: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized")),
    );

    // The rejection ends the session, but the queue must survive it: the app reports
    // those messages before a sign-in deletes them.
    await expect(rpc("bots/list")).rejects.toThrow("Unauthorized");

    expect(store.has("rakazo.session_token")).toBe(false);
    expect(clear).not.toHaveBeenCalled();
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

  it("shares the bounded SSE transport for one account call stream", async () => {
    const call = {
      id: "bot-1",
      spaceId: "space-1",
      name: "Caller",
      color: "",
      avatarSet: "rakazo",
      incomingCall: {
        callId: "call-1",
        reason: "Review",
        opening: "Hello",
        expiresAt: new Date(Date.now() + 45000).toISOString(),
      },
    };
    const frame = `data: ${JSON.stringify({ json: { type: "incoming.calls", payload: { calls: [call] } } })}\n\n`;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(frame, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const onCalls = vi.fn();
    await subscribeIncomingCallEvents(onCalls, new AbortController().signal);
    expect(onCalls).toHaveBeenCalledWith([call]);
    expect(fetch.mock.calls[0]?.[0]).toContain("notifications/subscribeCalls");
    expect(fetch).toHaveBeenCalledOnce();
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
      (view, event) => (event.seq > cursor ? (reduceThreadSnapshot(view, event) ?? view) : view),
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
    const live = reduceThreadSnapshot(fetched, {
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

    const next = mergeThreadSnapshot(initial, refreshed, true);

    expect(next.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(next.olderCursor).toBeNull();
  });

  it("holds live tool steps until mobile narration reaches a sentence boundary", () => {
    const narration = reduceThreadSnapshot(snapshot(), {
      type: "thread.progress",
      runId: "run-1",
      payload: { text: "Let me check " },
    });
    const pending = reduceThreadSnapshot(narration, {
      type: "agent.tool.called",
      runId: "run-1",
      payload: { name: "SLACK_FIND_CHANNELS" },
    });
    const completed = reduceThreadSnapshot(pending, {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "now." },
    });

    expect(pending?.messages[0]?.blocks).toEqual([
      {
        kind: "progress",
        text: "Let me check ",
        pendingTools: [{ name: "SLACK_FIND_CHANNELS" }],
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

  it("keeps the thread and first activity time on a live message for its tool card", () => {
    const started = reduceThreadSnapshot(snapshot(), {
      type: "thread.progress",
      runId: "run-1",
      threadId: "thread-1",
      createdAt: "2026-08-16T00:00:01.000Z",
      payload: { text: "Running: ls", activity: true },
    });
    const called = reduceThreadSnapshot(started, {
      type: "agent.tool.called",
      runId: "run-1",
      threadId: "thread-1",
      createdAt: "2026-08-16T00:00:09.000Z",
      payload: { name: "shell", executionId: "x1" },
    });
    expect(called?.messages[0]).toMatchObject({
      id: "progress:run-1",
      threadId: "thread-1",
      createdAt: "2026-08-16T00:00:01.000Z",
    });
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

    const next = mergeThreadSnapshot(waiting, refreshed);

    expect(next.cursor).toBe(12);
    expect(next.run?.status).toBe("queued");
    expect(next.activeRuns?.[0]?.status).toBe("queued");
  });

  it("starts an idle run from live events and selects the active safety cadence", () => {
    const initial: MobileSnapshot = { ...snapshot(), run: null, activeRuns: [] };
    expect(threadRefreshDelayMs(initial.run?.status, { liveSubscribed: true })).toBe(60_000);
    const started = reduceThreadSnapshot(initial, {
      type: "run.started",
      runId: "run-remote",
      botId: "bot-1",
      seq: 12,
      payload: { trigger: "routine" },
    });
    expect(started?.cursor).toBe(12);
    expect(started?.run).toMatchObject({
      id: "run-remote",
      botId: "bot-1",
      status: "running",
      trigger: "routine",
      error: null,
    });
    expect(started?.activeRuns).toEqual([started?.run]);
    expect(threadRefreshDelayMs(started?.run?.status, { liveSubscribed: true })).toBe(30_000);
    const finished = reduceThreadSnapshot(started, {
      type: "run.completed",
      runId: "run-remote",
      seq: 13,
    });
    expect(finished?.run).toBeNull();
    expect(finished?.activeRuns).toEqual([]);
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

function pendingSignOutRecords(store: Map<string, string>): { apiBase: string; token: string }[] {
  const raw = store.get("rakazo.pending_sign_out");
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is { apiBase: string; token: string } => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as { apiBase?: unknown; token?: unknown };
      return typeof record.apiBase === "string" && typeof record.token === "string";
    })
    .map((record) => ({ apiBase: record.apiBase, token: record.token }));
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
