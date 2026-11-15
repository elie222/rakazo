import { describe, expect, it, vi } from "vitest";
import { floatingBarBottom } from "./content-bottom-inset";

vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./call-keyboard-context", () => ({ CallKeyboardContext: {} }));

describe("floatingBarBottom", () => {
  it("keeps a gap above Android's three-button bar, whose whole height is the inset", () => {
    expect(floatingBarBottom(48)).toBe(60);
  });

  it("sits just above a gesture strip or home indicator", () => {
    expect(floatingBarBottom(24)).toBe(36);
    expect(floatingBarBottom(34)).toBe(46);
  });

  it("keeps clear of a bare edge", () => {
    expect(floatingBarBottom(0)).toBe(16);
  });
});
