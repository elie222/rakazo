import { describe, expect, it } from "vitest";
import { pageAppName, uniqueBundleName } from "./bundle-name.js";

describe("pageAppName", () => {
  it.each([
    ["Deal Tracker", "Deal Tracker"],
    ["Q3/Q4: plan", "Q3-Q4- plan"],
    ["..hidden", "hidden"],
    ["  spaced\n\tout  ", "spaced out"],
    ["bell\u0007 rtl‮", "bell rtl"],
    ["...", "Page"],
  ])("makes %j a usable file name", (title, name) => {
    expect(pageAppName(title)).toBe(name);
  });

  it("keeps at most 60 characters without splitting one", () => {
    expect([...pageAppName("😀".repeat(80))]).toHaveLength(60);
  });
});

describe("uniqueBundleName", () => {
  it("numbers a name another app already has, ignoring case", () => {
    expect(uniqueBundleName("Deals", new Set())).toBe("Deals.app");
    expect(uniqueBundleName("Deals", new Set(["deals.app", "Deals 2.app"]))).toBe("Deals 3.app");
  });
});
