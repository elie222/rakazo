vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  currentApiBase,
  flushPendingSignOut,
  MAX_MOBILE_AUTH_RESPONSE_BYTES,
  rpc,
  selectedSpaceId,
} from "./api.js";
import {
  changePassword,
  deleteAccount,
  fetchAccountSecurity,
  passwordResetCapabilities,
  requestAccountDeletionCode,
  requestPasswordReset,
  sendSignInCode,
  signIn,
  signInWithCode,
  signOut,
  signUp,
  updateAccountName,
} from "./api-auth.js";
import {
  loadApiBase,
  resetApiBase,
  saveApiBase,
  selectInitialSpace,
  selectSpace,
} from "./api-server.js";
import { artifactCacheSession } from "./artifact-cache-session";
import { resumeLiveNotifications } from "./live-notifications.js";
import {
  clearSessionToken,
  currentSessionGeneration,
  loadSessionToken,
  replaceSessionTokenIfCurrent,
  restoreSessionToken,
  saveSessionToken,
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

import {
  deferredFetch,
  jsonResponse,
  mockSecureStore,
  pendingSignOutRecords,
} from "./api-test-helpers";

describe("mobile API sign-in and account", () => {
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
          "x-rakazo-signup-surface": "ios",
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
          "x-rakazo-signup-surface": "ios",
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

  it.each([
    [
      "saving a server",
      "https://second.example.test",
      () => saveApiBase("https://second.example.test"),
    ],
    ["resetting the server", "http://127.0.0.1:3100", () => resetApiBase()],
  ])(
    "drops a sign-in that starts and finishes while %s is still being stored",
    async (_name, next, change) => {
      const storage = new Map<string, string>();
      mockSecureStore(storage);
      await saveApiBase("https://first.example.test");
      let releaseWrite!: () => void;
      const writeHeld = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let writing!: () => void;
      const writeStarted = new Promise<void>((resolve) => {
        writing = resolve;
      });
      const holdEndpointWrite = async (key: string) => {
        if (key !== "rakazo.api_base") return;
        writing();
        await writeHeld;
      };
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        await holdEndpointWrite(key);
        storage.set(key, value);
      });
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
        await holdEndpointWrite(key);
        storage.delete(key);
      });
      const fetchMock = vi.fn(async (input: string, _init?: RequestInit) =>
        input.endsWith("/api/auth/sign-in/email")
          ? jsonResponse({ token: "fake-session-first" })
          : jsonResponse({ success: true }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const switching = change();
      await writeStarted;
      expect(currentApiBase()).toBe("https://first.example.test");
      const pending = signIn("ada@example.test", "correct horse");
      let settled = false;
      const rejection = expect(
        pending.finally(() => {
          settled = true;
        }),
      ).rejects.toThrow("Could not continue");
      // The answer is handled while the new server URL is still being written.
      try {
        await vi.waitFor(() => expect(settled).toBe(true));
      } finally {
        releaseWrite();
      }
      await rejection;
      await expect(switching).resolves.toMatchObject({ ok: true });

      expect(currentApiBase()).toBe(next);
      expect(await loadSessionToken()).toBe("");
      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "https://first.example.test/api/auth/sign-out",
          expect.objectContaining({
            headers: expect.objectContaining({ authorization: "Bearer fake-session-first" }),
          }),
        ),
      );
      await resetApiBase();
    },
  );

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
          "x-rakazo-signup-surface": "ios",
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
          "x-rakazo-signup-surface": "ios",
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
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
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
