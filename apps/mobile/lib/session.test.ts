import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionToken,
  loadSessionToken,
  restoreSessionToken,
  saveSessionToken,
  snapshotSessionToken,
  tokenFromAuthResponse,
} from "./session.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  stopLiveNotifications: vi.fn(async () => undefined),
}));

describe("mobile session storage", () => {
  beforeEach(async () => {
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await restoreSessionToken("");
  });

  it("stores and clears only the session token key", async () => {
    await saveSessionToken("secret-token");
    await clearSessionToken();

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "secret-token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
  });

  it("overwrites the token when SecureStore delete fails", async () => {
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await expect(clearSessionToken()).resolves.toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "");
  });

  it("invalidates the in-memory session when SecureStore cannot clear the token", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("secret-token");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await expect(clearSessionToken()).resolves.toBe(false);
    await expect(loadSessionToken()).resolves.toBe("");
  });

  it("returns an empty token when secure storage is empty or unavailable", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
    await expect(loadSessionToken()).resolves.toBe("");

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await expect(loadSessionToken()).resolves.toBe("");

    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);
    expect(SecureStore.getItemAsync).toHaveBeenNthCalledWith(1, "rakazo.session_token");
    expect(SecureStore.getItemAsync).toHaveBeenNthCalledWith(2, "rakazo.session_token");
  });

  it("restores the active session in memory when persistence is unavailable", async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await restoreSessionToken("secret-token");
    await expect(loadSessionToken()).resolves.toBe("secret-token");
    await expect(snapshotSessionToken()).resolves.toEqual({ ok: true, value: "secret-token" });

    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    await expect(clearSessionToken()).resolves.toBe(false);
    await expect(loadSessionToken()).resolves.toBe("");
  });

  it("distinguishes an unreadable token store from an empty session", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));

    await expect(snapshotSessionToken()).resolves.toEqual({ ok: false });
  });
});

describe("auth response token parsing", () => {
  it("prefers explicit JSON tokens, including nested session responses", () => {
    const response = new Response(null, {
      headers: { "set-cookie": "better-auth.session_token=cookie-token; Path=/" },
    });

    expect(tokenFromAuthResponse(response, { token: "body-token" })).toBe("body-token");
    expect(tokenFromAuthResponse(response, { session: { token: "nested-token" } })).toBe(
      "nested-token",
    );
  });

  it.each(["better-auth.session_token", "__Secure-better-auth.session_token"])(
    "falls back to and decodes the %s cookie",
    (name) => {
      const response = new Response(null, {
        headers: { "set-cookie": `${name}=abc%2F123%3D; Path=/; HttpOnly` },
      });

      expect(tokenFromAuthResponse(response, {})).toBe("abc/123=");
    },
  );

  it("finds a secure session after another Set-Cookie value", () => {
    const response = new Response(null, {
      headers: {
        "set-cookie":
          "other=value; Path=/, __Secure-better-auth.session_token=secure-token; Path=/; HttpOnly",
      },
    });

    expect(tokenFromAuthResponse(response, {})).toBe("secure-token");
  });

  it("rejects unrelated cookies and malformed response bodies", () => {
    const unrelated = new Response(null, {
      headers: { "set-cookie": "notbetter-auth.session_token=attacker; Path=/" },
    });
    const malformed = new Response(null, {
      headers: { "set-cookie": "better-auth.session_token=bad%ZZ; Path=/" },
    });
    expect(tokenFromAuthResponse(unrelated, { token: 123 })).toBe("");
    expect(tokenFromAuthResponse(unrelated, null)).toBe("");
    expect(tokenFromAuthResponse(malformed, {})).toBe("");
  });
});
