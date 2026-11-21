import { useLingui } from "@lingui/react/macro";
import type { Bot, BotSection } from "@rakazo/contracts";
import type { SnoozePreset } from "@rakazo/core";
import { SNOOZE_PRESETS, snoozePresetTime } from "@rakazo/core";
import {
  Archive,
  Bell,
  BellDot,
  Check,
  Clock,
  Copy,
  Eraser,
  Folder,
  FolderPlus,
  Pencil,
  Pin,
  Trash2,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

const PRESET_DAYS: ReadonlySet<SnoozePreset> = new Set(["tomorrow", "nextWeek"]);

type MenuItemProps = {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "default" | "destructive";
};

type MenuSubProps = { children?: ReactNode };

/**
 * The primitives a surface supplies. A right-click menu and the row's "More" button show the
 * same items with different positioning, so the list is written once and the surface is a prop.
 */
export type ChatMenuPrimitives = {
  Item: ComponentType<MenuItemProps>;
  Separator: ComponentType;
  Sub: ComponentType<MenuSubProps>;
  SubTrigger: ComponentType<MenuSubProps>;
  SubContent: ComponentType<MenuSubProps & { className?: string }>;
};

export type ChatMenuProps = {
  bot: Pick<Bot, "name" | "pinned" | "sectionId" | "unread">;
  onClose: () => void;
  onTogglePinned: () => void;
  sections: BotSection[];
  onMoveToSection: (sectionId: string | null) => void;
  onCreateSection: () => void;
  onRenameSection?: (sectionId: string) => void;
  onToggleUnread: () => void;
  /** Snoozed until a time still ahead. */
  snoozed: boolean;
  /** An ISO wake time, or null to unsnooze. */
  onSnooze: (until: string | null) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onClear: () => void;
  onArchive: () => void;
  onDelete: () => void;
};

/** The menu's items, rendered into whichever surface opened it. */
export function ChatMenuItems({
  primitives,
  bot,
  sections,
  onTogglePinned,
  onMoveToSection,
  onCreateSection,
  onRenameSection,
  onToggleUnread,
  snoozed,
  onSnooze,
  onEdit,
  onDuplicate,
  onClear,
  onArchive,
  onDelete,
}: ChatMenuProps & { primitives: ChatMenuPrimitives }) {
  const { t, i18n } = useLingui();
  const { Item, Separator, Sub, SubTrigger, SubContent } = primitives;
  const presetLabels: Record<SnoozePreset, string> = {
    hour: t`1 hour`,
    threeHours: t`3 hours`,
    tomorrow: t`Tomorrow`,
    nextWeek: t`Next week`,
  };
  const now = new Date();

  return (
    <>
      <Item onClick={onTogglePinned}>
        <Pin />
        {bot.pinned ? t`Unpin` : t`Pin`}
      </Item>
      <Sub>
        <SubTrigger>
          <Folder />
          {t`Move to`}
        </SubTrigger>
        <SubContent className="max-h-[min(420px,calc(100vh-16px))] min-w-[180px] overflow-y-auto">
          {sections.map((section) => (
            <Item key={section.id} onClick={() => onMoveToSection(section.id)}>
              <Folder />
              <span dir="auto">{section.name}</span>
              {bot.sectionId === section.id ? <Check className="ms-auto" /> : null}
            </Item>
          ))}
          <Item onClick={() => onMoveToSection(null)}>
            <Folder />
            {t`Unassigned`}
            {bot.sectionId === null ? <Check className="ms-auto" /> : null}
          </Item>
          <Separator />
          <Item onClick={onCreateSection}>
            <FolderPlus />
            {t`New section`}
          </Item>
          {bot.sectionId && onRenameSection ? (
            <Item onClick={() => onRenameSection(bot.sectionId!)}>
              <Pencil />
              {t`Rename section`}
            </Item>
          ) : null}
        </SubContent>
      </Sub>
      <Item onClick={onToggleUnread}>
        {bot.unread ? <BellDot /> : <Bell />}
        {bot.unread ? t`Mark as Read` : t`Mark as Unread`}
      </Item>
      {snoozed ? (
        <Item onClick={() => onSnooze(null)}>
          <Clock />
          {t`Unsnooze`}
        </Item>
      ) : (
        <Sub>
          <SubTrigger>
            <Clock />
            {t`Snooze`}
          </SubTrigger>
          <SubContent className="min-w-[200px]">
            {SNOOZE_PRESETS.map((preset) => {
              const wake = snoozePresetTime(preset, now);
              return (
                <Item
                  key={preset}
                  // From the click, so a menu left open still snoozes from now.
                  onClick={() => onSnooze(snoozePresetTime(preset, new Date()).toISOString())}
                >
                  {presetLabels[preset]}
                  {PRESET_DAYS.has(preset) ? (
                    <span className="ms-auto text-label text-muted-foreground">
                      {i18n.date(wake, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                    </span>
                  ) : null}
                </Item>
              );
            })}
          </SubContent>
        </Sub>
      )}
      <Separator />
      <Item onClick={onEdit}>
        <Pencil />
        {t`Edit Profile`}
      </Item>
      <Item onClick={onDuplicate}>
        <Copy />
        {t`Duplicate`}
      </Item>
      <Separator />
      <Item onClick={onClear}>
        <Eraser />
        {t`Clear conversation`}
      </Item>
      <Item onClick={onArchive}>
        <Archive />
        {t`Archive`}
      </Item>
      <Item variant="destructive" onClick={onDelete}>
        <Trash2 />
        {t`Delete`}
      </Item>
    </>
  );
}
