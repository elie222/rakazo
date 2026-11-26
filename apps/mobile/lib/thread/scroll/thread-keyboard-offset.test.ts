import { Platform } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadHeaderFloats } from "./thread-edges";
import { threadKeyboardVerticalOffset } from "./thread-keyboard-offset";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "18.5" } }));

afterEach(() => {
  Platform.OS = "ios";
  (Platform as { Version: number | string }).Version = "18.5";
});

describe("threadKeyboardVerticalOffset", () => {
  it.each(["18.5", 26, "26.1", "27.1"])(
    "preserves zero offset for the floating iOS header on %s",
    (version) => {
      (Platform as { Version: number | string }).Version = version;
      expect(
        threadKeyboardVerticalOffset({
          os: Platform.OS,
          floatingHeader: threadHeaderFloats(),
          nativeHeaderHeight: 103,
        }),
      ).toBe(0);
    },
  );

  it("preserves the native height for an opaque iOS header", () => {
    expect(
      threadKeyboardVerticalOffset({ os: "ios", floatingHeader: false, nativeHeaderHeight: 103 }),
    ).toBe(103);
  });

  it("uses no header offset on Android", () => {
    expect(
      threadKeyboardVerticalOffset({
        os: "android",
        floatingHeader: false,
        nativeHeaderHeight: 88,
      }),
    ).toBe(0);
  });
});
