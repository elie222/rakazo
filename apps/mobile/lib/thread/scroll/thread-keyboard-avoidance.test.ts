import { Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadKeyboardAvoidance } from "./thread-keyboard-avoidance";

const { height } = vi.hoisted(() => ({ height: { value: 0 } }));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("react-native-keyboard-controller", () => ({
  useReanimatedKeyboardAnimation: () => ({ height }),
}));
vi.mock("react-native-reanimated", () => ({
  useAnimatedStyle: (style: () => object) => style(),
}));

beforeEach(() => {
  Platform.OS = "ios";
  height.value = 0;
});

describe("useThreadKeyboardAvoidance", () => {
  it.each([
    [-300, 300],
    [-160, 160],
    [0, 0],
  ])(
    "uses the Android keyboard displacement %s without a header measurement",
    (keyboardHeight, paddingBottom) => {
      Platform.OS = "android";
      height.value = keyboardHeight;

      expect(
        useThreadKeyboardAvoidance({
          rootAvoidsKeyboard: false,
          floatingHeader: false,
          nativeHeaderHeight: 88,
        }),
      ).toEqual({ enabled: false, keyboardVerticalOffset: 0, keyboardPadding: { paddingBottom } });
    },
  );

  it("clears the thread padding when a call takes over with the keyboard still open", () => {
    Platform.OS = "android";
    height.value = -300;

    expect(
      useThreadKeyboardAvoidance({
        rootAvoidsKeyboard: true,
        floatingHeader: false,
        nativeHeaderHeight: 88,
      }),
    ).toEqual({
      enabled: false,
      keyboardVerticalOffset: 0,
      keyboardPadding: { paddingBottom: 0 },
    });
  });

  it.each([
    [true, 0],
    [false, 103],
  ])(
    "preserves the iOS avoiding view when floatingHeader is %s",
    (floatingHeader, keyboardVerticalOffset) => {
      height.value = -300;

      expect(
        useThreadKeyboardAvoidance({
          rootAvoidsKeyboard: false,
          floatingHeader,
          nativeHeaderHeight: 103,
        }),
      ).toEqual({ enabled: true, keyboardVerticalOffset, keyboardPadding: { paddingBottom: 0 } });
    },
  );
});
