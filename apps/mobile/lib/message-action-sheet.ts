import * as Clipboard from "expo-clipboard";
import { ActionSheetIOS, Alert, Platform } from "react-native";

export type MessageActionSheetHandlers = {
  canReact: boolean;
  reacted: boolean;
  onReact: () => void;
  onReply: () => void;
  copyText: string;
  timeLabel: string;
  labels: {
    react: string;
    removeReact: string;
    reply: string;
    copy: string;
    cancel: string;
  };
};

/** Native message actions: long-press sheet with React, Reply, Copy, and time. */
export function presentMessageActionSheet(handlers: MessageActionSheetHandlers): void {
  const reactLabel = handlers.reacted ? handlers.labels.removeReact : handlers.labels.react;
  const runCopy = () => {
    void Clipboard.setStringAsync(handlers.copyText).catch(() => undefined);
  };

  if (Platform.OS === "ios") {
    const options = [
      handlers.labels.cancel,
      ...(handlers.canReact ? [reactLabel] : []),
      handlers.labels.reply,
      handlers.labels.copy,
      handlers.timeLabel,
    ];
    const cancelButtonIndex = 0;
    const timeButtonIndex = options.length - 1;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex,
        disabledButtonIndices: [timeButtonIndex],
      },
      (index) => {
        if (index === cancelButtonIndex || index === timeButtonIndex) return;
        let cursor = 1;
        if (handlers.canReact) {
          if (index === cursor) {
            handlers.onReact();
            return;
          }
          cursor += 1;
        }
        if (index === cursor) {
          handlers.onReply();
          return;
        }
        cursor += 1;
        if (index === cursor) runCopy();
      },
    );
    return;
  }

  Alert.alert(handlers.timeLabel, undefined, [
    ...(handlers.canReact
      ? [
          {
            text: reactLabel,
            onPress: handlers.onReact,
          },
        ]
      : []),
    { text: handlers.labels.reply, onPress: handlers.onReply },
    { text: handlers.labels.copy, onPress: runCopy },
    { text: handlers.labels.cancel, style: "cancel" as const },
  ]);
}
