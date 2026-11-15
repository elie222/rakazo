// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SCREEN_PAGE_CONTROLS_HIDDEN, SCREEN_VIEWPORT_LOCK } from "./computer";

describe("SCREEN_VIEWPORT_LOCK", () => {
  it("pins the page at its own size, adding the viewport when the page has none", () => {
    document.head.innerHTML = "";
    new Function(SCREEN_VIEWPORT_LOCK)();
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    expect(meta?.content).toContain("user-scalable=no");
    expect(meta?.content).toContain("maximum-scale=1");
    meta!.content = "width=device-width";
    new Function(SCREEN_VIEWPORT_LOCK)();
    expect(document.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    expect(meta?.content).toContain("minimum-scale=1");
  });
});

describe("SCREEN_PAGE_CONTROLS_HIDDEN", () => {
  it("hides the page's paste and trackpad buttons, and nothing else", () => {
    document.head.innerHTML = "";
    new Function(SCREEN_PAGE_CONTROLS_HIDDEN)();
    const css = document.head.querySelector("style")?.textContent ?? "";
    expect(css).toBe("#mobile-paste,#mobile-trackpad{display:none!important}");
  });
});
