import { afterEach, expect, it, vi } from "vitest";
import {
  accountRequestHeaders,
  pauseAccountRequests,
  setAccountIdentity,
} from "./account-identity";

afterEach(() => {
  setAccountIdentity(null);
  vi.unstubAllGlobals();
});

it("pins requests to the displayed identity even before another tab observes a cookie change", () => {
  setAccountIdentity("family");
  vi.stubGlobal("localStorage", { getItem: () => "work" });
  expect(accountRequestHeaders().get("x-rakazo-user-id")).toBe("family");
});

it("stops old requests before the selected session cookie changes", () => {
  setAccountIdentity("family");
  pauseAccountRequests();
  expect(() => accountRequestHeaders()).toThrow();
});
