import type { MenuComponentProps, MenuComponentRef } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { ReactNode } from "react";
import { useRef } from "react";
import { Platform } from "react-native";

type LongPressMenuProps = Omit<MenuComponentProps, "children" | "shouldOpenOnLongPress"> & {
  /** Pass `onLongPress` to the row's own pressable. */
  children: (onLongPress: (() => void) | undefined) => ReactNode;
};

/**
 * A row menu that opens on long press. On Android the menu listens through a wrapping
 * Pressable, which never sees touches a pressable row claims first, so the row opens it.
 * iOS attaches a native context menu and needs no handler.
 */
export function LongPressMenu({ children, ...props }: LongPressMenuProps) {
  const menu = useRef<MenuComponentRef>(null);
  const onLongPress = Platform.OS === "android" ? () => menu.current?.show() : undefined;
  return (
    <MenuView ref={menu} shouldOpenOnLongPress {...props}>
      {children(onLongPress)}
    </MenuView>
  );
}
