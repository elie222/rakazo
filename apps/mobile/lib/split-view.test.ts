import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ useWindowDimensions: () => ({ width: 0, height: 0 }) }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));

const { inboxPaneWidth, splitsWindow } = await import("./split-view");

describe("split view", () => {
  it("splits an unfolded foldable or a tablet, not a phone or a half-screen window", () => {
    expect(splitsWindow(412)).toBe(false);
    expect(splitsWindow(673)).toBe(false);
    expect(splitsWindow(750)).toBe(true);
    expect(splitsWindow(1280)).toBe(true);
  });

  it("defaults the chat list to a third of the window within its usual size", () => {
    expect(inboxPaneWidth(750)).toBe(300);
    expect(inboxPaneWidth(1000)).toBe(333);
    expect(inboxPaneWidth(1600)).toBe(380);
  });

  it("keeps a dragged width while leaving the chat readable", () => {
    expect(inboxPaneWidth(750, 320)).toBe(320);
    expect(inboxPaneWidth(750, 100)).toBe(240);
    expect(inboxPaneWidth(750, 600)).toBe(390);
  });
});
