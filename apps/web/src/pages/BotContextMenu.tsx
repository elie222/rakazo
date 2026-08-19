import type { Bot } from "@rakazo/contracts";
import { type ReactNode, type Ref, useEffect, useRef } from "react";

export type ContextMenuPosition = { x: number; y: number };

export function BotContextMenu({
  bot,
  position,
  onClose,
  onTogglePinned,
  onToggleUnread,
  onEdit,
  onDuplicate,
  onClear,
  onArchive,
  onDelete,
}: {
  bot: Bot;
  position: ContextMenuPosition;
  onClose: () => void;
  onTogglePinned: () => void;
  onToggleUnread: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onClear: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const firstItem = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstItem.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const menuWidth = 264;
  const menuHeight = 340;
  const margin = 8;
  const left = Math.min(position.x, window.innerWidth - menuWidth - margin);
  const top = Math.min(position.y, window.innerHeight - menuHeight - margin);

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="Close bot menu"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        aria-label={`Actions for ${bot.name}`}
        className="fixed w-[264px] rounded-[18px] border border-[#343438] bg-[#1A1A1D] p-2 shadow-[0_24px_60px_rgba(0,0,0,.62)]"
        style={{ left: Math.max(margin, left), top: Math.max(margin, top) }}
      >
        <MenuItem
          buttonRef={firstItem}
          icon={<PinIcon />}
          label={bot.pinned ? "Unpin" : "Pin"}
          onSelect={onTogglePinned}
        />
        <MenuItem
          icon={<ReadStatusIcon unread={bot.unread} />}
          label={bot.unread ? "Mark as Read" : "Mark as Unread"}
          onSelect={onToggleUnread}
        />
        <div className="my-1 border-t border-[#343438]" />
        <MenuItem icon={<EditIcon />} label="Edit Profile" onSelect={onEdit} />
        <MenuItem icon={<DuplicateIcon />} label="Duplicate" onSelect={onDuplicate} />
        <div className="my-1 border-t border-[#343438]" />
        <MenuItem icon={<ClearIcon />} label="Clear conversation" onSelect={onClear} />
        <MenuItem icon={<ArchiveIcon />} label="Archive" onSelect={onArchive} />
        <MenuItem icon={<TrashIcon />} label="Delete" tone="danger" onSelect={onDelete} />
      </div>
    </div>
  );
}

function MenuItem({
  buttonRef,
  icon,
  label,
  tone = "default",
  onSelect,
}: {
  buttonRef?: Ref<HTMLButtonElement>;
  icon: ReactNode;
  label: string;
  tone?: "default" | "danger";
  onSelect: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 text-left text-[15px] outline-none hover:bg-[#29292D] focus-visible:bg-[#29292D] ${
        tone === "danger" ? "text-[#FF5364]" : "text-[#ECECEE]"
      }`}
      onClick={onSelect}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center">{icon}</span>
      <span>{label}</span>
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
