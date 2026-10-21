import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android" }));
const theme = vi.hoisted(() => ({ label: "#123456" }));

vi.mock("react-native", () => ({ Platform: platform }));
vi.mock("./native", () => ({ native: theme }));

import { androidRipple, withAlpha } from "./ripple";

beforeEach(() => {
  platform.OS = "android";
  theme.label = "#123456";
});

describe("android ripple", () => {
  it("reads the current label color with a translucent state layer", () => {
    expect(androidRipple()).toEqual({ color: "rgba(18, 52, 86, 0.12)", foreground: true });
    theme.label = "#ffffff";
    expect(androidRipple()).toEqual({ color: "rgba(255, 255, 255, 0.12)", foreground: true });
    expect(androidRipple("#fff")).toEqual({ color: "#fff", foreground: true });
  });

  it("leaves iOS feedback unchanged", () => {
    platform.OS = "ios";
    expect(androidRipple()).toBeUndefined();
    expect(androidRipple("#fff")).toBeUndefined();
  });
});

describe("state-layer alpha", () => {
  it.each(["#abc", "#aabbcc", "#AABBCC80", "rgb(170, 187, 204)", "rgba(170,187,204,0.5)"])(
    "sets the requested alpha for %s",
    (color) => {
      expect(withAlpha(color, 0.2)).toBe("rgba(170, 187, 204, 0.2)");
    },
  );

  it("preserves unsupported colors", () => {
    expect(withAlpha("red", 0.2)).toBe("red");
    expect(withAlpha("#invalid", 0.2)).toBe("#invalid");
  });
});
