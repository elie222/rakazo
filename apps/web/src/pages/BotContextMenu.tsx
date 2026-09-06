import { useLingui } from "@lingui/react/macro";
import type { Bot, BotSection } from "@rakazo/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import {
  Archive,
  Bell,
  BellDot,
  Check,
  Copy,
  Eraser,
  Folder,
  FolderPlus,
  Pencil,
  Pin,
  Trash2,
} from "lucide-react";

export type ContextMenuPosition = { x: number; y: number };

type ChatMenuTarget = Pick<Bot, "name" | "pinned" | "sectionId" | "unread">;

export function BotContextMenu({
  bot,
  position,
  onClose,
  onTogglePinned,
  sections,
  onMoveToSection,
  onCreateSection,
  onToggleUnread,
  onEdit,
  onDuplicate,
  onClear,
  onArchive,
  onDelete,
}: {
  bot: ChatMenuTarget;
  position: ContextMenuPosition;
  onClose: () => void;
  onTogglePinned: () => void;
  sections: BotSection[];
  onMoveToSection: (sectionId: string | null) => void;
  onCreateSection: () => void;
  onToggleUnread: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onClear: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useLingui();

  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Invisible anchor at the pointer position; the menu itself carries the accessible name. */}
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed size-0 p-0 opacity-0"
            style={{ left: position.x, top: position.y }}
          />
        }
      />
      <DropdownMenuContent
        aria-label={t`Actions for ${bot.name}`}
        align="start"
        sideOffset={0}
        className="max-h-[min(420px,calc(100vh-16px))] w-[264px] overflow-y-auto"
      >
        <DropdownMenuItem onClick={onTogglePinned}>
          <Pin />
          {bot.pinned ? t`Unpin` : t`Pin`}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Folder />
            {t`Move to`}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[min(420px,calc(100vh-16px))] min-w-[180px] overflow-y-auto">
            {sections.map((section) => (
              <DropdownMenuItem key={section.id} onClick={() => onMoveToSection(section.id)}>
                <Folder />
                <span dir="auto">{section.name}</span>
                {bot.sectionId === section.id ? <Check className="ms-auto" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={() => onMoveToSection(null)}>
              <Folder />
              {t`Unassigned`}
              {bot.sectionId === null ? <Check className="ms-auto" /> : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onCreateSection}>
              <FolderPlus />
              {t`New section`}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={onToggleUnread}>
          {bot.unread ? <BellDot /> : <Bell />}
          {bot.unread ? t`Mark as Read` : t`Mark as Unread`}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onEdit}>
          <Pencil />
          {t`Edit Profile`}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy />
          {t`Duplicate`}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onClear}>
          <Eraser />
          {t`Clear conversation`}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onArchive}>
          <Archive />
          {t`Archive`}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 />
          {t`Delete`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
