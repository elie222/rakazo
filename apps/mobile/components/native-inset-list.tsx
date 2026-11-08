import { Host, List, Spacer } from "@expo/ui/swift-ui";
import type { ViewModifier } from "@expo/ui/swift-ui/modifiers";
import {
  frame,
  ignoreSafeArea,
  listRowInsets,
  listSectionMargins,
  listStyle,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import type { ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";

/**
 * A SwiftUI inset grouped list filling a screen under the floating header.
 *
 * The header's height comes from navigation, not from the hosting view's safe area, which can be
 * stale after a text size change and put the first row under the close button and title. So the
 * list ignores the top and bottom safe area and the first section starts with a spacer of the
 * header's height (`useInsetListEdges`), inside the scroll content so rows still scroll under
 * the header. The side safe area stays, so rows keep clear of side bars and the iPhone Duo outer
 * display's status bar.
 */
export function NativeInsetList({
  modifiers = [],
  background,
  seedColor,
  children,
}: {
  modifiers?: ViewModifier[];
  background?: ColorValue;
  seedColor?: ColorValue;
  children: ReactNode;
}) {
  const headerInset = useFloatingHeaderInset();
  const scheme = useResolvedAppearance();
  return (
    <Host
      // Rebuilt when the appearance changes, so no row keeps the other theme's colours.
      key={scheme}
      style={{ flex: 1, backgroundColor: background }}
      colorScheme={scheme}
      seedColor={seedColor}
    >
      <List
        modifiers={[
          listStyle("insetGrouped"),
          ...(headerInset > 0 ? [ignoreSafeArea({ regions: "container", edges: "vertical" })] : []),
          ...modifiers,
        ]}
      >
        {children}
      </List>
    </Host>
  );
}

/**
 * The first section's top (flush on iOS 26, then the floating header's height when there is one)
 * and the last section's footer, which keeps the last row above the home indicator.
 */
export function useInsetListEdges() {
  const headerInset = useFloatingHeaderInset();
  const { bottom } = useSafeAreaInsets();
  return {
    footer: <Spacer modifiers={[frame({ height: bottom })]} />,
    modifiers: iosAtLeast(26) ? [listSectionMargins({ edges: "top", length: 0 })] : undefined,
    header:
      headerInset > 0 ? (
        <Spacer
          modifiers={[
            frame({ height: headerInset }),
            listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
          ]}
        />
      ) : undefined,
  };
}
