import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { ReactNode } from "react";
import type { ColorSchemeName, GestureResponderEvent } from "react-native";
import { Platform, Pressable } from "react-native";
import type { MessageMenuEntry, MessageMenuSymbol } from "../lib/message-context-menu";

const symbols = {
  reply: "arrowshape.turn.up.left",
  copy: "doc.on.doc",
  react: "face.smiling",
  quote: "text.quote",
  speak: "speaker.wave.2",
  select: "character.cursor.ibeam",
} as const satisfies Record<MessageMenuSymbol, Extract<NonNullable<MenuAction["image"]>, string>>;

export function MessageContextMenu({
  actions,
  children,
  colorScheme,
  onAction,
  onLongPress,
}: {
  actions: readonly MessageMenuEntry[];
  children: ReactNode;
  colorScheme: ColorSchemeName;
  onAction: (id: string) => void;
  onLongPress?: (event: GestureResponderEvent) => void;
}) {
  if (Platform.OS !== "ios") {
    return (
      <Pressable accessible={false} onLongPress={onLongPress}>
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
    >
      {children}
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
