import { expect, it, vi } from "vitest";
import { continueWithApple } from "./apple-sign-in";
import { continueWithSso } from "./sso";

vi.mock("./api", () => ({ currentApiBase: () => "https://api.example.test" }));
vi.mock("./server-config", () => ({ DEFAULT_API: "https://api.example.test" }));
vi.mock("expo-apple-authentication", () => {
  throw new Error("Native module unavailable");
});
vi.mock("./api-auth", () => ({ signInWithIdentityToken: vi.fn() }));
vi.mock("./sso", () => ({ continueWithSso: vi.fn(async () => true) }));

it("uses browser OAuth when the installed binary cannot load the native module", async () => {
  await expect(continueWithApple()).resolves.toBe(true);
  expect(continueWithSso).toHaveBeenCalledWith("sign-in", "apple");
});
