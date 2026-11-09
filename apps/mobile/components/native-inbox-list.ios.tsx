import { Group, Rectangle } from "@expo/ui/swift-ui";
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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { findNodeHandle, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AvatarViewport } from "../lib/avatar-life";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { native } from "../lib/native";
import { canScrollNativeList, scrollNativeListToRow } from "../lib/native-list-scroll";
import type { InboxSignal } from "../lib/offscreen-unreads";
import { offscreenUnreads } from "../lib/offscreen-unreads";
import type { NativeInboxListProps } from "./native-inbox-list";
import { NativeInsetList } from "./native-inset-list";
import { NativeListRowContext } from "./native-list-row";
import { NativeRow } from "./native-row";
import { UnreadJumpOverlay } from "./unread-jump-overlay";

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

// Keys of the rows around the chats, which say which end of the list is on screen.
const HEADER_KEY = "header";
const FOOTER_KEY = "footer";

/**
 * Pills for unread rows out of view, from the rows the list reports on screen. Its own component,
 * so rows coming and going redraw the pills and not the list.
 */
function NativeJumpPills({
  keys,
  signals,
  viewport,
  topInset,
  bottomInset,
  onJump,
}: {
  keys: readonly string[];
  signals: readonly InboxSignal[];
  viewport: AvatarViewport;
  topInset: number;
  bottomInset: number;
  onJump: (index: number) => void;
}) {
  const visible = useSyncExternalStore(viewport.subscribe, () => {
    const shown = keys.flatMap((key, index) => (viewport.has(key) ? [index] : []));
    if (shown.length > 0) return `${shown[0]}:${shown[shown.length - 1]}`;
    // No chat on screen: an empty range at the edge in view, so every chat counts above or below.
    if (viewport.has(HEADER_KEY)) return "0:-1";
    if (viewport.has(FOOTER_KEY)) return `${keys.length}:${keys.length - 1}`;
    return "";
  });
  const pills = useMemo(() => {
    if (!visible) return {};
    const [first = 0, last = 0] = visible.split(":").map(Number);
    return offscreenUnreads(signals, { first, last });
  }, [signals, visible]);
  // The first pills fade in only once the list has shown rows, as with the FlatList inbox.
  const shown = useRef(false);
  useEffect(() => {
    if (visible) shown.current = true;
  }, [visible]);
  return (
    <UnreadJumpOverlay
      pills={pills}
      topInset={topInset}
      bottomInset={bottomInset}
      animateEntering={shown.current}
      onJump={(_direction, pill) => onJump(pill.index)}
    />
  );
}

/**
 * The iOS inbox as one SwiftUI list: system scrolling, pull to refresh, and each chat row's swipe
 * actions and context menu as rows of this list. Row content stays the shared React Native rows.
 */
export function NativeInboxList<Item>({
  data,
  keyExtractor,
  renderItem,
  isNativeRow,
  header,
  empty,
  footer,
  gutters,
  column,
  avatarViewport,
  onRefresh,
  signals,
  showJumpPills,
}: NativeInboxListProps<Item>) {
  const hostRef = useRef(null);
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
  const rowContext = (key: string) => ({ modifiers: rowModifiers(key), width: rowWidth });
  // Content around the rows (the activity strip, errors, the end of the list): hosted as is.
  const hosted = (key: string, content: ReactNode) => (
    <NativeListRowContext.Provider key={key} value={rowContext(key)}>
      <NativeRow>{content}</NativeRow>
    </NativeListRowContext.Provider>
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
  const showEmpty = data.length === 0 && Boolean(empty);
  // The list's rows in order, as its collection view numbers them: spacer, header, empty, items.
  const firstItemRow = (headerInset > 0 ? 1 : 0) + (header ? 1 : 0) + (showEmpty ? 1 : 0);
  const list = (
    <NativeInsetList
      hostRef={hostRef}
      variant="plain"
      background={native.page}
      modifiers={[scrollContentBackground("hidden"), refreshable(onRefresh)]}
    >
      {spacer("top", headerInset)}
      {/* Rows wait for the measured width: one laid out before it keeps its first size. */}
      {rowWidth === undefined ? null : (
        <>
          {header ? hosted(HEADER_KEY, header) : null}
          {showEmpty ? hosted("empty", empty) : null}
          {data.map((item) => {
            const key = keyExtractor(item);
            return isNativeRow(item) ? (
              <NativeListRowContext.Provider key={key} value={rowContext(key)}>
                {renderItem({ item })}
              </NativeListRowContext.Provider>
            ) : (
              hosted(key, renderItem({ item }))
            );
          })}
          {footer ? hosted(FOOTER_KEY, footer) : null}
        </>
      )}
      {spacer(
        "bottom",
        headerInset > 0 ? bottom + 32 : 32,
        onGeometryChange(({ width }) => {
          if (width > 0) setRowWidth((current) => (current === width ? current : width));
        }),
      )}
    </NativeInsetList>
  );
  // The list keeps its place in the tree whether or not the pills show, so hiding them (as a
  // refresh does) never rebuilds the native list.
  return (
    <View style={{ flex: 1 }}>
      {list}
      {showJumpPills && canScrollNativeList ? (
        // Centred over the inbox column.
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: column.left,
            right: column.right,
          }}
        >
          <NativeJumpPills
            keys={data.map(keyExtractor)}
            signals={signals}
            viewport={avatarViewport}
            topInset={headerInset}
            bottomInset={bottom}
            onJump={(index) =>
              void scrollNativeListToRow(findNodeHandle(hostRef.current), firstItemRow + index)
            }
          />
        </View>
      ) : null}
    </View>
  );
}
