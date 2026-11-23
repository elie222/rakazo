import {
  Button,
  ContextMenu,
  Divider,
  Group,
  Host,
  List,
  Menu,
  RNHostView,
  SwipeActions,
  Toggle,
} from "@expo/ui/swift-ui";
import type { ViewModifier } from "@expo/ui/swift-ui/modifiers";
import {
  contentShape,
  labelStyle,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listStyle,
  scrollContentBackground,
  scrollDisabled,
  shapes,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useLingui } from "@lingui/react/macro";
import { SNOOZE_PRESETS, snoozePresetTime } from "@rakazo/core";
import type { ReactElement } from "react";
import { useContext, useState } from "react";
import { PlatformColor, useWindowDimensions, View } from "react-native";
import type { InboxRowAction } from "../../lib/inbox/inbox-swipe";
import { INBOX_ROW_ACTIONS, inboxRowActions, SNOOZE_LABELS } from "../../lib/inbox/inbox-swipe";
import { native, useResolvedAppearance } from "../../lib/native/native";
import { iosAtLeast } from "../../lib/native/native-controls";
import { NativeListRowContext } from "../native/native-list-row";
import { NativeRowContent } from "../native/native-row";
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
  const { t, i18n } = useLingui();
  const scheme = useResolvedAppearance();
  const window = useWindowDimensions();
  const [width, setWidth] = useState(window.width);
  const [height, setHeight] = useState(() => rowHeights.get(rowKey) ?? lastRowHeight);
  const actions = inboxRowActions({ unread, pinned });
  const nativeRow = useContext(NativeListRowContext);
  const interactiveSwipe = iosAtLeast(26);

  function button(action: InboxRowAction, swipe = false) {
    const { label, systemImage } = INBOX_ROW_ACTIONS[action];
    const fill =
      action === "archive" ? "systemRed" : action === actions.leading ? "systemBlue" : null;
    return (
      <Button
        key={action}
        label={i18n._(label)}
        systemImage={systemImage}
        role={!swipe && action === "delete" ? "destructive" : undefined}
        modifiers={
          swipe ? [labelStyle("iconOnly"), ...(fill ? [tint(PlatformColor(fill))] : [])] : undefined
        }
        onPress={() => onAction(action)}
      />
    );
  }

  function moveTo(id: string | null) {
    if (id !== (sectionId ?? null)) onOrganize({ sectionId: id });
  }

  function swipeRow(rowModifiers: ViewModifier[], content: ReactElement) {
    const menu = (
      <ContextMenu modifiers={[contentShape(shapes.rectangle())]}>
        <ContextMenu.Trigger>{content}</ContextMenu.Trigger>
        <ContextMenu.Preview>
          <InboxChatPreview {...preview} />
        </ContextMenu.Preview>
        <ContextMenu.Items>
          {button(actions.leading)}
          {button(pinned ? "unpin" : "pin")}
          {notifyOnFinish === undefined ? null : (
            <Button
              label={notifyOnFinish ? t`Silence notifications` : t`Resume notifications`}
              systemImage={notifyOnFinish ? "bell.slash" : "bell"}
              onPress={() => onOrganize({ notifyOnFinish: !notifyOnFinish })}
            />
          )}
          {!onSnooze ? null : snoozed ? (
            <Button label={t`Unsnooze`} systemImage="moon.zzz" onPress={() => onSnooze(null)} />
          ) : (
            <Menu label={t`Snooze`} systemImage="moon.zzz">
              {SNOOZE_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  label={i18n._(SNOOZE_LABELS[preset])}
                  onPress={() => onSnooze(snoozePresetTime(preset, new Date()).toISOString())}
                />
              ))}
            </Menu>
          )}
          <Menu label={t`Move to`} systemImage="folder">
            {sections.map((section) => (
              <Toggle
                key={section.id}
                label={section.name}
                isOn={sectionId === section.id}
                onIsOnChange={() => moveTo(section.id)}
              />
            ))}
            <Toggle
              label={t`Unassigned`}
              isOn={sectionId == null}
              onIsOnChange={() => moveTo(null)}
            />
            <Divider />
            <Button
              label={t`New section`}
              systemImage="folder.badge.plus"
              onPress={() => onEditSection("create")}
            />
            {sections.some((section) => section.id === sectionId) ? (
              <Button
                label={t`Rename section`}
                systemImage="pencil"
                onPress={() => onEditSection("rename")}
              />
            ) : null}
          </Menu>
          {button("archive")}
          {button("delete")}
        </ContextMenu.Items>
      </ContextMenu>
    );
    if (interactiveSwipe) return <Group modifiers={rowModifiers}>{menu}</Group>;
    return (
      <SwipeActions modifiers={rowModifiers}>
        {menu}
        <SwipeActions.Actions edge="leading">{button(actions.leading, true)}</SwipeActions.Actions>
        <SwipeActions.Actions edge="trailing">
          {actions.trailing.map((action) => button(action, true))}
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
