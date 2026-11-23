import { Button, ContextMenu, Group, RNHostView } from "@expo/ui/swift-ui";
import { contentShape, disabled, shapes } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { useContext } from "react";
import { View } from "react-native";
import { NativeListRowContext } from "./native-list-row";
import type { NativeRowMenu } from "./native-row";

/**
 * React Native content as the content of a native list row, at the width the list lays the row
 * out at. Rows nested inside it are self-contained again.
 */
export function NativeRowContent({ width, children }: { width?: number; children: ReactNode }) {
  return (
    // The host keeps the size it first measured, so a new width mounts a new one.
    <RNHostView key={width} matchContents>
      <NativeListRowContext.Provider value={null}>
        <View style={{ width }}>{children}</View>
      </NativeListRowContext.Provider>
    </RNHostView>
  );
}

/**
 * A row of the native list it renders in, with the system context menu on long press when it
 * has a menu. Outside a native list it is its content alone.
 */
export function NativeRow({ menu, children }: { menu?: NativeRowMenu; children: ReactNode }) {
  const row = useContext(NativeListRowContext);
  if (!row) return <>{children}</>;
  const content = <NativeRowContent width={row.width}>{children}</NativeRowContent>;
  if (!menu) return <Group modifiers={row.modifiers}>{content}</Group>;
  return (
    <ContextMenu modifiers={[...row.modifiers, contentShape(shapes.rectangle())]}>
      <ContextMenu.Trigger>{content}</ContextMenu.Trigger>
      <ContextMenu.Items>
        {menu.actions.map((action) => (
          <Button
            key={action.id}
            label={action.title}
            systemImage={action.image}
            role={action.destructive ? "destructive" : undefined}
            modifiers={action.disabled ? [disabled(true)] : undefined}
            onPress={() => menu.onAction(action.id)}
          />
        ))}
      </ContextMenu.Items>
    </ContextMenu>
  );
}
