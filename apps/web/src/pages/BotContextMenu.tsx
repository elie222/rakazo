import { useLingui } from "@lingui/react/macro";
import type { Bot, BotSection } from "@rakazo/contracts";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";

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
  const firstItem = useRef<HTMLButtonElement>(null);
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false);

  useEffect(() => {
    firstItem.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const menuWidth = 264;
  const menuHeight = 390;
  const margin = 8;
  const left = Math.min(position.x, window.innerWidth - menuWidth - margin);
  const top = Math.min(position.y, window.innerHeight - menuHeight - margin);
  const safeLeft = Math.max(margin, left);
  const safeTop = Math.max(margin, top);
  const sectionLeft =
    safeLeft + menuWidth * 2 + margin <= window.innerWidth
      ? safeLeft + menuWidth + 6
      : safeLeft - menuWidth - 6;

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label={t`Close`}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        aria-label={t`Actions for ${bot.name}`}
        className="fixed w-[264px] rounded-[18px] border border-[#343438] bg-[#1A1A1D] p-2 shadow-[0_24px_60px_rgba(0,0,0,.62)]"
        style={{ left: safeLeft, top: safeTop }}
      >
        <MenuItem
          buttonRef={firstItem}
          icon={<PinIcon />}
          label={bot.pinned ? t`Unpin` : t`Pin`}
          onSelect={onTogglePinned}
        />
        <MenuItem
          icon={<FolderIcon />}
          endIcon={<ChevronIcon />}
          label={t`Move to`}
          expanded={sectionMenuOpen}
          onSelect={() => setSectionMenuOpen((open) => !open)}
        />
        <MenuItem
          icon={<ReadStatusIcon unread={bot.unread} />}
          label={bot.unread ? t`Mark as Read` : t`Mark as Unread`}
          onSelect={onToggleUnread}
        />
        <div className="my-1 border-t border-[#343438]" />
        <MenuItem icon={<EditIcon />} label={t`Edit Profile`} onSelect={onEdit} />
        <MenuItem icon={<DuplicateIcon />} label={t`Duplicate`} onSelect={onDuplicate} />
        <div className="my-1 border-t border-[#343438]" />
        <MenuItem icon={<ClearIcon />} label={t`Clear conversation`} onSelect={onClear} />
        <MenuItem icon={<ArchiveIcon />} label={t`Archive`} onSelect={onArchive} />
        <MenuItem icon={<TrashIcon />} label={t`Delete`} tone="danger" onSelect={onDelete} />
      </div>
      {sectionMenuOpen ? (
        <div
          role="menu"
          aria-label={t`Move ${bot.name} to section`}
          className="fixed max-h-[min(420px,calc(100vh-16px))] w-[264px] overflow-y-auto rounded-[18px] border border-[#343438] bg-[#1A1A1D] p-2 shadow-[0_24px_60px_rgba(0,0,0,.62)]"
          style={{ left: Math.max(margin, sectionLeft), top: safeTop }}
        >
          {sections.map((section) => (
            <MenuItem
              key={section.id}
              icon={<FolderIcon />}
              endIcon={bot.sectionId === section.id ? <CheckIcon /> : null}
              label={section.name}
              onSelect={() => onMoveToSection(section.id)}
            />
          ))}
          <MenuItem
            icon={<FolderIcon />}
            endIcon={bot.sectionId === null ? <CheckIcon /> : null}
            label={t`Unassigned`}
            onSelect={() => onMoveToSection(null)}
          />
          <div className="my-1 border-t border-[#343438]" />
          <MenuItem icon={<NewFolderIcon />} label={t`New section`} onSelect={onCreateSection} />
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  buttonRef,
  icon,
  endIcon,
  label,
  expanded,
  tone = "default",
  onSelect,
}: {
  buttonRef?: Ref<HTMLButtonElement>;
  icon: ReactNode;
  endIcon?: ReactNode;
  label: string;
  expanded?: boolean;
  tone?: "default" | "danger";
  onSelect: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      aria-expanded={expanded}
      className={`flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 text-start text-[15px] outline-none hover:bg-[#29292D] focus-visible:bg-[#29292D] ${
        tone === "danger" ? "text-[#FF5364]" : "text-[#ECECEE]"
      }`}
      onClick={onSelect}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center">{icon}</span>
      <span dir="auto">{label}</span>
      {endIcon ? <span className="ms-auto grid h-5 w-5 place-items-center">{endIcon}</span> : null}
    </button>
  );
}

const iconProps = {
  width: 19,
  height: 19,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function PinIcon() {
  return (
    <svg {...iconProps}>
      <path d="m15 4 5 5-4 2-3 5-2-2-5 5-1-1 5-5-2-2 5-3 2-4Z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 6h7l2 2h9v11H3z" />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 6h7l2 2h9v11H3zM16 11v5m-2.5-2.5h5" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg {...iconProps}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...iconProps}>
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </svg>
  );
}

function ReadStatusIcon({ unread }: { unread: boolean }) {
  return (
    <svg {...iconProps}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      {unread ? <circle cx="18" cy="5" r="3" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}

function DuplicateIcon() {
  return (
    <svg {...iconProps}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 6h18M8 6V4h8v2m-9 0 1 15h8l1-15M10 10v7m4-7v7" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 7h16M4 12h10M4 17h7" />
      <path d="m18 14 2 2-2 2m2-2h-5" />
    </svg>
  );
}
