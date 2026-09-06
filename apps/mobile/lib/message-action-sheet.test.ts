import { ActionSheetIOS, Alert, Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { presentMessageActionSheet } from "./message-action-sheet";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
  Alert: { alert: vi.fn() },
}));

function sheet() {
  const actions = ["Reply", "React", "Speak", "Copy"].map((text) => ({ text, onPress: vi.fn() }));
  presentMessageActionSheet({
    actions,
    title: "12:34",
    cancel: "Cancel",
    more: "More",
    colorScheme: "light",
  });
  return actions;
}

describe("native message action sheet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves every iOS action, timestamp, appearance and cancellation", () => {
    Platform.OS = "ios";
    const actions = sheet();
    const [options, select] = vi.mocked(ActionSheetIOS.showActionSheetWithOptions).mock.calls[0]!;
    expect(options).toEqual({
      options: ["Reply", "React", "Speak", "Copy", "Cancel"],
      cancelButtonIndex: 4,
      title: "12:34",
      userInterfaceStyle: "light",
    });
    select(4);
    expect(actions.every((action) => action.onPress.mock.calls.length === 0)).toBe(true);
    for (let index = 0; index < actions.length; index++) {
      select(index);
      expect(actions[index]!.onPress).toHaveBeenCalledOnce();
    }
  });

  it("keeps all Android actions reachable within the three-button limit", () => {
    Platform.OS = "android";
    const actions = sheet();
    const [title, , firstPage, options] = vi.mocked(Alert.alert).mock.calls[0]!;
    expect(title).toBe("12:34");
    expect(options).toEqual({ cancelable: true });
    expect(firstPage?.map((button) => button.text)).toEqual(["Reply", "React", "More"]);
    firstPage?.[0]?.onPress?.();
    firstPage?.[1]?.onPress?.();
    firstPage?.[2]?.onPress?.();
    const [, , secondPage, secondOptions] = vi.mocked(Alert.alert).mock.calls[1]!;
    expect(secondPage?.map((button) => button.text)).toEqual(["Speak", "Copy", "Cancel"]);
    expect(secondOptions).toEqual({ cancelable: true });
    secondPage?.[0]?.onPress?.();
    secondPage?.[1]?.onPress?.();
    expect(actions.every((action) => action.onPress.mock.calls.length === 1)).toBe(true);
  });
});
