import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android" }));

vi.mock("react-native", () => ({ Platform: platform }));
vi.mock("./native", () => ({ native: { fillPressed: "fill-pressed" } }));

import { androidRipple } from "./ripple";

describe("android ripple", () => {
  it("adds ripple feedback from the themed token on Android only", () => {
    expect(androidRipple()).toEqual({ color: "fill-pressed" });
    expect(androidRipple("#fff")).toEqual({ color: "#fff" });
    platform.OS = "ios";
    expect(androidRipple()).toBeUndefined();
  });
});
