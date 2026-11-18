import { expect, it, vi } from "vitest";

vi.mock("expo-router/react-navigation", async () => {
  const { createContext } = await import("react");
  return { HeaderHeightContext: createContext<number | undefined>(undefined) };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("../native/native-controls", () => ({ iosAtLeast: () => true }));

const { sideStatusColumn } = await import("./floating-header");

it.each([
  // The iPhone Duo's outer display: the status bar down the right side.
  [{ top: 0, left: 0, right: 84 }, true],
  // A phone in portrait has a top inset.
  [{ top: 62, left: 0, right: 0 }, false],
  // A phone in landscape has an inset on both sides.
  [{ top: 0, left: 62, right: 62 }, false],
  // A tablet has a top inset and no side ones.
  [{ top: 24, left: 0, right: 0 }, false],
])("finds a side status column from the insets %o", (insets, expected) => {
  expect(sideStatusColumn(insets)).toBe(expected);
});
