import { Button, Host, List, RNHostView, SwipeActions } from "@expo/ui/swift-ui";
import {
  labelStyle,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listStyle,
  scrollContentBackground,
  scrollDisabled,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { PlatformColor, useWindowDimensions, View } from "react-native";
import { useI18n } from "../lib/i18n";
import type { InboxRowAction } from "../lib/inbox-swipe";
import { INBOX_ROW_ACTIONS, inboxRowActions } from "../lib/inbox-swipe";
import { native, useResolvedAppearance } from "../lib/native";
import type { InboxSwipeRowProps } from "./inbox-swipe-row";

// Measured row heights, so recycled and reopened rows start at their size instead of 0.
const rowHeights = new Map<string, number>();
let lastRowHeight = 0;

/**
 * The inbox row inside a one-row SwiftUI list, which is what gives it the system swipe
 * actions, full swipe and haptics. The FlatList around it keeps scrolling and sections.
 */
export function InboxSwipeRow({ rowKey, unread, pinned, onAction, children }: InboxSwipeRowProps) {
  const { t } = useI18n();
  const scheme = useResolvedAppearance();
  const window = useWindowDimensions();
  const [width, setWidth] = useState(window.width);
  const [height, setHeight] = useState(() => rowHeights.get(rowKey) ?? lastRowHeight);
  const actions = inboxRowActions({ unread, pinned });

  function button(action: InboxRowAction) {
    const { label, systemImage } = INBOX_ROW_ACTIONS[action];
    return (
      <Button
        key={action}
        label={t(label)}
        systemImage={systemImage}
        role={action === "archive" ? "destructive" : undefined}
        modifiers={[
          labelStyle("iconOnly"),
          ...(action === "read" || action === "unread" ? [tint(PlatformColor("systemBlue"))] : []),
        ]}
        onPress={() => onAction(action)}
      />
    );
  }

  return (
    <View
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        if (next > 0 && next !== width) setWidth(next);
      }}
    >
      <Host style={{ height }} colorScheme={scheme} ignoreSafeArea="all">
        <List
          modifiers={[listStyle("plain"), scrollDisabled(true), scrollContentBackground("hidden")]}
        >
          <SwipeActions
            modifiers={[
              listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
              listRowSeparator("hidden"),
              listRowBackground(native.page),
            ]}
          >
            <RNHostView matchContents>
              <View
                style={{ width }}
                onLayout={(event) => {
                  const next = Math.ceil(event.nativeEvent.layout.height);
                  if (next <= 0 || next === height) return;
                  rowHeights.set(rowKey, next);
                  lastRowHeight = next;
                  setHeight(next);
                }}
              >
                {children}
              </View>
            </RNHostView>
            <SwipeActions.Actions edge="leading">{button(actions.leading)}</SwipeActions.Actions>
            <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
              {actions.trailing.map(button)}
            </SwipeActions.Actions>
          </SwipeActions>
        </List>
      </Host>
    </View>
  );
}
