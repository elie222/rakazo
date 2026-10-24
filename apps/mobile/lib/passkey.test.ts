import { passkeyOfferDismissedKey } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { Alert } from "react-native";
import { create, get, isSupported } from "react-native-passkeys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  clearSpace,
  currentApiBase,
  fetchMobileJson,
  passwordResetCapabilities,
} from "./api";
import {
  addPasskey,
  listPasskeys,
  offerPasskeyOnce,
  passkeysAvailable,
  resetPasskeysForTests,
  signInWithPasskey,
} from "./passkey";
import { currentSessionGeneration, replaceSessionTokenIfCurrent } from "./session";

const constants = vi.hoisted(() => ({
  expoConfig: { extra: { passkeyRpIds: ["rakazo.example.test"] } },
}));

vi.mock("expo-constants", () => ({ default: constants }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
const platform = vi.hoisted(() => ({ OS: "ios" }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, Platform: platform }));
vi.mock("react-native-passkeys", () => ({ isSupported: vi.fn(), get: vi.fn(), create: vi.fn() }));
vi.mock("./api", () => ({
  authHeaders: vi.fn(async () => ({ authorization: "Bearer current-session" })),
  clearSpace: vi.fn(async () => true),
  currentApiBase: vi.fn(() => "https://rakazo.example.test"),
  fetchMobileJson: vi.fn(),
  passwordResetCapabilities: vi.fn(),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: vi.fn(() => 1),
  replaceSessionTokenIfCurrent: vi.fn(async () => true),
  tokenFromAuthResponse: (_response: Response, body: { session?: { token?: string } }) =>
    body?.session?.token ?? "",
}));

const CHALLENGE = "__Secure-better-auth.better-auth-passkey=token.c2lnbmF0dXJl%3D";
const credential = { id: "cred", rawId: "cred", type: "public-key", response: {} };

function challengeResponse(
  body: unknown = { challenge: "challenge", rpId: "rakazo.example.test" },
) {
  return {
    response: new Response(null, {
      headers: { "set-cookie": `${CHALLENGE}; Path=/; HttpOnly; Secure; SameSite=Lax` },
    }),
    body,
  };
}

function server(
  passkeyRpId: string | null,
  nativePasskeys: { ios: boolean; android: boolean } = { ios: true, android: true },
) {
  return { passkeyRpId, nativePasskeys };
}

function requests() {
  return vi.mocked(fetchMobileJson).mock.calls.map(([url, init]) => ({
    path: new URL(String(url)).pathname,
    headers: init.headers as Record<string, string>,
    credentials: init.credentials,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPasskeysForTests();
  constants.expoConfig.extra.passkeyRpIds = ["rakazo.example.test"];
  platform.OS = "ios";
  vi.mocked(isSupported).mockReturnValue(true);
  vi.mocked(currentApiBase).mockReturnValue("https://rakazo.example.test");
  vi.mocked(currentSessionGeneration).mockReturnValue(1);
  vi.mocked(clearSpace).mockResolvedValue(true);
  vi.mocked(replaceSessionTokenIfCurrent).mockResolvedValue(true);
  vi.mocked(fetchMobileJson).mockReset();
  vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  vi.mocked(SecureStore.setItemAsync).mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("passkey availability", () => {
  it("needs a server this binary is associated with and a supporting device", async () => {
    await expect(passkeysAvailable(server("rakazo.example.test"))).resolves.toBe(true);
    await expect(passkeysAvailable(server("RAKAZO.example.test"))).resolves.toBe(true);
    await expect(passkeysAvailable(server("self-hosted.example.test"))).resolves.toBe(false);
    await expect(passkeysAvailable(server(null))).resolves.toBe(false);
    await expect(passkeysAvailable(undefined)).resolves.toBe(false);
  });

  it("hides passkeys on a platform the server's domain does not vouch for", async () => {
    const iosOnly = server("rakazo.example.test", { ios: true, android: false });
    await expect(passkeysAvailable(iosOnly)).resolves.toBe(true);
    platform.OS = "android";
    await expect(passkeysAvailable(iosOnly)).resolves.toBe(false);
    await expect(
      passkeysAvailable(server("rakazo.example.test", { ios: false, android: true })),
    ).resolves.toBe(true);
  });

  it("hides passkeys when an older server does not say which apps it vouches for", async () => {
    await expect(passkeysAvailable({ passkeyRpId: "rakazo.example.test" })).resolves.toBe(false);
  });

  it("hides passkeys when the device does not support them", async () => {
    vi.mocked(isSupported).mockReturnValue(false);
    await expect(passkeysAvailable(server("rakazo.example.test"))).resolves.toBe(false);
  });

  it("hides passkeys on a binary built without associated domains", async () => {
    constants.expoConfig.extra.passkeyRpIds = [];
    await expect(passkeysAvailable(server("rakazo.example.test"))).resolves.toBe(false);
  });

  it.each(["https://attacker.example.test", "http://rakazo.example.test"])(
    "does not trust a server at %s advertising an associated RP",
    async (apiBase) => {
      vi.mocked(currentApiBase).mockReturnValue(apiBase);
      await expect(passkeysAvailable(server("rakazo.example.test"))).resolves.toBe(false);
    },
  );

  it("allows an HTTPS subdomain of an associated RP", async () => {
    vi.mocked(currentApiBase).mockReturnValue("https://api.rakazo.example.test");
    await expect(passkeysAvailable(server("rakazo.example.test"))).resolves.toBe(true);
  });
});

describe("passkey sign-in", () => {
  beforeEach(() => {
    vi.mocked(fetchMobileJson)
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce({
        response: Response.json({}),
        body: { session: { token: "new-session" }, user: { id: "user-1" } },
      });
    vi.mocked(get).mockResolvedValue(credential as never);
  });

  it("returns the signed challenge cookie and saves the new session", async () => {
    await expect(signInWithPasskey()).resolves.toBe(true);
    const [options, verify] = requests();
    expect(options?.path).toBe("/api/auth/passkey/generate-authenticate-options");
    expect(get).toHaveBeenCalledWith({ challenge: "challenge", rpId: "rakazo.example.test" });
    expect(verify?.path).toBe("/api/auth/passkey/verify-authentication");
    expect(verify?.headers).toMatchObject({ origin: "rakazo://", cookie: CHALLENGE });
    expect(verify?.headers).not.toHaveProperty("authorization");
    // iOS would otherwise merge the jar's copy of the cookie with ours (CHALLENGE_NOT_FOUND).
    expect([options?.credentials, verify?.credentials]).toEqual(["omit", "omit"]);
    expect(verify?.body).toEqual({ response: credential });
    expect(clearSpace).toHaveBeenCalledOnce();
    expect(replaceSessionTokenIfCurrent).toHaveBeenCalledWith(1, "new-session");
  });

  it.each([
    ["an iOS cancellation", { code: "ERR_USER_CANCELLED", message: "User cancelled" }],
    ["an Android cancellation", { code: "Passkey Get", message: "UserCancelled" }],
    ["an Android back press", { code: "Passkey Get", message: "DomError: NotAllowedError - x" }],
  ])("treats %s as no sign-in", async (_label, error) => {
    vi.mocked(get).mockRejectedValue(error);
    await expect(signInWithPasskey()).resolves.toBe(false);
    expect(fetchMobileJson).toHaveBeenCalledOnce();
    expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  });

  it("treats an empty native result as no sign-in", async () => {
    vi.mocked(get).mockResolvedValue(null);
    await expect(signInWithPasskey()).resolves.toBe(false);
    expect(fetchMobileJson).toHaveBeenCalledOnce();
  });

  it("explains other native failures without technical detail", async () => {
    vi.mocked(get).mockRejectedValue({ code: "ERR_NOT_CONFIGURED", message: "AASA" });
    await expect(signInWithPasskey()).rejects.toThrow("Could not continue");
    expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  });

  it.each(["server", "session"])("drops the result when the %s changes", async (changed) => {
    vi.mocked(get).mockImplementation(async () => {
      if (changed === "server")
        vi.mocked(currentApiBase).mockReturnValue("https://other.example.test");
      else vi.mocked(currentSessionGeneration).mockReturnValue(2);
      return credential as never;
    });
    await expect(signInWithPasskey()).rejects.toThrow();
    expect(fetchMobileJson).toHaveBeenCalledOnce();
    expect(clearSpace).not.toHaveBeenCalled();
  });

  it("fails before the sheet when the server sends no challenge cookie", async () => {
    vi.mocked(fetchMobileJson)
      .mockReset()
      .mockResolvedValueOnce({
        response: Response.json({}),
        body: { challenge: "challenge", rpId: "rakazo.example.test" },
      });
    await expect(signInWithPasskey()).rejects.toThrow("Could not continue");
    expect(get).not.toHaveBeenCalled();
  });

  it("maps a rejected passkey through the auth error copy", async () => {
    vi.mocked(fetchMobileJson)
      .mockReset()
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce({ response: new Response(null, { status: 429 }), body: {} });
    await expect(signInWithPasskey()).rejects.toThrow(
      "Too many attempts. Try again in a few minutes.",
    );
  });

  it("refuses a custom server relaying another server's challenge", async () => {
    vi.mocked(currentApiBase).mockReturnValue("https://attacker.example.test");
    await expect(signInWithPasskey()).rejects.toThrow("Could not continue");
    expect(get).not.toHaveBeenCalled();
    expect(fetchMobileJson).toHaveBeenCalledOnce();
    expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  });

  it.each([undefined, "other.example.test"])("rejects challenge RP %s", async (rpId) => {
    vi.mocked(fetchMobileJson)
      .mockReset()
      .mockResolvedValueOnce(
        challengeResponse({
          challenge: "challenge",
          rpId,
        }),
      );
    await expect(signInWithPasskey()).rejects.toThrow("Could not continue");
    expect(get).not.toHaveBeenCalled();
    expect(fetchMobileJson).toHaveBeenCalledOnce();
  });
});

describe("passkey registration", () => {
  it("registers with the session and the challenge cookie", async () => {
    vi.mocked(fetchMobileJson)
      .mockResolvedValueOnce(
        challengeResponse({
          challenge: "register",
          rp: { id: "rakazo.example.test", name: "Rakazo" },
        }),
      )
      .mockResolvedValueOnce({ response: Response.json({}), body: { id: "passkey-1" } });
    vi.mocked(create).mockResolvedValue(credential as never);
    await expect(addPasskey()).resolves.toBe(true);
    const [options, verify] = requests();
    expect(options?.path).toBe("/api/auth/passkey/generate-register-options");
    expect(options?.headers).toMatchObject({ authorization: "Bearer current-session" });
    expect(create).toHaveBeenCalledWith({
      challenge: "register",
      rp: { id: "rakazo.example.test", name: "Rakazo" },
    });
    expect(verify?.path).toBe("/api/auth/passkey/verify-registration");
    expect(verify?.headers).toMatchObject({
      authorization: "Bearer current-session",
      cookie: CHALLENGE,
      origin: "rakazo://",
    });
    expect([options?.credentials, verify?.credentials]).toEqual(["omit", "omit"]);
    expect(verify?.body).toEqual({ response: credential });
    expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  });

  it("asks for a fresh sign-in when the session is too old", async () => {
    vi.mocked(fetchMobileJson).mockResolvedValueOnce({
      response: new Response(null, { status: 403 }),
      body: { code: "SESSION_NOT_FRESH", message: "Session is not fresh" },
    });
    await expect(addPasskey()).rejects.toThrow("Sign in again");
    expect(create).not.toHaveBeenCalled();
  });

  it("resolves false when the person cancels", async () => {
    vi.mocked(fetchMobileJson).mockResolvedValueOnce(
      challengeResponse({
        challenge: "register",
        rp: { id: "rakazo.example.test", name: "Rakazo" },
      }),
    );
    vi.mocked(create).mockRejectedValue({ code: "ERR_USER_CANCELLED" });
    await expect(addPasskey()).resolves.toBe(false);
    expect(fetchMobileJson).toHaveBeenCalledOnce();
  });

  it("does not send another server's session", async () => {
    vi.mocked(authHeaders).mockImplementationOnce(async () => {
      vi.mocked(currentApiBase).mockReturnValue("https://other.example.test");
      return { authorization: "Bearer other-session" };
    });
    await expect(addPasskey()).rejects.toThrow();
    expect(fetchMobileJson).not.toHaveBeenCalled();
  });

  it("does not register a passkey for an unrelated RP", async () => {
    constants.expoConfig.extra.passkeyRpIds.push("other.example.test");
    vi.mocked(fetchMobileJson).mockResolvedValueOnce(
      challengeResponse({
        challenge: "register",
        rp: { id: "other.example.test", name: "Other" },
      }),
    );
    await expect(addPasskey()).rejects.toThrow("Could not continue");
    expect(create).not.toHaveBeenCalled();
    expect(fetchMobileJson).toHaveBeenCalledOnce();
  });
});

it("lists passkeys with a missing name left for the screen's fallback", async () => {
  vi.mocked(fetchMobileJson).mockResolvedValueOnce({
    response: Response.json([]),
    body: [
      { id: "a", name: "MacBook", createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "b", name: " ", createdAt: "2026-10-02T00:00:00.000Z" },
      { name: "no id" },
    ],
  });
  await expect(listPasskeys()).resolves.toEqual([
    { id: "a", name: "MacBook", createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "b", name: null, createdAt: "2026-10-02T00:00:00.000Z" },
  ]);
});

describe("one-time passkey offer", () => {
  const now = Date.now();
  function session(userAgeMs: number) {
    return {
      response: Response.json({}),
      body: {
        user: { id: "user-1", createdAt: new Date(now - userAgeMs).toISOString() },
        session: { createdAt: new Date(now).toISOString() },
      },
    };
  }
  function answer(label: string) {
    const buttons = vi.mocked(Alert.alert).mock.calls[0]?.[2] ?? [];
    buttons.find((button) => button.text === label)?.onPress?.();
  }

  beforeEach(() => {
    vi.mocked(passwordResetCapabilities).mockResolvedValue({
      sso: null,
      passwordAuth: true,
      passwordReset: false,
      resetUrl: null,
      passkeyRpId: "rakazo.example.test",
      nativePasskeys: { ios: true, android: true },
    });
  });

  it("offers once right after signup and remembers Not now", async () => {
    vi.mocked(fetchMobileJson)
      .mockResolvedValueOnce(session(60_000))
      .mockResolvedValueOnce({ response: Response.json([]), body: [] });
    await offerPasskeyOnce("user-1", () => true);
    expect(Alert.alert).toHaveBeenCalledOnce();
    expect(vi.mocked(Alert.alert).mock.calls[0]?.[0]).toBe("Add a passkey for faster sign-in?");
    answer("Not now");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(passkeyOfferDismissedKey("user-1"), "1");

    await offerPasskeyOnce("user-1", () => true);
    expect(Alert.alert).toHaveBeenCalledOnce();
  });

  it("asks again on the next visit after a failed check", async () => {
    vi.mocked(fetchMobileJson)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(session(60_000))
      .mockResolvedValueOnce({ response: Response.json([]), body: [] });
    await offerPasskeyOnce("user-1", () => true);
    expect(Alert.alert).not.toHaveBeenCalled();
    await offerPasskeyOnce("user-1", () => true);
    expect(Alert.alert).toHaveBeenCalledOnce();
  });

  it("starts registration from the offer", async () => {
    vi.mocked(fetchMobileJson)
      .mockResolvedValueOnce(session(60_000))
      .mockResolvedValueOnce({ response: Response.json([]), body: [] })
      .mockResolvedValueOnce(
        challengeResponse({
          challenge: "register",
          rp: { id: "rakazo.example.test", name: "Rakazo" },
        }),
      )
      .mockResolvedValueOnce({ response: Response.json({}), body: {} });
    vi.mocked(create).mockResolvedValue(credential as never);
    await offerPasskeyOnce("user-1", () => true);
    answer("Add passkey");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(passkeyOfferDismissedKey("user-1"), "1");
  });

  it("never offers after a dismissal", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    await offerPasskeyOnce("user-1", () => true);
    expect(fetchMobileJson).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("does not offer an account that already has a passkey", async () => {
    vi.mocked(fetchMobileJson)
      .mockResolvedValueOnce(session(60_000))
      .mockResolvedValueOnce({ response: Response.json([]), body: [{ id: "a" }] });
    await offerPasskeyOnce("user-1", () => true);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("does not offer a returning account and skips the passkey list", async () => {
    vi.mocked(fetchMobileJson).mockResolvedValueOnce(session(3 * 24 * 60 * 60_000));
    await offerPasskeyOnce("user-1", () => true);
    expect(fetchMobileJson).toHaveBeenCalledOnce();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("waits for the next visit when the inbox left the screen meanwhile", async () => {
    vi.mocked(fetchMobileJson)
      .mockResolvedValueOnce(session(60_000))
      .mockResolvedValueOnce({ response: Response.json([]), body: [] })
      .mockResolvedValueOnce(session(60_000))
      .mockResolvedValueOnce({ response: Response.json([]), body: [] });
    await offerPasskeyOnce("user-1", () => false);
    expect(Alert.alert).not.toHaveBeenCalled();
    await offerPasskeyOnce("user-1", () => true);
    expect(Alert.alert).toHaveBeenCalledOnce();
  });

  it("does not offer on servers this binary cannot use", async () => {
    vi.mocked(passwordResetCapabilities).mockResolvedValue({
      sso: null,
      passwordAuth: true,
      passwordReset: false,
      resetUrl: null,
      passkeyRpId: "self-hosted.example.test",
      nativePasskeys: { ios: true, android: true },
    });
    await offerPasskeyOnce("user-1", () => true);
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

// Last: it swaps the module registry for the rest of the file.
it("hides passkeys when the native module is missing from the binary", async () => {
  vi.resetModules();
  vi.doMock("react-native-passkeys", () => {
    throw new Error("Cannot find native module 'ReactNativePasskeys'");
  });
  const fresh = await import("./passkey");
  await expect(fresh.passkeysAvailable(server("rakazo.example.test"))).resolves.toBe(false);
});
