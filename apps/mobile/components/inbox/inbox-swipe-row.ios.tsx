import { ContextMenu, Group, Host, List, RNHostView, SwipeActions } from "@expo/ui/swift-ui";
import type { ViewModifier } from "@expo/ui/swift-ui/modifiers";
import {
  contentShape,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listStyle,
  scrollContentBackground,
  scrollDisabled,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactElement } from "react";
import { useContext, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import type { InboxRowAction } from "../../lib/inbox/inbox-swipe";
import { inboxRowActions } from "../../lib/inbox/inbox-swipe";
import { native, useResolvedAppearance } from "../../lib/native/native";
import { iosAtLeast } from "../../lib/native/native-controls";
import { NativeListRowContext } from "../native/native-list-row";
import { NativeRowContent } from "../native/native-row";
import { ChatActionButton, ChatMenuItems } from "./chat-menu-items.ios";
import { InboxChatPreview } from "./inbox-chat-preview";
import { InboxSwipeContent } from "./inbox-swipe-content.ios";
import type { InboxSwipeRowProps } from "./inbox-swipe-row";

// Measured row heights, so recycled and reopened rows start at their size instead of 0.
const rowHeights = new Map<string, number>();
let lastRowHeight = 0;

/**
 * A chat row with a native context menu, hosted in the inbox's SwiftUI list or in its own
 * one-row list when embedded in an activity section.
 */
export function InboxSwipeRow({
  rowKey,
  unread,
  pinned,
  notifyOnFinish,
  sectionId,
  sections,
  preview,
  onAction,
  onOrganize,
  onEditSection,
  snoozed,
  onSnooze,
  children,
}: InboxSwipeRowProps) {
  const scheme = useResolvedAppearance();
  const window = useWindowDimensions();
  const [width, setWidth] = useState(window.width);
  const [height, setHeight] = useState(() => rowHeights.get(rowKey) ?? lastRowHeight);
  const actions = inboxRowActions({ unread, pinned });
  const nativeRow = useContext(NativeListRowContext);
  const interactiveSwipe = iosAtLeast(26);

  const swipeButton = (action: InboxRowAction) => (
    <ChatActionButton
      key={action}
      action={action}
      leading={actions.leading}
      swipe
      onAction={onAction}
    />
  );

  function swipeRow(rowModifiers: ViewModifier[], content: ReactElement) {
    const menu = (
      <ContextMenu modifiers={[contentShape(shapes.rectangle())]}>
        <ContextMenu.Trigger>{content}</ContextMenu.Trigger>
        <ContextMenu.Preview>
          <InboxChatPreview {...preview} />
        </ContextMenu.Preview>
        <ContextMenu.Items>
          <ChatMenuItems
            unread={unread}
            pinned={pinned}
            notifyOnFinish={notifyOnFinish}
            sectionId={sectionId}
            sections={sections}
            onAction={onAction}
            onOrganize={onOrganize}
            onEditSection={onEditSection}
            snoozed={snoozed}
            onSnooze={onSnooze}
          />
        </ContextMenu.Items>
      </ContextMenu>
    );
    if (interactiveSwipe) return <Group modifiers={rowModifiers}>{menu}</Group>;
    return (
      <SwipeActions modifiers={rowModifiers}>
        {menu}
        <SwipeActions.Actions edge="leading">{swipeButton(actions.leading)}</SwipeActions.Actions>
        <SwipeActions.Actions edge="trailing">
          {actions.trailing.map(swipeButton)}
        </SwipeActions.Actions>
      </SwipeActions>
    );
  }

  const swipeContent = interactiveSwipe ? (
    <InboxSwipeContent actions={actions} onAction={onAction}>
      {children}
    </InboxSwipeContent>
  ) : (
    children
  );

  // In the native inbox list the row is one of its rows; elsewhere it hosts a one-row list.
  if (nativeRow) {
    return swipeRow(
      nativeRow.modifiers,
      <NativeRowContent width={nativeRow.width}>{swipeContent}</NativeRowContent>,
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
          {swipeRow(
            [
              listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
              listRowSeparator("hidden"),
              listRowBackground(native.page),
            ],
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
                {swipeContent}
              </View>
            </RNHostView>,
          )}
        </List>
      </Host>
    </View>
  );
}
