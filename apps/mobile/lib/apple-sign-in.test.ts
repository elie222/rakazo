import { isAvailableAsync, signInAsync } from "expo-apple-authentication";
import { beforeEach, expect, it, vi } from "vitest";
import { currentApiBase } from "./api";
import { signInWithIdentityToken } from "./api-auth";
import { continueWithApple } from "./apple-sign-in";
import { continueWithSso } from "./sso";

vi.mock("expo-apple-authentication", () => ({
  isAvailableAsync: vi.fn(),
  signInAsync: vi.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));
vi.mock("./api", () => ({ currentApiBase: vi.fn(() => "https://api.example.test") }));
vi.mock("./server-config", () => ({
  DEFAULT_API: "https://API.example.test/api/",
  LOCAL_API: "http://127.0.0.1:3100",
}));
vi.mock("./api-auth", () => ({ signInWithIdentityToken: vi.fn() }));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentApiBase).mockReturnValue("https://api.example.test");
  vi.mocked(isAvailableAsync).mockResolvedValue(true);
  vi.mocked(signInWithIdentityToken).mockResolvedValue({ verificationRequired: false });
  vi.mocked(continueWithSso).mockResolvedValue(true);
});

it("sends the native identity token and the name Apple only returns once", async () => {
  vi.mocked(signInAsync).mockResolvedValue({
    identityToken: "identity-token",
    email: "ada@privaterelay.example",
    fullName: { givenName: "Ada", familyName: "Lovelace" },
  } as never);
  await expect(continueWithApple()).resolves.toBe(true);
  expect(signInWithIdentityToken).toHaveBeenCalledWith("apple", "identity-token", {
    name: { firstName: "Ada", lastName: "Lovelace" },
    email: "ada@privaterelay.example",
  });
  expect(continueWithSso).not.toHaveBeenCalled();
});

it("uses the browser when the native sheet is unavailable", async () => {
  vi.mocked(isAvailableAsync).mockResolvedValue(false);
  await expect(continueWithApple()).resolves.toBe(true);
  expect(continueWithSso).toHaveBeenCalledWith("sign-in", "apple");
  expect(signInAsync).not.toHaveBeenCalled();
});

it("treats a dismissed sheet as a cancelled sign-in", async () => {
  vi.mocked(signInAsync).mockRejectedValue(
    Object.assign(new Error("canceled"), { code: "ERR_REQUEST_CANCELED" }),
  );
  await expect(continueWithApple()).resolves.toBe(false);
  expect(signInWithIdentityToken).not.toHaveBeenCalled();
});

it("keeps native credentials away from custom servers", async () => {
  vi.mocked(currentApiBase).mockReturnValue("https://custom.example.test");
  await expect(continueWithApple()).resolves.toBe(true);
  expect(signInAsync).not.toHaveBeenCalled();
  expect(signInWithIdentityToken).not.toHaveBeenCalled();
  expect(continueWithSso).toHaveBeenCalledWith("sign-in", "apple");
});
it("propagates sheet failures without a browser retry", async () => {
  vi.mocked(signInAsync).mockRejectedValue(new Error("sheet failed"));
  await expect(continueWithApple()).rejects.toThrow("sheet failed");
  expect(continueWithSso).not.toHaveBeenCalled();
});

it("propagates server errors without retrying in a browser", async () => {
  vi.mocked(signInAsync).mockResolvedValue({ identityToken: "identity-token" } as never);
  vi.mocked(signInWithIdentityToken).mockRejectedValue(new Error("server refused"));
  await expect(continueWithApple()).rejects.toThrow("server refused");
  expect(continueWithSso).not.toHaveBeenCalled();
});
