import { Button, Divider, Menu, Toggle } from "@expo/ui/swift-ui";
import { labelStyle, tint } from "@expo/ui/swift-ui/modifiers";
import { useLingui } from "@lingui/react/macro";
import { SNOOZE_PRESETS, snoozePresetTime } from "@rakazo/core";
import { PlatformColor } from "react-native";
import type { InboxRowAction } from "../../lib/inbox/inbox-swipe";
import { INBOX_ROW_ACTIONS, inboxRowActions, SNOOZE_LABELS } from "../../lib/inbox/inbox-swipe";
import type { InboxSwipeRowProps } from "./inbox-swipe-row";

export type ChatMenuProps = Omit<InboxSwipeRowProps, "rowKey" | "preview" | "children">;

/** One chat action as a menu item, or as an icon-only swipe button. */
export function ChatActionButton({
  action,
  leading,
  swipe = false,
  onAction,
}: {
  action: InboxRowAction;
  /** The chat's leading swipe action, filled blue as a swipe button. */
  leading: InboxRowAction;
  swipe?: boolean;
  onAction: (action: InboxRowAction) => void;
}) {
  const { i18n } = useLingui();
  const { label, systemImage } = INBOX_ROW_ACTIONS[action];
  const fill = action === "archive" ? "systemRed" : action === leading ? "systemBlue" : null;
  return (
    <Button
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

/** A chat's context menu items, the same for its inbox row and its pinned tile. */
export function ChatMenuItems({
  unread,
  pinned,
  notifyOnFinish,
  sectionId,
  sections,
  onAction,
  onOrganize,
  onEditSection,
  snoozed,
  onSnooze,
}: ChatMenuProps) {
  const { t, i18n } = useLingui();
  const { leading } = inboxRowActions({ unread, pinned });
  const button = (action: InboxRowAction) => (
    <ChatActionButton action={action} leading={leading} onAction={onAction} />
  );
  function moveTo(id: string | null) {
    if (id !== (sectionId ?? null)) onOrganize({ sectionId: id });
  }
  return (
    <>
      {button(leading)}
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
        <Toggle label={t`Unassigned`} isOn={sectionId == null} onIsOnChange={() => moveTo(null)} />
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
    </>
  );
}
