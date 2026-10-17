import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ useWindowDimensions: () => ({ width: 0, height: 0 }) }));

const { inboxPaneWidth, splitsWindow } = await import("./split-view");

describe("split view", () => {
  it("splits an unfolded foldable or a tablet, not a phone or a half-screen window", () => {
    expect(splitsWindow(412)).toBe(false);
    expect(splitsWindow(673)).toBe(false);
    expect(splitsWindow(750)).toBe(true);
    expect(splitsWindow(1280)).toBe(true);
  });

  it("keeps the chat list between its narrowest and widest size", () => {
    expect(inboxPaneWidth(750)).toBe(300);
    expect(inboxPaneWidth(1000)).toBe(333);
    expect(inboxPaneWidth(1600)).toBe(380);
  });
});
