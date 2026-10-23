import { ActionSheetIOS, Alert, Platform } from "react-native";

import { isComposeViewAvailable } from "./compose-available";
import { showMessageActionSheet } from "./message-action-sheet-store";

export function isMessageActionSheetAvailable() {
  return (
    Platform.OS === "android" &&
    [
      "HostView",
      "BoxView",
      "ModalBottomSheetView",
      "LazyColumnView",
      "ListItemView",
      "SlotView",
      "TextView",
    ].every(isComposeViewAvailable)
  );
}

type MessageAction = { text: string; onPress: () => void };

export function presentMessageActionSheet({
  actions,
  title,
  cancel,
  more,
  colorScheme,
  selected,
}: {
  actions: MessageAction[];
  title?: string;
  /** Index of the current action, displayed only by the Android sheet. */
  selected?: number;
  cancel: string;
  more: string;
  colorScheme: "light" | "dark";
}): void {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...actions.map((action) => action.text), cancel],
        cancelButtonIndex: actions.length,
        title,
        userInterfaceStyle: colorScheme,
      },
      (index) => actions[index]?.onPress(),
    );
    return;
  }

  if (
    isMessageActionSheetAvailable() &&
    showMessageActionSheet({ actions, title, colorScheme, selected })
  ) {
    return;
  }

  function showPage(remaining: MessageAction[]) {
    // Android alerts support three buttons. Back/outside tap dismisses every page.
    const buttons =
      remaining.length > 3
        ? [...remaining.slice(0, 2), { text: more, onPress: () => showPage(remaining.slice(2)) }]
        : [
            ...remaining,
            ...(remaining.length < 3 ? [{ text: cancel, style: "cancel" as const }] : []),
          ];
    Alert.alert(title ?? "", undefined, buttons, { cancelable: true });
  }
  showPage(actions);
}
