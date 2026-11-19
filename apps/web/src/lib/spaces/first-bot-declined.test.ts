// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { firstBotDeclined, rememberFirstBotDeclined } from "./first-bot-declined";

afterEach(() => window.sessionStorage.clear());

it("remembers, for the tab, the Spaces onboarding found no first bot for", () => {
  expect(firstBotDeclined("space-new")).toBe(false);
  rememberFirstBotDeclined("space-new");
  rememberFirstBotDeclined("space-new");
  rememberFirstBotDeclined(null);
  expect(firstBotDeclined("space-new")).toBe(true);
  expect(firstBotDeclined("space-other")).toBe(false);
  expect(firstBotDeclined(undefined)).toBe(false);
});

it("treats unreadable storage as nothing remembered", () => {
  window.sessionStorage.setItem("rakazo:first-bot-declined", "not json");
  expect(firstBotDeclined("space-new")).toBe(false);
  rememberFirstBotDeclined("space-new");
  expect(firstBotDeclined("space-new")).toBe(true);
});
