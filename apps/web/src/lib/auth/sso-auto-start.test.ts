// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { holdSsoAutoStart, releaseSsoAutoStart, ssoAutoStartAllowed } from "./sso-auto-start";

afterEach(() => localStorage.clear());

it("allows an automatic start again once a session releases the hold", () => {
  expect(holdSsoAutoStart()).toBe(true);
  expect(ssoAutoStartAllowed()).toBe(false);
  releaseSsoAutoStart();
  expect(ssoAutoStartAllowed()).toBe(true);
});
