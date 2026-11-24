// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { holdSsoAutoStart, releaseSsoAutoStart, ssoAutoStartAllowed } from "./sso-auto-start";

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

it("is released by a session created after the hold", () => {
  vi.useFakeTimers({ now: new Date("2026-11-24T10:00:00Z") });
  expect(holdSsoAutoStart()).toBe(true);
  expect(ssoAutoStartAllowed()).toBe(false);
  releaseSsoAutoStart(new Date("2026-11-24T10:00:30Z"));
  expect(ssoAutoStartAllowed()).toBe(true);
});

it("stays held for a tab still on the session being signed out", () => {
  vi.useFakeTimers({ now: new Date("2026-11-24T10:00:00Z") });
  holdSsoAutoStart();
  releaseSsoAutoStart(new Date("2026-11-24T08:00:00Z"));
  expect(ssoAutoStartAllowed()).toBe(false);
});
