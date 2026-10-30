import { Platform } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadHeaderFloats } from "./thread-edges";
import { threadKeyboardAvoidance } from "./thread-keyboard-offset";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "18.5" } }));

afterEach(() => {
  Platform.OS = "ios";
  Platform.Version = "18.5";
});

describe("threadKeyboardAvoidance", () => {
  it.each(["18.5", 26, "26.1", "27.1"])(
    "preserves zero offset for the floating iOS header on %s",
    (version) => {
      Platform.Version = version;
      expect(
        threadKeyboardAvoidance({
          os: Platform.OS,
          floatingHeader: threadHeaderFloats(),
          nativeHeaderHeight: 103,
        }),
      ).toEqual({ automaticOffset: false, keyboardVerticalOffset: 0 });
    },
  );

  it("preserves the native height for an opaque iOS header", () => {
    expect(
      threadKeyboardAvoidance({ os: "ios", floatingHeader: false, nativeHeaderHeight: 103 }),
    ).toEqual({ automaticOffset: false, keyboardVerticalOffset: 103 });
  });

  it.each([0, 32, 64, 88, 120])(
    "lets Android track the actual screen position rather than caching a %s px header",
    (header) => {
      Platform.OS = "android";
      expect(
        threadKeyboardAvoidance({
          os: Platform.OS,
          floatingHeader: threadHeaderFloats(),
          nativeHeaderHeight: header,
        }),
      ).toEqual({ automaticOffset: true, keyboardVerticalOffset: 0 });
    },
  );
});
