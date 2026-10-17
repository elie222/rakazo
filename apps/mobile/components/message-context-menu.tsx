import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { ReactNode } from "react";
import { useMemo } from "react";
import type { ColorSchemeName, GestureResponderEvent } from "react-native";
import { Platform, Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { MessageMenuEntry, MessageMenuSymbol } from "../lib/message-context-menu";

const symbols = {
  reply: "arrowshape.turn.up.left",
  copy: "doc.on.doc",
  react: "face.smiling",
  quote: "text.quote",
  speak: "speaker.wave.2",
  select: "character.cursor.ibeam",
  unread: "message.badge",
} as const satisfies Record<MessageMenuSymbol, Extract<NonNullable<MenuAction["image"]>, string>>;

export function MessageContextMenu({
  actions,
  children,
  colorScheme,
  maxWidth,
  fullWidth = false,
  onAction,
  onLongPress,
  onDoubleTap,
}: {
  actions: readonly MessageMenuEntry[];
  children: ReactNode;
  colorScheme: ColorSchemeName;
  maxWidth: number;
  fullWidth?: boolean;
  onAction: (id: string) => void;
  onLongPress?: (event: GestureResponderEvent) => void;
  /** Double tapping the message, used to react with a thumbs up. */
  onDoubleTap?: () => void;
}) {
  const doubleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDelay(250)
        .enabled(Boolean(onDoubleTap))
        .runOnJS(true)
        .onEnd((_event, success) => {
          if (success) onDoubleTap?.();
        }),
    [onDoubleTap],
  );
  if (Platform.OS !== "ios") {
    return (
      <GestureDetector gesture={doubleTap}>
        <Pressable
          accessible={false}
          onLongPress={onLongPress}
          style={{ maxWidth: "100%", width: fullWidth ? maxWidth : undefined, flexShrink: 1 }}
        >
          {children}
        </Pressable>
      </GestureDetector>
    );
  }
  return (
    <MenuView
      actions={actions.map(toMenuAction)}
      colorScheme={colorScheme}
      onPressAction={(event) => onAction(event.nativeEvent.event)}
      shouldOpenOnLongPress
      style={{ maxWidth: "100%", flexShrink: 1 }}
    >
      {/* The SwiftUI bridge measures its trigger without a horizontal constraint. */}
      <GestureDetector gesture={doubleTap}>
        <View style={{ maxWidth, width: fullWidth ? maxWidth : undefined, flexShrink: 1 }}>
          {children}
        </View>
      </GestureDetector>
    </MenuView>
  );
}

function toMenuAction(entry: MessageMenuEntry): MenuAction {
  return {
    id: entry.id,
    title: entry.title,
    image: entry.symbol ? symbols[entry.symbol] : undefined,
    displayInline: entry.displayInline,
    subactions: entry.subactions?.map(toMenuAction),
  };
}
