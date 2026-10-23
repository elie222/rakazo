import { Platform } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadHeaderFloats } from "./thread-edges";
import { threadKeyboardOffset } from "./thread-keyboard-offset";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "18.5" } }));

afterEach(() => {
  Platform.OS = "ios";
  Platform.Version = "18.5";
});

describe("threadKeyboardOffset", () => {
  it.each(["18.5", 26, "26.1", "27.1"])(
    "does not offset the floating header on iOS %s",
    (version) => {
      Platform.Version = version;
      expect(
        threadKeyboardOffset({
          os: Platform.OS,
          floatingHeader: threadHeaderFloats(),
          nativeHeaderHeight: 103,
          measuredOffset: 0,
        }),
      ).toBe(0);
    },
  );

  it("would need the native header height for an opaque iOS header", () => {
    expect(
      threadKeyboardOffset({
        os: "ios",
        floatingHeader: false,
        nativeHeaderHeight: 103,
        measuredOffset: 0,
      }),
    ).toBe(103);
  });

  it("uses the measured window position on Android", () => {
    Platform.OS = "android";
    expect(
      threadKeyboardOffset({
        os: Platform.OS,
        floatingHeader: threadHeaderFloats(),
        nativeHeaderHeight: 64,
        measuredOffset: 88,
      }),
    ).toBe(88);
  });
});
