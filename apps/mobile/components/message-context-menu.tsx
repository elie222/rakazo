import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { ReactNode } from "react";
import { useMemo } from "react";
import type { ColorSchemeName, GestureResponderEvent } from "react-native";
import { Platform, Pressable, View } from "react-native";
import { createDoubleTapDetector } from "../lib/double-tap";
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

const tapPoint = (event: GestureResponderEvent) => ({
  x: event.nativeEvent.pageX,
  y: event.nativeEvent.pageY,
  time: event.nativeEvent.timestamp,
});

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
  const detector = useMemo(() => createDoubleTapDetector(), [onDoubleTap]);
  // Touches reach these handlers only when no inner link, image or control claimed them,
  // so inner taps stay immediate and never count toward a double tap.
  const release = (event: GestureResponderEvent) => {
    if (detector.end(tapPoint(event))) onDoubleTap?.();
  };
  if (Platform.OS !== "ios") {
    return (
      <Pressable
        accessible={false}
        onLongPress={onLongPress}
        onPressIn={onDoubleTap ? (event) => detector.start(tapPoint(event)) : undefined}
        // A touch that slides is not a tap, so movement and cancellation end it here
        // as they do in the iOS responder below.
        onTouchMove={onDoubleTap ? (event) => detector.move(tapPoint(event)) : undefined}
        onTouchCancel={onDoubleTap ? () => detector.cancel() : undefined}
        onPress={onDoubleTap ? release : undefined}
        style={{ maxWidth: "100%", width: fullWidth ? maxWidth : undefined, flexShrink: 1 }}
      >
        {children}
      </Pressable>
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
      <View
        style={{ maxWidth, width: fullWidth ? maxWidth : undefined, flexShrink: 1 }}
        onStartShouldSetResponder={() => Boolean(onDoubleTap)}
        onResponderGrant={(event) => detector.start(tapPoint(event))}
        onResponderMove={(event) => detector.move(tapPoint(event))}
        onResponderRelease={release}
        onResponderTerminationRequest={() => true}
        onResponderTerminate={() => detector.cancel()}
      >
        {children}
      </View>
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
