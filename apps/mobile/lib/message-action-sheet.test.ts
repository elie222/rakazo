import { ActionSheetIOS, Alert, Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isComposeViewAvailable } from "./compose-available";
import { presentMessageActionSheet } from "./message-action-sheet";
import {
  dismissMessageActionSheet,
  getMessageActionSheet,
  mountMessageActionSheetHost,
  selectMessageActionSheet,
  subscribeMessageActionSheet,
} from "./message-action-sheet-store";

vi.mock("./compose-available", () => ({ isComposeViewAvailable: vi.fn(() => false) }));

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
    selected: 2,
    cancel: "Cancel",
    more: "More",
    colorScheme: "light",
  });
  return actions;
}

describe("native message action sheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isComposeViewAvailable).mockReturnValue(false);
  });

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

  it("uses paging when the Compose host is not mounted", () => {
    Platform.OS = "android";
    vi.mocked(isComposeViewAvailable).mockReturnValue(true);
    sheet();
    expect(Alert.alert).toHaveBeenCalledOnce();
    expect(getMessageActionSheet()).toBeNull();
  });

  it.each([
    "HostView",
    "BoxView",
    "ModalBottomSheetView",
    "LazyColumnView",
    "ListItemView",
    "SlotView",
    "TextView",
  ])("uses paging when %s is missing", (missing) => {
    Platform.OS = "android";
    vi.mocked(isComposeViewAvailable).mockImplementation((view) => view !== missing);
    const unmount = mountMessageActionSheetHost();
    try {
      sheet();
      expect(Alert.alert).toHaveBeenCalledOnce();
      expect(getMessageActionSheet()).toBeNull();
    } finally {
      unmount();
    }
  });

  it("publishes every Android row and waits for native dismissal before running it once", async () => {
    Platform.OS = "android";
    vi.mocked(isComposeViewAvailable).mockReturnValue(true);
    const unmount = mountMessageActionSheetHost();
    const notify = vi.fn();
    const unsubscribe = subscribeMessageActionSheet(notify);
    try {
      const actions = sheet();
      const current = getMessageActionSheet()!;
      expect(current).toEqual({ actions, title: "12:34", colorScheme: "light", selected: 2 });
      expect(Alert.alert).not.toHaveBeenCalled();
      let hidden!: () => void;
      const hide = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            hidden = resolve;
          }),
      );
      const selected = selectMessageActionSheet(current, 3, hide);
      await selectMessageActionSheet(current, 3, hide);
      expect(hide).toHaveBeenCalledOnce();
      expect(actions[3]!.onPress).not.toHaveBeenCalled();
      hidden();
      await selected;
      expect(getMessageActionSheet()).toBeNull();
      expect(actions[3]!.onPress).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      unmount();
    }
  });

  it("dismisses without an action and discards stale callbacks after dismissal or unmount", async () => {
    Platform.OS = "android";
    vi.mocked(isComposeViewAvailable).mockReturnValue(true);
    const unmount = mountMessageActionSheetHost();
    const actions = sheet();
    const current = getMessageActionSheet()!;
    dismissMessageActionSheet(current);
    await selectMessageActionSheet(current, 0, async () => {});
    sheet();
    unmount();
    expect(getMessageActionSheet()).toBeNull();
    expect(actions.every((action) => action.onPress.mock.calls.length === 0)).toBe(true);
    sheet();
    expect(Alert.alert).toHaveBeenCalledOnce();
  });

  it("keeps iOS on ActionSheetIOS even with a mounted, available Compose host", () => {
    Platform.OS = "ios";
    vi.mocked(isComposeViewAvailable).mockReturnValue(true);
    const unmount = mountMessageActionSheetHost();
    try {
      sheet();
      expect(ActionSheetIOS.showActionSheetWithOptions).toHaveBeenCalledOnce();
      expect(isComposeViewAvailable).not.toHaveBeenCalled();
      expect(getMessageActionSheet()).toBeNull();
    } finally {
      unmount();
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
