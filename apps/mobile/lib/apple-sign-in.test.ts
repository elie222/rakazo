import { isAvailableAsync, signInAsync } from "expo-apple-authentication";
import { beforeEach, expect, it, vi } from "vitest";
import { signInWithIdentityToken } from "./api-auth";
import { continueWithApple } from "./apple-sign-in";
import { continueWithSso } from "./sso";

vi.mock("expo-apple-authentication", () => ({
  isAvailableAsync: vi.fn(),
  signInAsync: vi.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));
vi.mock("./api-auth", () => ({ signInWithIdentityToken: vi.fn() }));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
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
