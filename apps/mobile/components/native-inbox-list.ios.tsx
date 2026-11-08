import { Group, Rectangle, RNHostView } from "@expo/ui/swift-ui";
import type { ViewModifier } from "@expo/ui/swift-ui/modifiers";
import {
  foregroundStyle,
  frame,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  onAppear,
  onDisappear,
  onGeometryChange,
  refreshable,
  scrollContentBackground,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AvatarViewport } from "../lib/avatar-life";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { native } from "../lib/native";
import type { NativeInboxListProps } from "./native-inbox-list";
import { NativeInsetList } from "./native-inset-list";
import { NativeListRowContext } from "./native-list-row";

/** Rows scrolled out of view freeze their avatars, as the list's visible rows tell it. */
function useVisibleRows(viewport: AvatarViewport) {
  const [visible] = useState(() => new Set<string>());
  return (key: string): ViewModifier[] => [
    onAppear(() => {
      visible.add(key);
      viewport.update(visible);
    }),
    onDisappear(() => {
      visible.delete(key);
      viewport.update(visible);
    }),
  ];
}

/**
 * The iOS inbox as one SwiftUI list: system scrolling, pull to refresh, and each chat row's swipe
 * actions and context menu as rows of this list. Row content stays the shared React Native rows.
 */
export function NativeInboxList<Item>({
  data,
  keyExtractor,
  renderItem,
  isSwipeRow,
  header,
  empty,
  footer,
  gutters,
  avatarViewport,
  onRefresh,
}: NativeInboxListProps<Item>) {
  const headerInset = useFloatingHeaderInset();
  const { bottom } = useSafeAreaInsets();
  const visibility = useVisibleRows(avatarViewport);
  // Hosted content sizes its row, so it is given the width the list gives a row: the width of
  // the last spacer, which fills its row.
  const [rowWidth, setRowWidth] = useState<number>();
  const rowInsets = listRowInsets({
    top: 0,
    leading: gutters.left,
    bottom: 0,
    trailing: gutters.right,
  });
  const rowModifiers = (key: string): ViewModifier[] => [
    rowInsets,
    listRowSeparator("hidden"),
    listRowBackground(native.page),
    ...visibility(key),
  ];
  // Content that is not a chat row (headings, pinned tiles, the activity strip): hosted as is.
  const hosted = (key: string, content: ReactNode) => (
    <Group key={key} modifiers={rowModifiers(key)}>
      {/* The host keeps the size it first measured, so a new width mounts a new one. */}
      <RNHostView key={rowWidth} matchContents>
        <View style={{ width: rowWidth }}>{content}</View>
      </RNHostView>
    </Group>
  );
  // Under the floating header the list ignores the top and bottom safe area, so it adds both.
  const spacer = (key: string, height: number, measure?: ViewModifier) =>
    height > 0 ? (
      <Group
        key={key}
        modifiers={[rowInsets, listRowSeparator("hidden"), listRowBackground(native.page)]}
      >
        <Rectangle
          modifiers={[
            foregroundStyle(native.page),
            frame({ height }),
            ...(measure ? [measure] : []),
          ]}
        />
      </Group>
    ) : null;
  return (
    <NativeInsetList
      variant="plain"
      background={native.page}
      modifiers={[scrollContentBackground("hidden"), refreshable(onRefresh)]}
    >
      {spacer("top", headerInset)}
      {header ? hosted("header", header) : null}
      {data.length === 0 && empty ? hosted("empty", empty) : null}
      {data.map((item) => {
        const key = keyExtractor(item);
        return isSwipeRow(item) ? (
          <NativeListRowContext.Provider
            key={key}
            value={{ modifiers: rowModifiers(key), width: rowWidth }}
          >
            {renderItem({ item })}
          </NativeListRowContext.Provider>
        ) : (
          hosted(key, renderItem({ item }))
        );
      })}
      {footer ? hosted("footer", footer) : null}
      {spacer(
        "bottom",
        headerInset > 0 ? bottom + 32 : 32,
        onGeometryChange(({ width }) => {
          if (width > 0) setRowWidth((current) => (current === width ? current : width));
        }),
      )}
    </NativeInsetList>
  );
}
