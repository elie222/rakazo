import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionToken,
  loadSessionToken,
  saveSessionToken,
  tokenFromAuthResponse,
} from "./session.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

describe("mobile session storage", () => {
  beforeEach(() => {
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
  });

  it("stores and clears only the session token key", async () => {
    await saveSessionToken("secret-token");
    await clearSessionToken();

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "secret-token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
  });

  it("returns an empty token when secure storage is empty or unavailable", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
    await expect(loadSessionToken()).resolves.toBe("");

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await expect(loadSessionToken()).resolves.toBe("");
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

  it("falls back to and decodes the Better Auth session cookie", () => {
    const response = new Response(null, {
      headers: { "set-cookie": "better-auth.session_token=abc%2F123%3D; Path=/; HttpOnly" },
    });

    expect(tokenFromAuthResponse(response, {})).toBe("abc/123=");
  });

  it("rejects unrelated cookies and malformed response bodies", () => {
    const response = new Response(null, { headers: { "set-cookie": "other=value; Path=/" } });
    expect(tokenFromAuthResponse(response, { token: 123 })).toBe("");
    expect(tokenFromAuthResponse(response, null)).toBe("");
  });
});
