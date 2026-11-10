import { describe, expect, it, vi } from "vitest";
import {
  actionAccessibilityState,
  actionFills,
  actionProminence,
  iosAtLeast,
} from "./native-controls";

const platform = vi.hoisted(() => ({
  OS: "ios",
  Version: 26 as number | string,
}));

vi.mock("react-native", () => ({
  Platform: platform,
}));

describe("iosAtLeast", () => {
  it("stays false off iOS, including Android version numbers and strings", () => {
    platform.OS = "android";
    platform.Version = 36;
    expect(iosAtLeast(26)).toBe(false);
    platform.Version = "36.0";
    expect(iosAtLeast(18)).toBe(false);
  });

  it("compares the iOS major version from a number or a string", () => {
    platform.OS = "ios";
    platform.Version = 18;
    expect(iosAtLeast(26)).toBe(false);
    expect(iosAtLeast(18)).toBe(true);
    platform.Version = 26;
    expect(iosAtLeast(26)).toBe(true);
    platform.Version = "18.2";
    expect(iosAtLeast(26)).toBe(false);
    expect(iosAtLeast(18)).toBe(true);
    platform.Version = "26.1";
    expect(iosAtLeast(26)).toBe(true);
  });
});

describe("actionFills", () => {
  it("fills primary and destructive buttons unless fill is set", () => {
    expect(actionFills("primary", undefined)).toBe(true);
    expect(actionFills("destructive", undefined)).toBe(true);
    expect(actionFills("secondary", undefined)).toBe(false);
    expect(actionFills("plain", undefined)).toBe(false);
    expect(actionFills("quiet", undefined)).toBe(false);
    expect(actionFills("primary", false)).toBe(false);
    expect(actionFills("secondary", true)).toBe(true);
  });
});

describe("action selection", () => {
  it("preserves defaults and presents both latch states", () => {
    expect(actionProminence("quiet", undefined)).toBe("quiet");
    expect(actionProminence("secondary", true)).toBe("primary");
    expect(actionProminence("primary", false)).toBe("secondary");
    expect(actionAccessibilityState(false, undefined)).toBeUndefined();
    expect(actionAccessibilityState(false, false)).toEqual({ selected: false });
    expect(actionAccessibilityState(true, true)).toEqual({ disabled: true, selected: true });
  });
});
