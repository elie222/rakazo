import {
  Button,
  ContextMenu,
  Divider,
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
  onTapGesture,
  scrollContentBackground,
  scrollDisabled,
  shapes,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { SNOOZE_PRESETS, snoozePresetTime } from "@rakazo/core";
import type { ReactElement } from "react";
import { useContext, useState } from "react";
import { PlatformColor, useWindowDimensions, View } from "react-native";
import { useI18n } from "../lib/i18n";
import type { InboxRowAction } from "../lib/inbox-swipe";
import { INBOX_ROW_ACTIONS, inboxRowActions, SNOOZE_LABELS } from "../lib/inbox-swipe";
import { native, useResolvedAppearance } from "../lib/native";
import { InboxChatPreview } from "./inbox-chat-preview";
import type { InboxSwipeRowProps } from "./inbox-swipe-row";
import { NativeListRowContext } from "./native-list-row";

// Measured row heights, so recycled and reopened rows start at their size instead of 0.
const rowHeights = new Map<string, number>();
let lastRowHeight = 0;

/**
 * The inbox row inside a one-row SwiftUI list, which is what gives it the system swipe
 * actions, full swipe and haptics, and the system context menu on long press. The FlatList
 * around it keeps scrolling and sections.
 */
export function InboxSwipeRow({
  rowKey,
  unread,
  pinned,
  notifyOnFinish,
  sectionId,
  sections,
  preview,
  onPress,
  onAction,
  onOrganize,
  onEditSection,
  snoozed,
  onSnooze,
  children,
}: InboxSwipeRowProps) {
  const { t } = useI18n();
  const scheme = useResolvedAppearance();
  const window = useWindowDimensions();
  const [width, setWidth] = useState(window.width);
  const [height, setHeight] = useState(() => rowHeights.get(rowKey) ?? lastRowHeight);
  const actions = inboxRowActions({ unread, pinned });
  const nativeRow = useContext(NativeListRowContext);

  function button(action: InboxRowAction, swipe = true) {
    const { label, systemImage } = INBOX_ROW_ACTIONS[action];
    return (
      <Button
        key={action}
        label={t(label)}
        systemImage={systemImage}
        // A swipe button is never given the destructive role, which makes SwiftUI remove the
        // row at the tap even when the request then fails; Archive is red by its tint instead.
        role={!swipe && action === "delete" ? "destructive" : undefined}
        modifiers={
          swipe
            ? [
                labelStyle("iconOnly"),
                ...(action === "read" || action === "unread"
                  ? [tint(PlatformColor("systemBlue"))]
                  : action === "archive"
                    ? [tint(PlatformColor("systemRed"))]
                    : []),
              ]
            : undefined
        }
        onPress={() => onAction(action)}
      />
    );
  }

  function moveTo(id: string | null) {
    if (id !== (sectionId ?? null)) onOrganize({ sectionId: id });
  }

  function swipeRow(rowModifiers: ViewModifier[], content: ReactElement) {
    return (
      <SwipeActions modifiers={rowModifiers}>
        <ContextMenu modifiers={[contentShape(shapes.rectangle())]}>
          <ContextMenu.Trigger>{content}</ContextMenu.Trigger>
          <ContextMenu.Preview>
            <InboxChatPreview {...preview} />
          </ContextMenu.Preview>
          <ContextMenu.Items>
            {button(actions.leading, false)}
            {button(pinned ? "unpin" : "pin", false)}
            {notifyOnFinish === undefined ? null : (
              <Button
                label={notifyOnFinish ? t("Silence notifications") : t("Resume notifications")}
                systemImage={notifyOnFinish ? "bell.slash" : "bell"}
                onPress={() => onOrganize({ notifyOnFinish: !notifyOnFinish })}
              />
            )}
            {!onSnooze ? null : snoozed ? (
              <Button label={t("Unsnooze")} systemImage="moon.zzz" onPress={() => onSnooze(null)} />
            ) : (
              <Menu label={t("Snooze")} systemImage="moon.zzz">
                {SNOOZE_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    label={t(SNOOZE_LABELS[preset])}
                    onPress={() => onSnooze(snoozePresetTime(preset, new Date()).toISOString())}
                  />
                ))}
              </Menu>
            )}
            <Menu label={t("Move to")} systemImage="folder">
              {sections.map((section) => (
                <Toggle
                  key={section.id}
                  label={section.name}
                  isOn={sectionId === section.id}
                  onIsOnChange={() => moveTo(section.id)}
                />
              ))}
              <Toggle
                label={t("Unassigned")}
                isOn={sectionId == null}
                onIsOnChange={() => moveTo(null)}
              />
              <Divider />
              <Button
                label={t("New section")}
                systemImage="folder.badge.plus"
                onPress={() => onEditSection("create")}
              />
              {sections.some((section) => section.id === sectionId) ? (
                <Button
                  label={t("Rename section")}
                  systemImage="pencil"
                  onPress={() => onEditSection("rename")}
                />
              ) : null}
            </Menu>
            {button("archive", false)}
            {button("delete", false)}
          </ContextMenu.Items>
        </ContextMenu>
        <SwipeActions.Actions edge="leading">{button(actions.leading)}</SwipeActions.Actions>
        <SwipeActions.Actions edge="trailing">
          {actions.trailing.map((action) => button(action))}
        </SwipeActions.Actions>
      </SwipeActions>
    );
  }

  // In the native inbox list the row is one of its rows; elsewhere it hosts a one-row list.
  if (nativeRow) {
    return swipeRow(
      onPress ? [...nativeRow.modifiers, onTapGesture(onPress)] : nativeRow.modifiers,
      // The host keeps the size it first measured, so a new width mounts a new one.
      <RNHostView key={nativeRow.width} matchContents>
        <NativeListRowContext.Provider value={null}>
          <View style={{ width: nativeRow.width }} pointerEvents={onPress ? "none" : "auto"}>
            {children}
          </View>
        </NativeListRowContext.Provider>
      </RNHostView>,
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
                {children}
              </View>
            </RNHostView>,
          )}
        </List>
      </Host>
    </View>
  );
}
