import { Platform } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadHeaderFloats } from "./thread-edges";
import {
  keyboardDockMaxHeight,
  keyboardListInset,
  threadKeyboardAvoidance,
} from "./thread-keyboard-offset";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "18.5" } }));

afterEach(() => {
  Platform.OS = "ios";
  (Platform as { Version: number | string }).Version = "18.5";
});

describe("threadKeyboardAvoidance", () => {
  it.each(["18.5", 26, "26.1", "27.1"])(
    "preserves zero offset for the floating iOS header on %s",
    (version) => {
      (Platform as { Version: number | string }).Version = version;
      expect(
        threadKeyboardAvoidance({
          os: Platform.OS,
          floatingHeader: threadHeaderFloats(),
          nativeHeaderHeight: 103,
        }),
      ).toEqual({ enabled: true, automaticOffset: false, keyboardVerticalOffset: 0 });
    },
  );

  it("preserves the native height for an opaque iOS header", () => {
    expect(
      threadKeyboardAvoidance({ os: "ios", floatingHeader: false, nativeHeaderHeight: 103 }),
    ).toEqual({ enabled: true, automaticOffset: false, keyboardVerticalOffset: 103 });
  });

  it.each([0, 32, 64, 88, 120])(
    "leaves Android to the composer dock rather than caching a %s px header",
    (header) => {
      Platform.OS = "android";
      expect(
        threadKeyboardAvoidance({
          os: Platform.OS,
          floatingHeader: threadHeaderFloats(),
          nativeHeaderHeight: header,
        }),
      ).toEqual({ enabled: false, automaticOffset: false, keyboardVerticalOffset: 0 });
    },
  );
});

describe("keyboardListInset", () => {
  it("gives Android the keyboard's height, so the newest message clears the lifted dock", () => {
    expect(keyboardListInset({ os: "android", rootOwnsKeyboard: false, keyboardHeight: 291 })).toBe(
      291,
    );
  });

  it("leaves iOS to its avoiding view, which already shrinks the list", () => {
    expect(keyboardListInset({ os: "ios", rootOwnsKeyboard: false, keyboardHeight: 291 })).toBe(0);
  });

  it("adds nothing while a call's root view owns the keyboard", () => {
    expect(keyboardListInset({ os: "android", rootOwnsKeyboard: true, keyboardHeight: 291 })).toBe(
      0,
    );
  });

  it("never asks for negative room", () => {
    expect(keyboardListInset({ os: "android", rootOwnsKeyboard: false, keyboardHeight: -8 })).toBe(
      0,
    );
  });
});

describe("keyboardDockMaxHeight", () => {
  it("leaves exactly the room above the keyboard", () => {
    expect(keyboardDockMaxHeight(812, 291)).toBe(521);
  });

  it("never asks for negative room", () => {
    expect(keyboardDockMaxHeight(200, 291)).toBe(0);
  });
});
