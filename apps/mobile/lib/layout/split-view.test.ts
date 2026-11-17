import { describe, expect, it, vi } from "vitest";

vi.mock("./fold-regions", () => ({ useFoldRegions: () => [] }));

vi.mock("react-native", () => ({ useWindowDimensions: () => ({ width: 0, height: 0 }) }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));

const { closesSplitPane, inboxPaneWidth, splitsWindow } = await import("./split-view");

describe("split view", () => {
  it.each([
    "/thread",
    "/group-thread",
    "/bot-settings",
    "/group-settings",
    "/computer",
    "/artifacts",
    "/artifact",
    "/routine",
    "/routines",
    "/bot-profile",
  ])("closes %s when a heading selects a different or unknown space", (pathname) => {
    expect(closesSplitPane(pathname, "space-a", "space-b")).toBe(true);
    expect(closesSplitPane(pathname, null, "space-b")).toBe(true);
    expect(closesSplitPane(pathname, "space-a", "space-a")).toBe(false);
  });

  it("keeps the empty pane when a heading selects a space", () => {
    expect(closesSplitPane("/", null, "space-b")).toBe(false);
    expect(closesSplitPane("/", "space-a", "space-b")).toBe(false);
  });

  it("splits an unfolded foldable or a tablet, not a phone or a half-screen window", () => {
    expect(splitsWindow(412)).toBe(false);
    expect(splitsWindow(673)).toBe(true);
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

it.each([
  [402, false],
  [466, false],
  [599, false],
  [600, true],
  [669, true],
  [951, true],
])("adapts a %i point window without sacrificing pane minimums", (width, split) => {
  expect(splitsWindow(width)).toBe(split);
  if (split) {
    expect(inboxPaneWidth(width)).toBeGreaterThanOrEqual(240);
    expect(width - inboxPaneWidth(width)).toBeGreaterThanOrEqual(360);
  }
});

it("places the panes on either side of a vertical fold and restores the saved width", async () => {
  const { splitPaneLayout } = await import("./split-view");
  const fold = { x: 465, y: 0, width: 21, height: 669 };
  expect(splitPaneLayout(951, 669, 320, [fold])).toEqual({
    inboxWidth: 465,
    gap: 21,
    folded: true,
  });
  expect(splitPaneLayout(951, 669, 320, [])).toEqual({ inboxWidth: 320, gap: 0, folded: false });
  expect(splitPaneLayout(669, 951, 280, [{ x: 0, y: 465, width: 669, height: 21 }])).toEqual({
    inboxWidth: 280,
    gap: 0,
    folded: false,
  });
  expect(splitPaneLayout(951, 669, 320, [{ ...fold, x: 100 }])).toEqual({
    inboxWidth: 320,
    gap: 0,
    folded: false,
  });
});

it("recognizes even a zero-width vertical division as a fixed divider", async () => {
  const { splitPaneLayout } = await import("./split-view");
  expect(splitPaneLayout(951, 669, 320, [{ x: 475, y: 0, width: 0, height: 669 }])).toEqual({
    inboxWidth: 475,
    gap: 0,
    folded: true,
  });
});
